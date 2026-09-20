import { computed, onUnmounted, ref } from 'vue'
import { ApiError, fetchRecordingContext, type RecordingContext, type TrainingSnapshot } from '../api'
import { businessEvents, isBusinessAction } from './businessEvents'
import { CompactRecorder } from './compactRecorder'
import { recordingStorage, loadLocalRecording } from './recordingRepository'
import { acquireRecordingLease } from './recordingLease'
import { writeRecordingFile } from './recordingFile'
import type { CompactRecordingFile } from './compactTypes'
import type { Action, ChartCapture, CheckpointInput, JsonValue, RecorderStatus, RecordingEventOutcome, RecordingEventSource } from './types'

export { recordingStorage } from './recordingRepository'
/** Vue objects may contain proxies; serialize only the known public DTOs. */
export function recordingPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('录制状态包含无效数值')
    return item
  })) as T
}
export function downloadRecording(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * 新录制不再落账的口径外动作（用户阶段验收行为5/返修合同REC-02）：主题、工具、视口、周期、
 * 图表加载/保存与创建样板不产生事件；推进、交易、实际图形变更与录制器内部生命周期元事件
 * （pause/resume/interrupted）不受影响。业务计数口径见 businessEvents.ts。
 */
const UNRECORDED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'training.create',
  'chart.load',
  'chart.timeframe',
  'chart.viewport',
  'chart.tool',
  'drawings.save',
  'ui.theme',
])

