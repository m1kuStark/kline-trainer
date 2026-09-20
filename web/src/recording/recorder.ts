// REC-01 录制状态机：会话生命周期、事件配对、检查点、暂停缺口与串行持久化
// 接口合同见 docs/engineering/recording-contract.md；只依赖 ./types 的纯类型与 ./validation 的载入校验。
import type {
  Action,
  CheckpointInput,
  JsonValue,
  RecorderOptions,
  RecorderStatus,
  RecordingCheckpoint,
  RecordingEvent,
  RecordingEventOutcome,
  RecordingEventPhase,
  RecordingEventSource,
  RecordingFile,
  RecordingStorage,
} from './types'
import { validateRecording } from './validation'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

interface OpenOperation {
  action: Action
  source: RecordingEventSource
}

type EventExtras = Partial<Pick<RecordingEvent, 'params' | 'outcome' | 'result' | 'checkpointId'>>

export class Recorder {
  private readonly storage: RecordingStorage
  private readonly options: RecorderOptions
  private file: RecordingFile | null = null
  private operationalState: 'recording' | 'paused' = 'recording'
  private lastError: string | null = null
  private segmentId = ''
  private openOps = new Map<string, OpenOperation>()
  private anchorWall = 0
  private elapsedOffset = 0
  private lastElapsed = 0
  private dirty = false
  private saveQueued = false
  private saveChain: Promise<void> = Promise.resolve()

  constructor(storage: RecordingStorage, options: RecorderOptions) {
    this.storage = storage
    this.options = options
  }

  getStatus(): RecorderStatus {
    if (!this.file) {
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
      eventCount: this.file.events.length,
      sessionId: this.file.sessionId,
    }
  }

  getFile(): RecordingFile {
    if (!this.file) {
      throw new Error('录制器尚未初始化，没有可读取的会话文件。请先调用 start() 或 restore()。')
    }
    return clone(this.file)
  }

