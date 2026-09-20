// REC-01 v2紧凑存储合同：web/src/recording/compactRecorder.ts
// 紧凑录制状态机（docs/engineering/recording-v2-contract.md「录制与持久化迁移」+
// docs/engineering/recording-v2-storage-contract.md）。对外语义沿旧 recorder.ts：
// start/begin/finish/capture/pause/resume/flush/export/restore/getStatus/getFile；
// 内部即时 CompactBuilder.capture，只保留轻量检查点与追加资源，不保留全历史完整图表。
// 所有入口先完整验证并准备输入（循环/非JSON/结构检查），再改动状态/op/gap/序号/builder：
// 输入失败时原状态原样保留、合法重试直接成功（builder 无回滚手段，靠前置校验保证原子）。
// 持久化快照仅复制数组边界与可变 header（gaps/app/environment）；事件/检查点/资源条目
// 创建后不再修改（finish 的 checkpoint 先于事件成形，已持久事件不回填字段）。
// restore 只处理 v2（v1 迁移属接线层）；无自动停录、无容量停止逻辑。
import { CompactBuilder } from './compactCodec'
import type { CompactCheckpoint, CompactRecordingFile } from './compactTypes'
import type { CompactRecordingStorage } from './compactStorage'
import { validateCompactRecording } from './compactValidation'
import {
  assertAccountView,
  assertArray,
  assertBar,
  assertBoolean,
  assertChartView,
  assertDrawing,
  assertEnum,
  assertJson,
  assertNumberOrNull,
  assertRecord,
  assertString,
  assertStringOrNull,
  assertTrade,
  assertTrainingMeta,
  fail,
  isRecord,
  MAX_DRAWINGS,
  TIMEFRAMES,
} from './validation'
import type {
  Action,
  CheckpointInput,
  JsonValue,
  RecorderOptions,
  RecorderStatus,
  RecordingCheckpoint,
  RecordingEvent,
  RecordingEventOutcome,
  RecordingEventSource,
  RecordingFileAppInfo,
  RecordingFileEnvironment,
  RecordingGap,
} from './types'

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 对象键排序的规范化串：仅用于「最近一次 capture」的内容判重，不持久化 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

interface OpenOperation {
  action: Action
  source: RecordingEventSource
}

type EventExtras = Partial<Pick<RecordingEvent, 'params' | 'outcome' | 'result' | 'checkpointId'>>

/** 会话内存态：事件/检查点只追加，gaps 中的缺口对象会被 resume 就地闭合 */
interface RecorderSession {
  sessionId: string
  createdAt: string
  app: RecordingFileAppInfo
  environment: RecordingFileEnvironment
  trainingKey: string | null
  events: RecordingEvent[]
  checkpoints: CompactCheckpoint[]
  gaps: RecordingGap[]
  complete: boolean
}

/** 最近一次 checkpoint 的输入签名：同 afterSeq 且内容完全相同的冗余 capture 可忽略 */
interface CaptureSignature {
  afterSeq: number
  canonical: string
}

export class CompactRecorder {
  private readonly storage: CompactRecordingStorage
  private readonly options: RecorderOptions
  private session: RecorderSession | null = null
  private builder: CompactBuilder | null = null
  private operationalState: 'recording' | 'paused' = 'recording'
  private lastError: string | null = null
  private segmentId = ''
  private openOps = new Map<string, OpenOperation>()
  private anchorWall = 0
  private elapsedOffset = 0
  private lastElapsed = 0
  private lastCapture: CaptureSignature | null = null
  private dirty = false
  private saveQueued = false
  private saveChain: Promise<void> = Promise.resolve()

  constructor(storage: CompactRecordingStorage, options: RecorderOptions) {
    this.storage = storage
    this.options = options
  }