export function useRecording(options: {
  snapshot: () => TrainingSnapshot
  ui: () => CheckpointInput['ui']
  enabled: boolean
  ready: () => boolean
  readChart: () => ChartCapture | null
  /** 仅兼容旧接线；新录制不再记录创建样板事件，该参数不产生事件 */
  createdParams?: Record<string, string | number>
  /**
   * 训练页可提供的同期 1D 权威行情+当前显示画线（返修合同 DRAW-02/REC-02）。
   * 提供时所有检查点的 chart 只用它；返回 null 表示当期无可靠日线，不得回退当前视图
   * 或旧日线，绝不虚构历史数据。缺省保持原行为（记录当前图表捕获）。
   */
  canonicalChart?: () => ChartCapture | null
}) {
  const status = ref<RecorderStatus>({ state: 'paused', error: null, eventCount: 0, sessionId: '' })
  const ready = ref(false), enabled = ref(options.enabled), error = ref('')
  let recorder: CompactRecorder | null = null, context: RecordingContext | null = null, chart: ChartCapture | null = null
  let releaseLease: (() => void) | null = null
  const notice = ref('')
  let initializing: Promise<void> | null = null, disposed = false, signature = ''
  let initializationInterrupted = false
  let recoveryPreference: boolean | null = null
  const pendingActions = new Map<string, Action>()
  // finishSession 成功后冻结全部录制入口；失败解除冻结允许整段重试
  let sessionEnded = false
  const finalized = ref(false)
  const hasRetainedFile = ref(false)
  let retainedFile: CompactRecordingFile | null = null
  const businessCount = ref(0)
  /** 业务事件计数（完成的买卖与图形/文字变更），不深拷贝资源即可随操作推进 */
  const businessEventCount = computed(() => businessCount.value)
  const trainingKeyOf = (): string => {
    const training = options.snapshot().training
    return `${training.id}.${training.createdAt}`
  }
  const storageKeyFor = (): string => `trainer.recording.${trainingKeyOf()}`
  const chartForCheckpoint = (): ChartCapture | null => {
    if (options.canonicalChart) return options.canonicalChart()
    return options.ready() ? options.readChart() ?? chart : null
  }
  const checkpoint = (): CheckpointInput => recordingPlain({ training: options.snapshot(), chart: chartForCheckpoint(), ui: options.ui(), context: context as unknown as JsonValue })
  const fail = (reason: unknown) => { error.value = reason instanceof Error ? reason.message : String(reason) }
  async function initialize(): Promise<void> {
    if (ready.value || disposed || !chart?.bars.length || !options.ready()) return
    if (initializing) return initializing
    initializing = (async () => {
      try {
        error.value = ''
        const snapshot = options.snapshot()
        // Viewing a finished training is not a new recording session. Reuse its
        // retained file for export only; discarded sessions must stay deleted.
        if (snapshot.training.status !== 'running' && !recorder) {
          const id = sessionStorage.getItem(storageKeyFor())
          retainedFile = id ? await loadLocalRecording(id) : null
          if (disposed) return
          hasRetainedFile.value = retainedFile !== null
          businessCount.value = retainedFile ? businessEvents(retainedFile.events).length : 0
          sessionEnded = true
          finalized.value = true
          enabled.value = false
          ready.value = true
          return
        }
        context = await fetchRecordingContext(snapshot.training.id)
        if (disposed) return
        recorder ??= new CompactRecorder(recordingStorage, {
          app: context.app, environment: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio },
          onChange: value => {
            status.value = value
            if (value.state === 'paused') enabled.value = false
            else if (value.state === 'recording') enabled.value = true
            else if (value.sessionId && recorder) enabled.value = recorder.isRecording()
          },
        })
        const storageKey = storageKeyFor()
        let saved = sessionStorage.getItem(storageKey)
        let initialEnabled = options.enabled
        if (!recorder.getStatus().sessionId) {
          if (saved) {
            const local = await loadLocalRecording(saved)
            if (!local) throw new Error('本场录制已不存在，无法安全续录')
            if (disposed) return
            // 续录基线：既有业务事件数从已落盘文件读取，后续本地追加只在 finish 时累加
            businessCount.value = businessEvents(local.events).length
            releaseLease ??= await acquireRecordingLease(saved)
            if (disposed) { releaseLease?.(); releaseLease = null; return }
            if (!releaseLease) {
              initialEnabled = !local.gaps.some(gap => gap.resumedAtSeq === null)
              saved = null
              notice.value = '另一标签页正在续录，本页已建立独立录制'
            }
          }
          if (saved) {
            await recorder.restore(saved)
            recoveryPreference = recorder.isRecording()
          }
          else {
            // Retain the session pointer even if its first disk write fails; retry the same recorder.
            businessCount.value = 0
            recoveryPreference = initialEnabled
            const starting = recorder.start(trainingKeyOf(), checkpoint(), initialEnabled && !initializationInterrupted)
            sessionStorage.setItem(storageKey, recorder.getStatus().sessionId)
            await starting
          }
        } else await recorder.flush()
        if (!releaseLease) {
          releaseLease = await acquireRecordingLease(recorder.getStatus().sessionId)
          if (!releaseLease) throw new Error('录制会话被其他标签页占用，请重试')
        }
        if (disposed) { releaseLease(); releaseLease = null; return }
        if (initializationInterrupted) {
          if (recorder.isRecording()) await recorder.pause(checkpoint())
          if (recoveryPreference) await recorder.resume(checkpoint())
          initializationInterrupted = false
        }
        sessionStorage.setItem(storageKey, recorder.getStatus().sessionId)
        enabled.value = recorder.isRecording()
        ready.value = true
        // A restored session starts observing the actual current state; no invented past operations.
        if (saved && enabled.value) recorder.capture(checkpoint())
      } catch (reason) { initializationInterrupted = true; fail(reason) }
      finally { initializing = null }
    })()
    await initializing
  }
  function capture(value: ChartCapture): void {
    try {
      if (sessionEnded) return
      chart = recordingPlain(value)
      if (!ready.value) { void initialize(); return }
      if (!ready.value || !options.ready() || !enabled.value) return
      const input = checkpoint()
      const next = JSON.stringify(input)
      if (next === signature) return
      signature = next
      recorder?.capture(input)
    } catch (reason) { fail(reason) }
  }
  function begin(action: Action, params?: unknown, source: RecordingEventSource = 'ui'): string | null {
    if (sessionEnded || !ready.value || !recorder || UNRECORDED_ACTIONS.has(action)) return null
    try {
      const id = recorder.begin(action, params === undefined ? undefined : recordingPlain(params) as JsonValue, source)
      if (id) pendingActions.set(id, action)
      return id
    }
    catch (reason) { fail(reason); return null }
  }
  function finish(opId: string | null, outcome: RecordingEventOutcome, result?: unknown): void {
    if (sessionEnded || !opId || !recorder) return
    const action = pendingActions.get(opId)
    if (!pendingActions.delete(opId)) return
    try {
      recorder.finish(opId, outcome, result === undefined ? undefined : recordingPlain(result) as JsonValue, checkpoint())
      // 与 businessEvents 口径一致：完成的业务动作计一次，cancelled/interrupted 不计
      if (action && isBusinessAction(action) && outcome !== 'cancelled' && outcome !== 'interrupted') {
        businessCount.value += 1
      }
    }
    catch (reason) { fail(reason) }
  }
  function rejected(opId: string | null, reason: unknown): void {
    finish(opId, reason instanceof ApiError && reason.status < 500 ? 'rejected' : 'unknown', { message: reason instanceof Error ? reason.message : String(reason) })
  }
  function operation(value: { action: Action; params?: JsonValue }): void {
    const id = begin(value.action, value.params, 'chart'); finish(id, 'accepted')
  }
  async function toggle(): Promise<void> {
    if (!recorder || !ready.value || sessionEnded) return
    error.value = ''
    try {
      if (enabled.value) { pendingActions.clear(); await recorder.pause(checkpoint()) }
      else await recorder.resume(checkpoint())
    } catch (reason) { fail(reason) }
    finally { enabled.value = recorder.isRecording() }
  }
  async function exportFile(_event?: Event, compressed = true): Promise<void> {
    if (sessionEnded && !retainedFile || !sessionEnded && !recorder) return
    error.value = ''
    try {
      if (!sessionEnded && enabled.value) recorder!.capture(checkpoint())
      const file = sessionEnded ? retainedFile! : await recorder!.export()
      const blob = await writeRecordingFile(file, compressed !== false)
      downloadRecording(blob, `训练录制-${file.sessionId}.trainer-session.json${compressed !== false ? '.gz' : ''}`)
    } catch (reason) { fail(reason) }
  }
  async function flush(): Promise<void> {
    if (sessionEnded) return
    try { await recorder?.flush() } catch (reason) { fail(reason) }
  }
  async function retry(): Promise<void> {
    if (sessionEnded) return
    error.value = ''
    if (!ready.value) await initialize()
    else {
      try {
        // Retry the actual capture too: a successful disk flush cannot repair a malformed chart.
        const current = options.readChart()
        if (current) capture(current)
        await flush()
      } catch (reason) { fail(reason) }
    }
  }
  async function refreshContext(): Promise<void> {
    try { context = await fetchRecordingContext(options.snapshot().training.id) } catch (reason) { fail(reason) }
  }
  /**
   * 结束本场录制（返修合同 REC-02）：冻结新捕获与业务操作，等待在途初始化与持久化批次
   * 完成后二选一——keep=true 保留最终检查点（保存失败保持可见并可整段重试）；
   * keep=false 单事务删除本会话全部落盘数据（最终批次保存失败也继续清除已落盘部分），
   * 并移除本页 session 指针、释放续录锁；成功后 unmount/pagehide flush 不再触碰录制器，
   * 已丢弃会话不会被复活。任一失败解除冻结、暴露错误并抛出，调用方可重试。
   */
  async function finishSession(keep: boolean): Promise<void> {
    if (sessionEnded) return
    if (pendingActions.size) throw new Error('操作尚未完成，请稍后重试保存录像')
    sessionEnded = true
    error.value = ''
    try {
      if (initializing) await initializing.catch(() => {})
      const sessionId = recorder?.getStatus().sessionId ?? ''
      if (keep && (!ready.value || !recorder || !sessionId)) throw new Error('录像尚未准备完成，无法确认保存；请重试或取消保留')
      if (recorder && sessionId) {
        if (keep && enabled.value) recorder.capture(checkpoint())
        try {
          await recorder.flush()
        } catch (reason) {
          if (keep) throw reason
          // 丢弃路径：最终批次保存失败不阻塞清理，此前已落盘批次由 remove 统一删除
        }
        if (keep) retainedFile = await recorder.export()
      }
      if (!keep && sessionId) {
        if (typeof recordingStorage.remove !== 'function') {
          throw new Error('当前存储实现不支持删除录制会话，无法安全丢弃本场录制')
        }
        await recordingStorage.remove(sessionId)
      }
      if (!keep) {
        retainedFile = null
        try { sessionStorage.removeItem(storageKeyFor()) } catch { /* finished training never auto-creates a session */ }
      }
      hasRetainedFile.value = retainedFile !== null
      finalized.value = true
      enabled.value = false
      releaseLease?.()
      releaseLease = null
    } catch (reason) {
      sessionEnded = false
      fail(reason)
      throw reason instanceof Error ? reason : new Error(String(reason))
    }
  }
  const label = computed(() => error.value || status.value.state === 'error' ? '记录失败' : finalized.value ? hasRetainedFile.value ? '录像已保存' : '未保留录像' : !ready.value ? '准备录制' : enabled.value ? '正在记录' : '已暂停记录')
  const release = async () => {
    // finishSession 成功后录制器已定案（丢弃的会话绝不能被 flush 复活）
    if (sessionEnded) { releaseLease?.(); releaseLease = null; return }
    await flush(); releaseLease?.(); releaseLease = null
  }
  const onHide = () => { void release() }
  window.addEventListener('pagehide', onHide)
  onUnmounted(() => { disposed = true; window.removeEventListener('pagehide', onHide); void release() })
  return { status, ready, enabled, error, notice, label, finalized, hasRetainedFile, businessEventCount, capture, initialize, begin, finish, rejected, operation, toggle, exportFile, flush, finishSession, refreshContext, retry, fail }
}