  async start(trainingKey: string | null, initial: CheckpointInput, enabled = true): Promise<void> {
    if (this.file) {
      throw new Error('录制会话已开始，不能重复 start()；如需载入既有会话请使用 restore()。')
    }
    const now = new Date()
    this.file = {
      format: 'trainer-session',
      schemaVersion: 1,
      sessionId: createId(),
      createdAt: now.toISOString(),
      app: clone(this.options.app),
      environment: clone(this.options.environment),
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
    this.operationalState = enabled ? 'recording' : 'paused'
    if (!enabled) this.file.gaps.push({ afterSeq: 0, resumedAtSeq: null })
    this.appendCheckpoint(initial)
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  begin(action: Action, params?: JsonValue, source: RecordingEventSource = 'ui'): string | null {
    this.requireFile()
    if (this.operationalState === 'paused') return null
    const opId = createId()
    this.appendEvent(opId, 'started', action, source, params === undefined ? {} : { params: clone(params) })
    this.openOps.set(opId, { action, source })
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    return opId
  }

  finish(opId: string, outcome: RecordingEventOutcome, result?: JsonValue, checkpoint?: CheckpointInput): void {
    this.requireFile()
    if (this.operationalState === 'paused') {
      throw new Error('录制已暂停，无法完成操作；请先调用 resume()。')
    }
    const open = this.openOps.get(opId)
    if (!open) {
      throw new Error(`操作 ${opId} 不存在或已完成，无法记录 finish。`)
    }
    this.openOps.delete(opId)
    const event = this.appendEvent(
      opId,
      'finished',
      open.action,
      open.source,
      {
        outcome,
        ...(result === undefined ? {} : { result: clone(result) }),
      },
    )
    if (checkpoint) {
      event.checkpointId = this.appendCheckpoint(checkpoint).id
    }
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
  }

  capture(checkpoint: CheckpointInput): void {
    this.requireFile()
    if (this.operationalState === 'paused') return
    this.appendCheckpoint(checkpoint)
    this.scheduleSave()
  }

  async pause(checkpoint: CheckpointInput): Promise<void> {
    this.requireFile()
    if (this.operationalState === 'paused') {
      throw new Error('录制已暂停，不能重复 pause()。')
    }
    for (const [opId, open] of [...this.openOps]) {
      this.openOps.delete(opId)
      this.appendEvent(opId, 'finished', open.action, open.source, { outcome: 'interrupted' })
    }
    const pauseOpId = createId()
    this.appendEvent(pauseOpId, 'started', 'recording.pause', 'system')
    const lastPauseEvent = this.appendEvent(pauseOpId, 'finished', 'recording.pause', 'system', { outcome: 'accepted' })
    const file = this.requireFile()
    file.gaps.push({ afterSeq: lastPauseEvent.seq, resumedAtSeq: null })
    this.appendCheckpoint(checkpoint)
    this.operationalState = 'paused'
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  async resume(checkpoint: CheckpointInput): Promise<void> {
    this.requireFile()
    const file = this.requireFile()
    const openGap = [...file.gaps].reverse().find(gap => gap.resumedAtSeq === null)
    if (!openGap) {
      throw new Error('录制没有未闭合的暂停缺口，不能 resume()。')
    }
    this.segmentId = createId()
    const resumeOpId = createId()
    const started = this.appendEvent(resumeOpId, 'started', 'recording.resume', 'system')
    this.appendEvent(resumeOpId, 'finished', 'recording.resume', 'system', { outcome: 'accepted' })
    openGap.resumedAtSeq = started.seq
    this.appendCheckpoint(checkpoint)
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

  async export(): Promise<RecordingFile> {
    await this.flush()
    return this.getFile()
  }

  async restore(id: string): Promise<void> {
    if (this.file) {
      throw new Error('当前录制器已有会话，不能重复 restore()。')
    }
    let loaded: RecordingFile | null
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
    try {
      validateRecording(loaded)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.fail(`录制会话 ${id} 未通过校验：${reason}`)
      throw new Error(`录制会话 ${id} 未通过校验：${reason}`)
    }
    this.file = loaded
    this.patchDanglingOperations()
    // 续录沿用停止时所在 segment（最后一个事件优先，首次无事件用初始 checkpoint），
    // 避免 capture 产出事件中不存在的 segmentId；真正 resume() 才开启新 segment。
    this.segmentId = this.file.events.at(-1)?.segmentId ?? this.file.checkpoints.at(-1)?.segmentId ?? createId()
    this.openOps.clear()
    const maxElapsed = this.file.events.reduce((max, event) => Math.max(max, event.elapsedMs), 0)
    this.anchorWall = Date.now()
    this.elapsedOffset = maxElapsed
    this.lastElapsed = maxElapsed
    this.operationalState = this.file.gaps.some(gap => gap.resumedAtSeq === null) ? 'paused' : 'recording'
    this.lastError = null
    this.refreshComplete()
    this.notify()
    this.scheduleSave()
    await this.flush()
  }

  private requireFile(): RecordingFile {
    if (!this.file) {
      throw new Error('录制器尚未初始化，请先调用 start() 或 restore()。')
    }
    return this.file
  }

  private appendEvent(
    opId: string,
    phase: RecordingEventPhase,
    action: Action,
    source: RecordingEventSource,
    extras: EventExtras = {},
  ): RecordingEvent {
    const file = this.requireFile()
    const event: RecordingEvent = {
      seq: file.events.length + 1,
      opId,
      segmentId: this.segmentId,
      elapsedMs: this.currentElapsed(),
      phase,
      action,
      source,
      ...extras,
    }
    file.events.push(event)
    return event
  }

  private appendCheckpoint(input: CheckpointInput): RecordingCheckpoint {
    const file = this.requireFile()
    const checkpoint: RecordingCheckpoint = {
      id: createId(),
      afterSeq: file.events.length,
      segmentId: this.segmentId,
      capturedAt: new Date().toISOString(),
      training: clone(input.training),
      chart: clone(input.chart),
      ui: clone(input.ui),
      context: clone(input.context),
    }
    file.checkpoints.push(checkpoint)
    return checkpoint
  }

  private currentElapsed(): number {
    // start 时 offset=0、anchorWall=起点；restore 时 offset=maxElapsed、anchorWall=恢复时刻，
    // 两种情况均为 offset + (now - anchorWall)，anchorWall 只减一次。
    const elapsed = Math.max(this.lastElapsed, this.elapsedOffset + Date.now() - this.anchorWall)
    this.lastElapsed = elapsed
    return elapsed
  }

  private refreshComplete(): void {
    const file = this.requireFile()
    file.complete = this.openOps.size === 0 && !file.gaps.some(gap => gap.resumedAtSeq === null)
  }

  private patchDanglingOperations(): void {
    const file = this.requireFile()
    const finishedOps = new Set(file.events.filter(event => event.phase === 'finished').map(event => event.opId))
    const dangling = file.events.filter(event => event.phase === 'started' && !finishedOps.has(event.opId))
    for (const started of dangling) {
      const elapsed = file.events.reduce((max, event) => Math.max(max, event.elapsedMs), 0)
      file.events.push({
        seq: file.events.length + 1,
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
    if (!this.dirty || !this.file) return
    this.dirty = false
    const snapshot = clone(this.file)
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
}