  getStatus(): RecorderStatus {
    if (!this.session) {
      return {
        state: 'error',
        // restore 失败后 lastError 已含真实原因，须优先于笼统的未初始化提示展示
        error: this.lastError ?? '录制器尚未初始化，请先调用 start() 或 restore()。',
        eventCount: 0,
        sessionId: '',
      }
    }
    return {
      state: this.lastError ? 'error' : this.operationalState,
      error: this.lastError,
      eventCount: this.session.events.length,
      sessionId: this.session.sessionId,
    }
  }

  /** Cheap operational state, including when persistence failure overlays the displayed status. */
  isRecording(): boolean { return this.session !== null && this.operationalState === 'recording' }

  /** 完整深拷贝，仅供导出/检查；常规 UI 状态请走 getStatus，不得用 getFile */
  getFile(): CompactRecordingFile {
    this.requireSession()
    return structuredClone(this.snapshot())
  }

  async start(trainingKey: string | null, initial: CheckpointInput, enabled = true): Promise<void> {
    if (this.session) {
      throw new Error('录制会话已开始，不能重复 start()；如需载入既有会话请使用 restore()。')
    }
    // 输入校验与 header 克隆全部先行：任何失败都发生在改动 builder/session 之前，
    // 状态保持未初始化，调用者修正输入后可直接重试 start。
    const safeInitial = toSafeInput(initial)
    const initialCanonical = canonicalJson(safeInitial)
    const app = structuredClone(this.options.app)
    const environment = structuredClone(this.options.environment)
    const now = new Date()
    this.builder = new CompactBuilder()
    this.session = {
      sessionId: createId(),
      createdAt: now.toISOString(),
      app,
      environment,
      trainingKey,
      events: [],
      checkpoints: [],
      gaps: [],
      complete: true,
    }
    this.segmentId = createId()
    this.openOps.clear()
    this.anchorWall = now.getTime()
    this.elapsedOffset = 0
    this.lastElapsed = 0
    this.lastCapture = null
    this.operationalState = enabled ? 'recording' : 'paused'
    if (!enabled) this.requireSession().gaps.push({ afterSeq: 0, resumedAtSeq: null })
    this.appendSafeCheckpoint(safeInitial, initialCanonical, 0)
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  begin(action: Action, params?: JsonValue, source: RecordingEventSource = 'ui'): string | null {
    this.requireSession()
    if (this.operationalState === 'paused') return null
    const opId = createId()
    const extras: EventExtras = params === undefined ? {} : { params: structuredClone(params) as JsonValue }
    this.appendEvent(opId, 'started', action, source, extras)
    this.openOps.set(opId, { action, source })
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    return opId
  }

  finish(opId: string, outcome: RecordingEventOutcome, result?: JsonValue, checkpoint?: CheckpointInput): void {
    this.requireSession()
    if (this.operationalState === 'paused') {
      throw new Error('录制已暂停，无法完成操作；请先调用 resume()。')
    }
    const open = this.openOps.get(opId)
    if (!open) {
      throw new Error(`操作 ${opId} 不存在或已完成，无法记录 finish。`)
    }
    const extras: EventExtras = { outcome }
    if (result !== undefined) extras.result = structuredClone(result) as JsonValue
    // 检查点先于事件完成（builder 消费后即不可变），事件带 checkpointId 一次性成形再追加；
    // toSafeInput 在消耗 builder 序号前完成全部校验，失败时 openOps/事件原样保留，finish 可重试
    if (checkpoint !== undefined) {
      extras.checkpointId = this.appendCheckpoint(checkpoint, this.requireSession().events.length + 1).id
    }
    this.appendEvent(opId, 'finished', open.action, open.source, extras)
    this.openOps.delete(opId)
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
  }

  capture(checkpoint: CheckpointInput): void {
    const session = this.requireSession()
    if (this.operationalState === 'paused') return
    // 输入先转纯 DTO（循环/非 JSON 在此显式失败，不留半初始化状态），再判重后交给 builder
    const safe = toSafeInput(checkpoint)
    const canonical = canonicalJson(safe)
    const afterSeq = session.events.length
    if (this.lastCapture && this.lastCapture.afterSeq === afterSeq && this.lastCapture.canonical === canonical) return
    this.appendSafeCheckpoint(safe, canonical, afterSeq)
    this.scheduleSave()
  }

  async pause(checkpoint: CheckpointInput): Promise<void> {
    this.requireSession()
    if (this.operationalState === 'paused') {
      throw new Error('录制已暂停，不能重复 pause()。')
    }
    // 检查点先验证并准备：失败不得留下已闭合 openOps/已写 pause 事件的半暂停状态，
    // 否则录制仍标记 recording 但操作已被打断，无法重试。
    const safe = toSafeInput(checkpoint)
    const canonical = canonicalJson(safe)
    for (const [opId, open] of [...this.openOps]) {
      this.openOps.delete(opId)
      this.appendEvent(opId, 'finished', open.action, open.source, { outcome: 'interrupted' })
    }
    const pauseOpId = createId()
    this.appendEvent(pauseOpId, 'started', 'recording.pause', 'system')
    const lastPauseEvent = this.appendEvent(pauseOpId, 'finished', 'recording.pause', 'system', { outcome: 'accepted' })
    const session = this.requireSession()
    session.gaps.push({ afterSeq: lastPauseEvent.seq, resumedAtSeq: null })
    this.appendSafeCheckpoint(safe, canonical, session.events.length)
    this.operationalState = 'paused'
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  async resume(checkpoint: CheckpointInput): Promise<void> {
    const session = this.requireSession()
    const openGap = [...session.gaps].reverse().find(gap => gap.resumedAtSeq === null)
    if (!openGap) {
      throw new Error('录制没有未闭合的暂停缺口，不能 resume()。')
    }
    // 检查点先验证并准备：失败不得留下已闭合 gap/已写 resume 事件的半恢复状态，
    // 否则缺口已闭合而状态仍是 paused，之后无法再 resume。
    const safe = toSafeInput(checkpoint)
    const canonical = canonicalJson(safe)
    this.segmentId = createId()
    const resumeOpId = createId()
    const started = this.appendEvent(resumeOpId, 'started', 'recording.resume', 'system')
    this.appendEvent(resumeOpId, 'finished', 'recording.resume', 'system', { outcome: 'accepted' })
    // 就地闭合缺口：已持久快照持有 gaps 的克隆镜像，不受此修改影响
    openGap.resumedAtSeq = started.seq
    this.appendSafeCheckpoint(safe, canonical, session.events.length)
    this.operationalState = 'recording'
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  async flush(): Promise<void> {
    this.enqueueSave()
    await this.saveChain
    if (this.lastError) {
      throw new Error(
        `保存录制会话失败：${this.lastError}。请检查浏览器存储是否可用（隐私模式、配额或磁盘空间），恢复后重试。`,
      )
    }
  }

  /** 先 flush，再对快照做 v2 语义校验；产物可直接交给 gzip 封装/导入 */
  async export(): Promise<CompactRecordingFile> {
    await this.flush()
    return validateCompactRecording(this.getFile())
  }

  async restore(id: string): Promise<void> {
    if (this.session) {
      throw new Error('当前录制器已有会话，不能重复 restore()。')
    }
    let loaded: CompactRecordingFile | null
    try {
      loaded = await this.storage.load(id)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.fail(`读取录制会话 ${id} 失败：${reason}`)
      throw new Error(`读取录制会话 ${id} 失败：${reason}。请确认存储是否可用。`)
    }
    if (!loaded) {
      this.fail(`读取录制会话 ${id} 失败：存储中不存在该会话。`)
      throw new Error(`存储中不存在 ID 为 ${id} 的录制会话，无法恢复。`)
    }
    // 只接受 v2：schemaVersion/引用/时序/资源完整性由 validator 逐项检查
    try {
      validateCompactRecording(loaded)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.fail(`录制会话 ${id} 未通过校验：${reason}`)
      throw new Error(`录制会话 ${id} 未通过校验：${reason}`)
    }
    // builder 从已保存资源与检查点数续接：后续 capture 的去重/链深/firstCheckpoint 与连续会话一致
    this.builder = new CompactBuilder(loaded.resources, loaded.checkpoints.length)
    this.session = {
      sessionId: loaded.sessionId,
      createdAt: loaded.createdAt,
      app: structuredClone(loaded.app),
      environment: structuredClone(loaded.environment),
      trainingKey: loaded.trainingKey,
      events: loaded.events,
      checkpoints: loaded.checkpoints,
      gaps: loaded.gaps.map(gap => ({ ...gap })),
      complete: loaded.complete,
    }
    this.patchDanglingOperations()
    // 续录沿用停止时所在 segment（最后一个事件优先，首次无事件用初始 checkpoint），
    // 避免 capture 产出事件中不存在的 segmentId；真正 resume() 才开启新 segment。
    this.segmentId =
      this.requireSession().events.at(-1)?.segmentId ?? this.requireSession().checkpoints.at(-1)?.segmentId ?? createId()
    this.openOps.clear()
    const maxElapsed = this.requireSession().events.reduce((max, event) => Math.max(max, event.elapsedMs), 0)
    this.anchorWall = Date.now()
    this.elapsedOffset = maxElapsed
    this.lastElapsed = maxElapsed
    this.lastCapture = null
    this.operationalState = this.requireSession().gaps.some(gap => gap.resumedAtSeq === null) ? 'paused' : 'recording'
    this.lastError = null
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  private requireSession(): RecorderSession {
    if (!this.session) {
      throw new Error('录制器尚未初始化，请先调用 start() 或 restore()。')
    }
    return this.session
  }

  private requireBuilder(): CompactBuilder {
    if (!this.builder) {
      throw new Error('录制器尚未初始化，请先调用 start() 或 restore()。')
    }
    return this.builder
  }

  private appendEvent(
    opId: string,
    phase: RecordingEvent['phase'],
    action: Action,
    source: RecordingEventSource,
    extras: EventExtras = {},
  ): RecordingEvent {
    const session = this.requireSession()
    const event: RecordingEvent = {
      seq: session.events.length + 1,
      opId,
      segmentId: this.segmentId,
      elapsedMs: this.currentElapsed(),
      phase,
      action,
      source,
      ...extras,
    }
    session.events.push(event)
    return event
  }

  /** 完整输入校验后追加检查点（finish 路径需显式传 afterSeq=本条 finished 事件的 seq） */
  private appendCheckpoint(input: CheckpointInput, afterSeq?: number): CompactCheckpoint {
    const safe = toSafeInput(input)
    const canonical = canonicalJson(safe)
    return this.appendSafeCheckpoint(safe, canonical, afterSeq ?? this.requireSession().events.length)
  }

  private appendSafeCheckpoint(safe: CheckpointInput, canonical: string, afterSeq: number): CompactCheckpoint {
    const dto: RecordingCheckpoint = {
      id: createId(),
      afterSeq,
      segmentId: this.segmentId,
      capturedAt: new Date().toISOString(),
      training: safe.training,
      chart: safe.chart,
      ui: safe.ui,
      context: safe.context,
    }
    const compact = this.requireBuilder().capture(dto)
    this.requireSession().checkpoints.push(compact)
    this.lastCapture = { afterSeq, canonical }
    return compact
  }

  private currentElapsed(): number {
    // start 时 offset=0、anchorWall=起点；restore 时 offset=maxElapsed、anchorWall=恢复时刻，
    // 两种情况均为 offset + (now - anchorWall)，anchorWall 只减一次。
    const elapsed = Math.max(this.lastElapsed, this.elapsedOffset + Date.now() - this.anchorWall)
    this.lastElapsed = elapsed
    return elapsed
  }

  private refreshComplete(): void {
    const session = this.requireSession()
    session.complete = this.openOps.size === 0 && !session.gaps.some(gap => gap.resumedAtSeq === null)
  }

  private patchDanglingOperations(): void {
    const session = this.requireSession()
    const finishedOps = new Set(session.events.filter(event => event.phase === 'finished').map(event => event.opId))
    const dangling = session.events.filter(event => event.phase === 'started' && !finishedOps.has(event.opId))
    for (const started of dangling) {
      const elapsed = session.events.reduce((max, event) => Math.max(max, event.elapsedMs), 0)
      session.events.push({
        seq: session.events.length + 1,
        opId: started.opId,
        segmentId: started.segmentId,
        elapsedMs: elapsed,
        phase: 'finished',
        action: started.action,
        source: started.source,
        outcome: 'interrupted',
      })
    }
  }

  private fail(message: string): void {
    this.lastError = message
    this.notify()
  }

  private notify(): void {
    try {
      this.options.onChange?.(this.getStatus())
    } catch {
      // onChange 属于展示层回调，其异常不得阻断录制状态机
    }
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveQueued) return
    this.saveQueued = true
    queueMicrotask(() => {
      this.saveQueued = false
      this.enqueueSave()
    })
  }

  private enqueueSave(): void {
    if (!this.dirty || !this.session) return
    this.dirty = false
    // 快照只复制数组边界与可变 header；条目按创建后不可变契约与存储共享引用，
    // 慢保存期间的追加进入后续批次，不污染本批快照。
    const snapshot = this.snapshot()
    const run = this.saveChain.then(() => this.storage.save(snapshot))
    this.saveChain = run.catch(() => {})
    void run.then(
      () => {
        if (this.lastError !== null) {
          this.lastError = null
          this.notify()
        }
      },
      (error: unknown) => {
        this.dirty = true
        this.lastError = error instanceof Error ? error.message : String(error)
        this.notify()
      },
    )
  }

  /**
   * 持久化快照：events/checkpoints 与六张资源表 slice 到当前长度（条目引用共享），
   * 可变 header（gaps/app/environment）结构化克隆——resume 就地补 gap、跨快照元信息
   * 变化不会改写已持久镜像。禁止全文件 structuredClone。
   */
  private snapshot(): CompactRecordingFile {
    const session = this.requireSession()
    const resources = this.requireBuilder().getResources()
    return {
      format: 'trainer-session',
      schemaVersion: 2,
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      app: structuredClone(session.app),
      environment: structuredClone(session.environment),
      trainingKey: session.trainingKey,
      events: session.events.slice(),
      checkpoints: session.checkpoints.slice(),
      gaps: structuredClone(session.gaps),
      complete: session.complete,
      resources: {
        series: resources.series.slice(),
        drawings: resources.drawings.slice(),
        trainingMeta: resources.trainingMeta.slice(),
        accounts: resources.accounts.slice(),
        trades: resources.trades.slice(),
        contexts: resources.contexts.slice(),
      },
    }
  }
}

/** 与 validation.ts 的 assertJson 深度上限对齐（该常量未导出，此处保持 40 一致） */
const MAX_INPUT_DEPTH = 40

/**
 * 循环引用预检：assertJson 遇自引用会无限递归栈溢出，不能依赖它发现循环。
 * 进入子树时记入 WeakSet、离开时撤销——多处共享同一非循环子对象（DAG）不误报，
 * 仅真正的环在此显式失败并指明字段路径。
 */
function assertAcyclic(value: unknown, field: string, seen: WeakSet<object>, depth: number): void {
  if (value === null || typeof value !== 'object') return
  if (depth > MAX_INPUT_DEPTH) fail(field, `嵌套深度超过 ${MAX_INPUT_DEPTH} 层`)
  if (seen.has(value)) {
    fail(field, '存在循环引用，无法无损序列化为 JSON；请检查输入对象的自引用结构')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAcyclic(item, `${field}[${index}]`, seen, depth + 1))
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertAcyclic(item, field ? `${field}.${key}` : key, seen, depth + 1)
    }
  } else {
    fail(field, `仅支持纯 JSON 对象/数组（收到 ${(value as object).constructor?.name ?? '未知对象'}）`)
  }
  seen.delete(value)
}

/**
 * 单检查点输入结构检查：按 v1 语义复用 validation 纯 helper 校验 ui/training/chart。
 * 两个目的：builder.capture 会先消耗检查点序号并可能追加资源（无回滚手段），必须保证它
 * 对通过检查的输入不可能中途抛错；同时把导出校验必然失败的输入（bar 乱序、画线超限等）
 * 拒绝在追加之前。只检查当前这一份输入，不回看文件/历史。合理 null optional 值
 * （training/chart/context 整体为 null、tool/costPrice/trade 可选字段等）保持原语义放行。
 * context 为自由 JsonValue | null，全树 assertJson 已覆盖，无需额外结构约束。
 */
function assertCheckpointInputShape(input: CheckpointInput): void {
  const record = assertRecord(input, 'checkpoint')
  const ui = assertRecord(record.ui, 'checkpoint.ui')
  assertString(ui.theme, 'checkpoint.ui.theme')
  assertStringOrNull(ui.tool, 'checkpoint.ui.tool')
  assertString(ui.magnet, 'checkpoint.ui.magnet')
  assertBoolean(ui.multiSelect, 'checkpoint.ui.multiSelect')
  if (record.training !== null) {
    const training = assertRecord(record.training, 'checkpoint.training')
    assertTrainingMeta(training.training, 'checkpoint.training.training')
    assertAccountView(training.account, 'checkpoint.training.account')
    assertArray(training.trades, 'checkpoint.training.trades').forEach((trade, index) => {
      assertTrade(trade, `checkpoint.training.trades[${index}]`)
    })
  }
  if (record.chart !== null) {
    const chart = assertRecord(record.chart, 'checkpoint.chart')
    const timeframe = assertEnum(chart.timeframe, 'checkpoint.chart.timeframe', TIMEFRAMES)
    const barDates = assertArray(chart.bars, 'checkpoint.chart.bars').map((bar, index) =>
      assertBar(bar, `checkpoint.chart.bars[${index}]`, timeframe),
    )
    barDates.forEach((date, index) => {
      if (index > 0 && date <= (barDates[index - 1] as string)) {
        fail(`checkpoint.chart.bars[${index}].date`, `必须严格按日期递增（前值 ${barDates[index - 1]}，收到 ${date}）`)
      }
    })
    const drawings = assertArray(chart.drawings, 'checkpoint.chart.drawings')
    if (drawings.length > MAX_DRAWINGS) {
      fail('checkpoint.chart.drawings', `画线数量 ${drawings.length} 超过上限 ${MAX_DRAWINGS}`)
    }
    const drawingIds = new Set<string>()
    drawings.forEach((drawing, index) => assertDrawing(drawing, `checkpoint.chart.drawings[${index}]`, drawingIds))
    assertChartView(chart.view, 'checkpoint.chart.view')
    assertNumberOrNull(chart.costPrice, 'checkpoint.chart.costPrice')
  }
}

/**
 * 完整 CheckpointInput 校验并深拷贝为纯 DTO，顺序不可交换：
 * 1) 循环引用预检（assertJson 遇环会栈溢出）；2) assertJson 全树有限/深度/类型检查——
 * JSON.stringify 会把 NaN/Infinity 静默写成 null、丢弃 undefined，必须先显式失败再克隆；
 * 3) 结构检查保证 builder.capture 不可能中途抛错。通过后才 JSON 克隆，
 * caller 的响应式代理/可变对象在此转换并隔离。params/result/app/env 走 structuredClone
 * 不经此 JSON 无损路径，语义不变。
 */
function toSafeInput(input: CheckpointInput): CheckpointInput {
  assertAcyclic(input, 'checkpoint', new WeakSet(), 1)
  assertJson(input, 'checkpoint', 1)
  assertCheckpointInputShape(input)
  return {
    training: cloneJson(input.training),
    chart: cloneJson(input.chart),
    ui: cloneJson(input.ui),
    context: cloneJson(input.context),
  }
}
