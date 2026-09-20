import { describe, expect, it, vi } from 'vitest'
import { CompactRecorder } from '../../web/src/recording/compactRecorder'
import { MemoryCompactStorage } from '../../web/src/recording/compactStorage'
import type { CompactRecordingStorage } from '../../web/src/recording/compactStorage'
import { CompactReader } from '../../web/src/recording/compactCodec'
import { validateCompactRecording } from '../../web/src/recording/compactValidation'
import type { CompactRecordingFile } from '../../web/src/recording/compactTypes'
import type {
  Bar,
  CheckpointInput,
  RecorderOptions,
  RecorderStatus,
  RecordingEvent,
} from '../../web/src/recording/types'
import type { Drawing } from '../../web/src/drawingState'
import type { AccountView, Timeframe, TrainingMeta, TrainingSnapshot } from '../../web/src/api'

// REC-V2-RECORDER：紧凑录制状态机测试。手动controlled存储验证真实数据行为：
// 旧16核心语义移植、CompactReader逐步还原相等、同afterSeq冗余capture去重、
// 慢保存期间追加不污染前批快照、restore后续接builder链、500次推进不内嵌全量chart。

function makeBar(index: number): Bar {
  const day = new Date(Date.UTC(2020, 0, 1 + index))
  return {
    date: day.toISOString().slice(0, 10),
    open: 10,
    high: 11,
    low: 9,
    close: 10 + index * 0.1,
    volume: 1000 + index,
    amount: 10500 + index,
  }
}

function barDate(index: number): string {
  return makeBar(index).date
}

function makeTraining(currentDate: string | null): TrainingMeta {
  return {
    id: 1,
    tier: '1Y',
    code: '600000',
    name: '浦发银行',
    market: 'SH',
    startDate: '2020-01-01',
    plannedEnd: '2021-12-31',
    currentDate,
    status: 'running',
    settleDate: null,
    earlySettle: false,
    blind: false,
    adjustMode: 'forward',
    initialCash: 100000,
    createdAt: '2026-09-19T00:00:00.000Z',
  }
}

function makeAccount(): AccountView {
  return { cash: 100000, shares: 0, availableShares: 0, costPrice: null, marketValue: 0, equity: 100000 }
}

function makeChart(barCount: number, drawings: Drawing[] = [], timeframe: Timeframe = '1D') {
  return {
    timeframe,
    bars: Array.from({ length: barCount }, (_, index) => makeBar(index)),
    drawings,
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: null,
  }
}

function makeSegmentDrawing(id: string, value: number): Drawing {
  return { id, name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1, value }, { timestamp: 2, value }] }
}

function makeCheckpointInput(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
  return {
    training: null,
    chart: null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: null,
    ...overrides,
  }
}

/** 训练+图表齐备的完整输入：行情截止与 bars 末日一致（已知截止不引用未来行情） */
function makeFullInput(barCount: number, drawings: Drawing[] = []): CheckpointInput {
  return makeCheckpointInput({
    training: { training: makeTraining(barDate(barCount - 1)), account: makeAccount(), trades: [] },
    chart: makeChart(barCount, drawings),
  })
}

/** context 自引用的坏输入：无损路径必须显式报错，不得静默截断或半提交 */
function makeCircularInput(): CheckpointInput {
  const input = makeCheckpointInput()
  const context: Record<string, unknown> = { label: 'self' }
  context.self = context
  input.context = context as unknown as CheckpointInput['context']
  return input
}

/** chart.drawings=null 的坏输入：结构不完整，builder 中途必抛错且序号/资源无法回滚 */
function makeBadChartInput(): CheckpointInput {
  const input = makeCheckpointInput()
  input.chart = {
    timeframe: '1D',
    bars: [makeBar(0)],
    drawings: null as unknown as Drawing[],
    view: { fromTimestamp: null, toTimestamp: null, barSpace: 8, paneHeights: {} },
    costPrice: null,
  }
  return input
}

/** context 含 NaN/Infinity 的坏输入：JSON.stringify 会静默写成 null，必须在克隆前拒绝 */
function makeNonFiniteContextInput(): CheckpointInput {
  const input = makeCheckpointInput()
  input.context = {
    measuredPrice: Number.NaN,
    quantity: Number.POSITIVE_INFINITY,
    negative: Number.NEGATIVE_INFINITY,
  } as unknown as CheckpointInput['context']
  return input
}

/**
 * 小型controlled存储端口：内部串行、onSave 可观察/延迟每批快照、failWith 注入保存故障、
 * records 公开供损坏注入。提交发生在 onSave 完成之后（结构化克隆边界与生产 IDB 对齐）。
 */
class ControlledCompactStorage implements CompactRecordingStorage {
  readonly records = new Map<string, CompactRecordingFile>()
  readonly observedFiles: CompactRecordingFile[] = []
  onSave: (file: CompactRecordingFile) => void | Promise<void> = () => {}
  loadFailure: Error | null = null
  private saveFailure: Error | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private active = 0
  maxActive = 0

  failWith(error: Error | null): void {
    this.saveFailure = error
  }

  async save(file: CompactRecordingFile): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.saveFailure) throw this.saveFailure
      this.active += 1
      this.maxActive = Math.max(this.maxActive, this.active)
      this.observedFiles.push(file)
      try {
        await this.onSave(file)
      } finally {
        this.active -= 1
      }
      this.records.set(file.sessionId, structuredClone(file))
    })
    this.queue = run.catch(() => {})
    return run
  }

  async load(id: string): Promise<CompactRecordingFile | null> {
    if (this.loadFailure) throw this.loadFailure
    const file = this.records.get(id)
    return file ? structuredClone(file) : null
  }

  async list() {
    return [...this.records.values()]
      .map(file => ({ sessionId: file.sessionId, trainingKey: file.trainingKey, createdAt: file.createdAt, eventCount: file.events.length }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}

function makeRecorder(
  storage: CompactRecordingStorage = new MemoryCompactStorage(),
  overrides: Partial<RecorderOptions> = {},
): { recorder: CompactRecorder; storage: CompactRecordingStorage; statuses: RecorderStatus[] } {
  const statuses: RecorderStatus[] = []
  const recorder = new CompactRecorder(storage, {
    app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    onChange: status => statuses.push(status),
    ...overrides,
  })
  return { recorder, storage, statuses }
}

function assertSeqAndElapsedMonotonic(events: RecordingEvent[]): void {
  expect(events.length).toBeGreaterThan(0)
  events.forEach((event, index) => {
    expect(event.seq).toBe(index + 1)
    if (index > 0) expect(event.elapsedMs).toBeGreaterThanOrEqual(events[index - 1].elapsedMs)
  })
}

function resourceTableLengths(file: CompactRecordingFile): number[] {
  const r = file.resources
  return [r.series.length, r.drawings.length, r.trainingMeta.length, r.accounts.length, r.trades.length, r.contexts.length]
}

function settleMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('CompactRecorder 基本录制', () => {
  it('begin/finish 配对，seq与elapsed单调，params/result深拷贝，checkpointId链接且Reader逐步还原相等', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('train-1', makeCheckpointInput())

    const params = { side: 'buy', shares: 100 }
    const opId = recorder.begin('training.trade', params, 'ui')
    expect(typeof opId).toBe('string')
    expect(recorder.getFile().complete).toBe(false)
    params.side = 'sell'

    const result = { amount: 12345 }
    const chart = makeChart(2)
    recorder.finish(opId!, 'accepted', result, makeCheckpointInput({ chart }))
    result.amount = 0

    const file = recorder.getFile()
    expect(file.format).toBe('trainer-session')
    expect(file.schemaVersion).toBe(2)
    expect(file.trainingKey).toBe('train-1')
    expect(file.events.map(event => [event.seq, event.phase])).toEqual([[1, 'started'], [2, 'finished']])
    const [started, finished] = file.events
    expect(started.action).toBe('training.trade')
    expect(started.params).toEqual({ side: 'buy', shares: 100 })
    expect(finished.opId).toBe(started.opId)
    expect(finished.outcome).toBe('accepted')
    expect(finished.result).toEqual({ amount: 12345 })
    expect(finished.elapsedMs).toBeGreaterThanOrEqual(started.elapsedMs)
    expect(typeof finished.checkpointId).toBe('string')
    expect(file.checkpoints[0].afterSeq).toBe(0)
    const linkedIndex = file.checkpoints.findIndex(checkpoint => checkpoint.id === finished.checkpointId)
    expect(linkedIndex).toBeGreaterThan(0)
    expect(file.checkpoints[linkedIndex!]!.afterSeq).toBe(2)

    // CompactReader 逐步还原：轻量checkpoint还原出完整输入内容
    const reader = new CompactReader(file)
    const restored = reader.checkpointAt(linkedIndex!)
    expect(restored.id).toBe(file.checkpoints[linkedIndex!]!.id)
    expect(restored.chart).toEqual(makeChart(2))
    expect(restored.training).toBeNull()

    // getFile 深拷贝：修改返回值与status副本不影响内部状态
    file.events[0].action = 'ui.theme'
    expect(recorder.getFile().events[0].action).toBe('training.trade')
    const status = recorder.getStatus()
    status.eventCount = 999
    expect(recorder.getStatus().eventCount).toBe(2)
    expect(recorder.getStatus().state).toBe('recording')

    await expect(recorder.start('another', makeCheckpointInput())).rejects.toThrow('不能重复 start')
  })

  it('默认 enabled=true 进入 recording；enabled=false 明确 paused、gap0、begin为null、capture不追加、finish报错', async () => {
    const on = makeRecorder()
    await on.recorder.start('k', makeCheckpointInput())
    expect(on.recorder.getStatus().state).toBe('recording')
    const openOp = on.recorder.begin('ui.theme', undefined, 'ui')
    expect(openOp).not.toBeNull()
    expect(on.recorder.getFile().complete).toBe(false)
    on.recorder.finish(openOp!, 'accepted')
    expect(on.recorder.getFile().complete).toBe(true)
    expect(on.recorder.getFile().events[0]!.params).toBeUndefined()

    const off = makeRecorder()
    await off.recorder.start('k', makeCheckpointInput(), false)
    expect(off.recorder.getStatus().state).toBe('paused')
    expect(off.recorder.begin('ui.theme', undefined, 'ui')).toBeNull()
    expect(() => off.recorder.finish('any', 'accepted')).toThrow('已暂停')
    const file = off.recorder.getFile()
    expect(file.gaps).toEqual([{ afterSeq: 0, resumedAtSeq: null }])
    expect(file.complete).toBe(false)
    const checkpointCount = file.checkpoints.length
    off.recorder.capture(makeCheckpointInput())
    expect(off.recorder.getFile().checkpoints).toHaveLength(checkpointCount)
    // 初始关闭的会话文件通过 v2 语义校验
    expect(() => validateCompactRecording(off.recorder.getFile())).not.toThrow()
  })

  it('capture 保存不可变 checkpoint（纯DTO），afterSeq/segment正确，Reader还原与原输入相等', async () => {
    const { recorder } = makeRecorder()
    await recorder.start(null, makeCheckpointInput())
    const chart = makeChart(2)
    const drawings = [makeSegmentDrawing('dw-a', 5)]
    recorder.capture(makeCheckpointInput({ chart: makeChart(2, drawings) }))
    chart.bars[0]!.close = 999
    chart.view.barSpace = 0
    drawings[0]!.points[0]!.value = -1

    const file = recorder.getFile()
    const checkpoint = file.checkpoints.at(-1)!
    expect(checkpoint.chart).not.toBeNull()
    expect(checkpoint.afterSeq).toBe(file.events.length)
    expect(checkpoint.segmentId).toBe(file.checkpoints[0]!.segmentId)
    expect(Number.isNaN(Date.parse(checkpoint.capturedAt))).toBe(false)
    const reader = new CompactReader(file)
    const restored = reader.checkpointAt(file.checkpoints.length - 1)
    expect(restored.chart).toEqual(makeChart(2, [makeSegmentDrawing('dw-a', 5)]))
  })
})

describe('暂停与恢复', () => {
  it('pause 先闭合进行中操作为 interrupted，恢复开启新segment并闭合gap、完整观察cp经Reader还原', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput())
    const closed = recorder.begin('chart.load', undefined, 'chart')
    recorder.finish(closed!, 'accepted')
    const dangling = recorder.begin('training.trade', { side: 'buy' }, 'ui')
    await recorder.pause(makeCheckpointInput({ ui: { theme: 'light', tool: null, magnet: 'strong', multiSelect: false } }))

    let file = recorder.getFile()
    expect(recorder.getStatus().state).toBe('paused')
    const interrupted = file.events.find(event => event.opId === dangling && event.phase === 'finished')
    expect(interrupted?.outcome).toBe('interrupted')
    expect('result' in (interrupted as RecordingEvent)).toBe(false)
    expect(file.events.filter(event => event.action === 'recording.pause')).toHaveLength(2)
    expect(file.gaps).toHaveLength(1)
    expect(file.gaps[0]!.resumedAtSeq).toBeNull()
    expect(file.complete).toBe(false)
    assertSeqAndElapsedMonotonic(file.events)

    expect(recorder.begin('ui.theme', undefined, 'ui')).toBeNull()
    const checkpointCount = file.checkpoints.length
    recorder.capture(makeCheckpointInput())
    expect(recorder.getFile().checkpoints).toHaveLength(checkpointCount)

    const resumeChart = makeChart(3)
    await recorder.resume(makeCheckpointInput({ chart: resumeChart }))
    file = recorder.getFile()
    expect(recorder.getStatus().state).toBe('recording')
    expect(file.gaps[0]!.resumedAtSeq).not.toBeNull()
    expect(file.gaps[0]!.resumedAtSeq!).toBeLessThanOrEqual(file.events.at(-1)!.seq)
    expect(file.events.filter(event => event.action === 'recording.resume')).toHaveLength(2)
    const segmentAfterResume = file.events.at(-1)!.segmentId
    expect(segmentAfterResume).not.toBe(file.events[0]!.segmentId)
    const resumeCheckpoint = file.checkpoints.at(-1)!
    expect(resumeCheckpoint.segmentId).toBe(segmentAfterResume)
    expect(file.complete).toBe(true)
    assertSeqAndElapsedMonotonic(file.events)
    const reader = new CompactReader(file)
    expect(reader.checkpointAt(file.checkpoints.length - 1).chart).toEqual(resumeChart)

    expect(recorder.begin('ui.theme', undefined, 'ui')).not.toBeNull()
    assertSeqAndElapsedMonotonic(recorder.getFile().events)
    expect(() => validateCompactRecording(recorder.getFile())).not.toThrow()
  })
})

describe('存储串行与故障', () => {
  it('保存严格串行执行，最后一份快照包含全部事件', async () => {
    const storage = new ControlledCompactStorage()
    const snapshots: number[] = []
    let blockCount = 1
    const held: Array<() => void> = []
    storage.onSave = file => {
      snapshots.push(file.events.length)
      if (blockCount > 0) {
        blockCount -= 1
        return new Promise<void>(resolve => held.push(resolve))
      }
      return undefined
    }
    const { recorder } = makeRecorder(storage)

    const startPromise = recorder.start('k', makeCheckpointInput())
    await settleMacrotask()
    expect(snapshots).toEqual([0])

    const opId = recorder.begin('chart.load', undefined, 'chart')
    recorder.finish(opId!, 'accepted')
    await settleMacrotask()
    expect(storage.maxActive).toBe(1)
    expect(snapshots).toEqual([0])

    held[0]()
    await startPromise
    await recorder.flush()
    expect(storage.maxActive).toBe(1)
    expect(snapshots).toEqual([0, 2])
  })

  it('保存失败立即上报error状态，flush/export抛中文可行动错误，恢复后不丢数据', async () => {
    const storage = new MemoryCompactStorage()
    const { recorder, statuses } = makeRecorder(storage)
    storage.failWith(new Error('模拟磁盘故障'))

    await expect(recorder.start('k', makeCheckpointInput())).rejects.toThrow('保存录制会话失败')
    expect(recorder.getStatus().state).toBe('error')
    expect(recorder.getStatus().error).toContain('模拟磁盘故障')
    expect(statuses.at(-1)?.state).toBe('error')

    const opId = recorder.begin('ui.theme', undefined, 'ui')
    recorder.finish(opId!, 'accepted')
    await expect(recorder.flush()).rejects.toThrow('保存录制会话失败')
    await expect(recorder.export()).rejects.toThrow('保存录制会话失败')

    storage.failWith(null)
    await recorder.flush()
    expect(recorder.getStatus().state).toBe('recording')
    expect(recorder.getStatus().error).toBeNull()
    const persisted = await storage.load(recorder.getStatus().sessionId)
    expect(persisted?.events).toHaveLength(2)
    expect(persisted?.checkpoints).toHaveLength(1)
    expect(persisted?.complete).toBe(true)
    expect(persisted?.resources.trainingMeta).toHaveLength(0)
  })

  it('慢保存期间追加不污染前批快照：批一快照事件数不变，批二包含全部', async () => {
    const storage = new ControlledCompactStorage()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let gateArmed = true
    storage.onSave = file => {
      if (gateArmed) {
        gateArmed = false
        return gate
      }
      return undefined
    }
    const { recorder } = makeRecorder(storage)
    const startPromise = recorder.start('k', makeCheckpointInput())
    await settleMacrotask()
    expect(storage.records.size).toBe(0)

    const opId = recorder.begin('chart.load', undefined, 'chart')
    recorder.finish(opId!, 'accepted')
    await settleMacrotask()

    // 前批快照不受慢保存期间追加影响
    expect(storage.observedFiles[0]!.events).toHaveLength(0)
    release()
    await startPromise
    await recorder.flush()

    expect(storage.observedFiles[0]!.events).toHaveLength(0)
    expect(storage.observedFiles[1]!.events).toHaveLength(2)
    expect(storage.observedFiles[0]!.events).not.toBe(storage.observedFiles[1]!.events)
    const persisted = await storage.load(recorder.getStatus().sessionId)
    expect(persisted?.events).toHaveLength(2)
    expect(persisted?.complete).toBe(true)
  })

  it('export 等待持久化完成、通过v2校验并返回深拷贝', async () => {
    const storage = new ControlledCompactStorage()
    let blockCount = 0
    let release: () => void = () => {}
    storage.onSave = () => {
      if (blockCount > 0) {
        blockCount -= 1
        return new Promise<void>(resolve => {
          release = resolve
        })
      }
      return undefined
    }
    const { recorder } = makeRecorder(storage)
    await recorder.start('k', makeCheckpointInput())
    const sessionId = recorder.getStatus().sessionId

    blockCount = 1
    const opId = recorder.begin('chart.load', undefined, 'chart')
    recorder.finish(opId!, 'accepted')
    await settleMacrotask()
    expect((await storage.load(sessionId))?.events).toHaveLength(0)

    const exportedPromise = recorder.export()
    expect((await storage.load(sessionId))?.events).toHaveLength(0)
    release()
    const exported = await exportedPromise
    expect(exported.events).toHaveLength(2)
    expect(() => validateCompactRecording(exported)).not.toThrow()
    const persisted = await storage.load(sessionId)
    expect(persisted).toEqual(exported)

    exported.events.pop()
    exported.gaps.push({ afterSeq: 99, resumedAtSeq: null })
    expect(recorder.getFile().events).toHaveLength(2)
    expect(recorder.getFile().gaps).toHaveLength(0)
    const summaries = await storage.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ sessionId, trainingKey: 'k', eventCount: 2 })
  })
})

describe('restore', () => {
  it('restore 修补悬空 started 为 interrupted，不伪造结果，续录保持单调且segment沿用', async () => {
    const storage = new MemoryCompactStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeCheckpointInput())
    const opId = first.recorder.begin('training.trade', { side: 'buy' }, 'ui')
    await first.recorder.flush()
    const sessionId = first.recorder.getStatus().sessionId

    const second = makeRecorder(storage)
    await second.recorder.restore(sessionId)
    expect(second.recorder.getStatus().sessionId).toBe(sessionId)
    expect(second.recorder.getStatus().state).toBe('recording')
    const restored = second.recorder.getFile()
    expect(restored.trainingKey).toBe('k')
    expect(restored.schemaVersion).toBe(2)
    const patched = restored.events.at(-1)!
    expect(patched.opId).toBe(opId)
    expect(patched.phase).toBe('finished')
    expect(patched.outcome).toBe('interrupted')
    expect(patched.segmentId).toBe(restored.events[0]!.segmentId)
    expect('result' in patched).toBe(false)
    expect(restored.complete).toBe(true)

    const maxElapsedBefore = restored.events.reduce((max, event) => Math.max(max, event.elapsedMs), 0)
    const next = second.recorder.begin('ui.theme', undefined, 'ui')
    second.recorder.finish(next!, 'accepted')
    const events = second.recorder.getFile().events
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))
    expect(events.at(-1)!.elapsedMs).toBeGreaterThanOrEqual(maxElapsedBefore)
  })

  it('restore 保留 paused 状态，需显式 resume 才能继续', async () => {
    const storage = new MemoryCompactStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeCheckpointInput())
    const opId = first.recorder.begin('ui.theme', undefined, 'ui')
    first.recorder.finish(opId!, 'accepted')
    await first.recorder.pause(makeCheckpointInput())
    const sessionId = first.recorder.getStatus().sessionId

    const second = makeRecorder(storage)
    await second.recorder.restore(sessionId)
    expect(second.recorder.getStatus().state).toBe('paused')
    expect(second.recorder.begin('ui.theme', undefined, 'ui')).toBeNull()

    await second.recorder.resume(makeCheckpointInput())
    expect(second.recorder.getStatus().state).toBe('recording')
    expect(second.recorder.getFile().gaps[0]!.resumedAtSeq).not.toBeNull()
    expect(second.recorder.getFile().complete).toBe(true)
    expect(second.recorder.begin('ui.theme', undefined, 'ui')).not.toBeNull()
    expect(() => validateCompactRecording(second.recorder.getFile())).not.toThrow()
  })

  it('restore 失败如实报告，不假成功', async () => {
    const storage = new MemoryCompactStorage()
    const missing = makeRecorder(storage)
    await expect(missing.recorder.restore('no-such-session')).rejects.toThrow('不存在')
    expect(missing.recorder.getStatus().state).toBe('error')
    expect(missing.statuses.at(-1)?.state).toBe('error')

    const broken = new MemoryCompactStorage()
    broken.loadFailure = new Error('存储读取被拒绝')
    const failing = makeRecorder(broken)
    await expect(failing.recorder.restore('any')).rejects.toThrow('存储读取被拒绝')
    expect(failing.recorder.getStatus().state).toBe('error')
  })

  it('restore 后墙钟 +100ms 的事件 elapsed 严格等于基准 +100（anchorWall 只减一次）', async () => {
    const storage = new MemoryCompactStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeCheckpointInput())
    const opId = first.recorder.begin('chart.load', undefined, 'chart')
    first.recorder.finish(opId!, 'accepted')
    await first.recorder.flush()
    const sessionId = first.recorder.getStatus().sessionId
    const persisted = await storage.load(sessionId)
    const maxElapsedBefore = persisted!.events.reduce((max, event) => Math.max(max, event.elapsedMs), 0)

    let mockNow = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)
    try {
      const second = makeRecorder(storage)
      await second.recorder.restore(sessionId)
      mockNow += 100
      const next = second.recorder.begin('ui.theme', undefined, 'ui')
      second.recorder.finish(next!, 'accepted')
      const events = second.recorder.getFile().events
      expect(events.at(-2)!.elapsedMs).toBe(maxElapsedBefore + 100)
      expect(events.at(-1)!.elapsedMs).toBe(maxElapsedBefore + 100)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('restore 沿旧segment续录，builder链续：同内容复用资源版本，新内容追加增量且firstCheckpoint正确', async () => {
    const storage = new MemoryCompactStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeFullInput(3, [makeSegmentDrawing('dw-a', 5)]))
    const closed = first.recorder.begin('chart.load', undefined, 'chart')
    first.recorder.finish(closed!, 'accepted')
    await first.recorder.flush()
    const sessionId = first.recorder.getStatus().sessionId

    const second = makeRecorder(storage)
    await second.recorder.restore(sessionId)
    const restored = second.recorder.getFile()
    const stoppedSegment = restored.events.at(-1)!.segmentId
    expect(restored.checkpoints).toHaveLength(1)
    const headId = restored.resources.series[0]!.id
    const drawingHeadId = restored.resources.drawings[0]!.id

    // 同内容 capture：新checkpoint保留时序，资源版本复用不追加
    second.recorder.capture(makeFullInput(3, [makeSegmentDrawing('dw-a', 5)]))
    let file = second.recorder.getFile()
    expect(file.checkpoints).toHaveLength(2)
    expect(file.checkpoints[1]!.afterSeq).toBe(2)
    expect(file.checkpoints[1]!.segmentId).toBe(stoppedSegment)
    expect(file.checkpoints[1]!.chart!.seriesRef).toBe(headId)
    expect(file.checkpoints[1]!.chart!.drawingsRef).toBe(drawingHeadId)
    expect(file.resources.series).toHaveLength(1)
    expect(file.resources.drawings).toHaveLength(1)

    // 内容变化 capture：追加增量版本，base为链头，firstCheckpoint=新检查点下标
    second.recorder.capture(makeFullInput(4, [makeSegmentDrawing('dw-a', 5)]))
    file = second.recorder.getFile()
    expect(file.resources.series).toHaveLength(2)
    const delta = file.resources.series[1]!
    expect(delta.base).toBe(headId)
    expect(delta.firstCheckpoint).toBe(2)
    expect(file.checkpoints[2]!.chart!.seriesRef).toBe(delta.id)
    expect(file.resources.drawings).toHaveLength(1)

    // finish 带 checkpoint 继续推进链，导出通过v2校验，Reader逐步还原相等
    const opId = second.recorder.begin('training.advance', undefined, 'ui')
    second.recorder.finish(opId!, 'accepted', undefined, makeFullInput(5, [makeSegmentDrawing('dw-a', 6)]))
    const exported = await second.recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    expect(exported.checkpoints).toHaveLength(4)
    expect(exported.checkpoints.at(-1)!.segmentId).toBe(stoppedSegment)

    const reader = new CompactReader(exported)
    const expectedBars = [makeChart(3), makeChart(3), makeChart(4), makeChart(5)]
    expectedBars.forEach((chart, index) => {
      const restoredCheckpoint = reader.checkpointAt(index)
      expect(restoredCheckpoint.chart?.bars).toEqual(chart.bars)
      expect(restoredCheckpoint.training?.training.currentDate).toBe(barDate(chart.bars.length - 1))
    })
    const lastDrawing = reader.checkpointAt(3).chart?.drawings ?? []
    expect(lastDrawing).toEqual([makeSegmentDrawing('dw-a', 6)])
  })

  it('损坏的存量会话被 restore 拒绝并进入 error 状态', async () => {
    const storage = new ControlledCompactStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeCheckpointInput())
    const opId = first.recorder.begin('ui.theme', undefined, 'ui')
    first.recorder.finish(opId!, 'accepted')
    await first.recorder.flush()
    const sessionId = first.recorder.getStatus().sessionId

    const persisted = await storage.load(sessionId)
    persisted!.events[0]!.seq = 9
    storage.records.set(sessionId, persisted!)

    const second = makeRecorder(storage)
    await expect(second.recorder.restore(sessionId)).rejects.toThrow('未通过校验')
    expect(second.recorder.getStatus().state).toBe('error')
    expect(second.statuses.at(-1)?.state).toBe('error')
  })
})

describe('冗余 capture 去重', () => {
  it('同afterSeq同内容capture忽略（资源不增不跳号）；不同seq相同内容保留cp时序', async () => {
    const { recorder } = makeRecorder()
    const inputA = makeFullInput(3, [makeSegmentDrawing('dw-a', 5)])
    await recorder.start('k', inputA)
    let file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(1)
    const lengthsAfterStart = resourceTableLengths(file)

    // 同afterSeq同内容：整体忽略，checkpoint与资源全表不增
    recorder.capture(makeFullInput(3, [makeSegmentDrawing('dw-a', 5)]))
    file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(1)
    expect(resourceTableLengths(file)).toEqual(lengthsAfterStart)

    // 同afterSeq不同内容：正常追加（不因判重吞掉真实变化）
    recorder.capture(makeFullInput(4, [makeSegmentDrawing('dw-a', 5)]))
    file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(2)
    expect(file.checkpoints[1]!.afterSeq).toBe(0)
    expect(file.resources.series.length).toBeGreaterThan(lengthsAfterStart[0]!)

    // 不同seq相同内容：保留checkpoint时序，行情/画线版本复用不增
    const seriesCount = file.resources.series.length
    const drawingsCount = file.resources.drawings.length
    const opId = recorder.begin('ui.theme', undefined, 'ui')
    recorder.finish(opId!, 'accepted')
    recorder.capture(makeFullInput(4, [makeSegmentDrawing('dw-a', 5)]))
    file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(3)
    expect(file.checkpoints[2]!.afterSeq).toBe(2)
    expect(file.checkpoints[2]!.id).not.toBe(file.checkpoints[1]!.id)
    expect(file.resources.series).toHaveLength(seriesCount)
    expect(file.resources.drawings).toHaveLength(drawingsCount)

    // 三个checkpoint经Reader逐步还原，与各自输入相等
    const reader = new CompactReader(file)
    expect(reader.checkpointAt(0).chart?.bars).toEqual(makeChart(3).bars)
    expect(reader.checkpointAt(1).chart?.bars).toEqual(makeChart(4).bars)
    expect(reader.checkpointAt(2).chart?.bars).toEqual(makeChart(4).bars)
    expect(reader.checkpointAt(2).afterSeq).toBe(2)
    expect(() => validateCompactRecording(file)).not.toThrow()
  })
})

describe('输入失败原子性', () => {
  it('start 传循环引用 context：保持未初始化可重试，成功会话经 validate/Reader 还原', async () => {
    const { recorder } = makeRecorder()
    await expect(recorder.start('k', makeCircularInput())).rejects.toThrow('循环引用')
    expect(recorder.getStatus().error).toContain('尚未初始化')

    // 修正输入后干净启动：无残留事件/检查点/资源
    await recorder.start('k', makeCheckpointInput())
    expect(recorder.getStatus().state).toBe('recording')
    const file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(1)
    expect(file.events).toHaveLength(0)
    expect(resourceTableLengths(file)).toEqual([0, 0, 0, 0, 0, 0])
    const opId = recorder.begin('training.advance')
    recorder.finish(opId!, 'accepted')
    const exported = await recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    expect(new CompactReader(exported).checkpointAt(0).context).toBeNull()
  })

  it('start/capture 传 NaN/Infinity context：显式拒绝而非静默转 null，资源不增', async () => {
    const { recorder } = makeRecorder()
    await expect(recorder.start('k', makeNonFiniteContextInput())).rejects.toThrow('有限')
    expect(recorder.getStatus().error).toContain('尚未初始化')

    await recorder.start('k', makeCheckpointInput())
    const before = recorder.getFile()
    expect(() => recorder.capture(makeNonFiniteContextInput())).toThrow('有限')
    expect(recorder.getStatus().state).toBe('recording')
    expect(recorder.getFile()).toEqual(before)

    recorder.capture(makeCheckpointInput({ context: { measuredPrice: 10.5 } }))
    const file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(2)
    expect(new CompactReader(file).checkpointAt(1).context).toEqual({ measuredPrice: 10.5 })
    const exported = await recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    expect(exported.checkpoints).toHaveLength(2)
    expect(new CompactReader(exported).checkpointAt(0).context).toBeNull()
  })

  it('capture 传坏 chart（drawings=null）：失败前后文件深等，builder 序号/资源不消耗，合法 capture 编号不跳', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeFullInput(3, [makeSegmentDrawing('dw-a', 5)]))
    const before = recorder.getFile()
    expect(() => recorder.capture(makeBadChartInput())).toThrow('必须是数组')
    expect(recorder.getStatus().state).toBe('recording')
    expect(recorder.getFile()).toEqual(before)

    // 合法 capture：新行情增量的 firstCheckpoint 精确等于新检查点下标（序号未被失败消耗）
    recorder.capture(makeFullInput(4, [makeSegmentDrawing('dw-a', 5)]))
    const file = recorder.getFile()
    expect(file.checkpoints).toHaveLength(2)
    expect(file.resources.series.map(version => version.id)).toEqual(['s1', 's2'])
    expect(file.resources.series[1]!.base).toBe('s1')
    expect(file.resources.series[1]!.firstCheckpoint).toBe(1)
    expect(file.resources.drawings.map(version => version.id)).toEqual(['dw1'])

    // 导出保留错误前的有效会话（cp0 原样），全部检查点经 Reader 还原正确
    const exported = await recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    expect(exported.checkpoints).toHaveLength(2)
    const reader = new CompactReader(exported)
    expect(reader.checkpointAt(0).chart?.bars).toEqual(makeChart(3).bars)
    expect(reader.checkpointAt(1).chart?.bars).toEqual(makeChart(4).bars)
  })

  it('finish 传坏 checkpoint：openOps/事件原样保留可重试，重试成功且链接正确', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput())
    const opId = recorder.begin('training.advance')
    const before = recorder.getFile()
    expect(() => recorder.finish(opId!, 'accepted', undefined, makeBadChartInput())).toThrow('必须是数组')
    expect(recorder.getFile()).toEqual(before)
    expect(recorder.getFile().complete).toBe(false)

    recorder.finish(opId!, 'accepted', undefined, makeCheckpointInput({ chart: makeChart(2) }))
    const file = recorder.getFile()
    expect(file.events.map(event => event.phase)).toEqual(['started', 'finished'])
    expect(file.events[1]!.checkpointId).toBe(file.checkpoints[1]!.id)
    expect(file.checkpoints[1]!.afterSeq).toBe(2)
    expect(recorder.getFile().complete).toBe(true)
    const exported = await recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    expect(new CompactReader(exported).checkpointAt(1).chart).toEqual(makeChart(2))
  })

  it('pause 传循环引用 context：不闭合 openOps/不写事件/不开 gap，操作与暂停均可重试', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput())
    const opId = recorder.begin('training.trade', { side: 'buy' })
    const before = recorder.getFile()
    await expect(recorder.pause(makeCircularInput())).rejects.toThrow('循环引用')
    expect(recorder.getStatus().state).toBe('recording')
    expect(recorder.getFile()).toEqual(before)

    // 进行中操作未被误闭合：finish 正常完成；随后合法 pause/resume 成功
    recorder.finish(opId!, 'accepted')
    await recorder.pause(makeCheckpointInput())
    expect(recorder.getStatus().state).toBe('paused')
    expect(recorder.getFile().gaps).toEqual([{ afterSeq: 4, resumedAtSeq: null }])
    await recorder.resume(makeCheckpointInput())
    expect(recorder.getStatus().state).toBe('recording')
    const exported = await recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    assertSeqAndElapsedMonotonic(exported.events)
  })

  it('resume 传循环引用 context：gap 保持未闭合仍 paused，修正后可重试 resume', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput())
    await recorder.pause(makeCheckpointInput())
    const before = recorder.getFile()
    await expect(recorder.resume(makeCircularInput())).rejects.toThrow('循环引用')
    expect(recorder.getStatus().state).toBe('paused')
    expect(recorder.getFile()).toEqual(before)
    expect(recorder.begin('ui.theme')).toBeNull()

    await recorder.resume(makeCheckpointInput())
    expect(recorder.getStatus().state).toBe('recording')
    const file = recorder.getFile()
    expect(file.gaps).toHaveLength(1)
    expect(file.gaps[0]!.resumedAtSeq).not.toBeNull()
    expect(recorder.begin('ui.theme')).not.toBeNull()
    const exported = await recorder.export()
    expect(() => validateCompactRecording(exported)).not.toThrow()
    expect(new CompactReader(exported).checkpointAt(2).context).toBeNull()
  })
})

describe('onChange 异常隔离', () => {
  it('onChange 抛异常不破坏录制状态机', async () => {
    let calls = 0
    const storage = new MemoryCompactStorage()
    const recorder = new CompactRecorder(storage, {
      app: { version: '0.0.0-test', gitCommit: 't', dirty: false, chartLibrary: 'klinecharts' },
      environment: { timezone: 'Asia/Shanghai', viewport: { width: 800, height: 600 }, dpr: 1 },
      onChange: () => {
        calls += 1
        throw new Error('观察者异常')
      },
    })
    await recorder.start('k', makeCheckpointInput())
    const opId = recorder.begin('ui.theme')
    recorder.finish(opId!, 'accepted')
    await recorder.flush()
    expect(calls).toBeGreaterThan(0)
    expect(recorder.getStatus().state).toBe('recording')
    expect(recorder.getStatus().eventCount).toBe(2)
    const persisted = await storage.load(recorder.getStatus().sessionId)
    expect(persisted?.events).toHaveLength(2)
  })
})

describe('500 次推进', () => {
  it('文件不内嵌全量chart重复，资源按增量表达，逐cp经Reader还原正确并通过v2校验', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeFullInput(30))
    for (let day = 1; day <= 500; day += 1) {
      const opId = recorder.begin('training.advance', undefined, 'ui')
      recorder.finish(opId!, 'accepted', undefined, makeFullInput(30 + day))
    }
    await recorder.flush()

    const file = recorder.getFile()
    expect(file.events).toHaveLength(1000)
    expect(file.checkpoints).toHaveLength(501)
    expect(file.complete).toBe(true)
    assertSeqAndElapsedMonotonic(file.events)

    // 每个 finished 事件链接的 checkpoint afterSeq 与其 seq 一致
    file.events.forEach((event, index) => {
      if (event.phase !== 'finished' || event.checkpointId === undefined) return
      const linked = file.checkpoints.find(checkpoint => checkpoint.id === event.checkpointId)
      expect(linked).toBeDefined()
      expect(linked!.afterSeq).toBe(index + 1)
    })

    // 资源不内嵌全量chart重复：31层增量上限会周期性存新基础（合同行为），
    // 但总条目必须远小于逐cp平铺全量（501个检查点全量平铺 ≈ 14万条bar）
    const naiveFlatBars = file.checkpoints.reduce((sum, _, index) => sum + 30 + index, 0)
    const totalBarEntries = file.resources.series.reduce(
      (sum, version) => sum + (version.base === null ? version.bars.length : version.upsert.length + version.remove.length),
      0,
    )
    expect(totalBarEntries).toBeGreaterThanOrEqual(500)
    expect(totalBarEntries).toBeLessThan(naiveFlatBars / 10)

    // 逐cp还原：bars 随推进单调增长，训练截止一致
    const reader = new CompactReader(file)
    for (let index = 0; index < file.checkpoints.length; index += 1) {
      const restored = reader.checkpointAt(index)
      const expectedCount = 30 + index
      expect(restored.chart?.bars).toHaveLength(expectedCount)
      expect(restored.chart?.bars[0]).toEqual(makeBar(0))
      expect(restored.chart?.bars.at(-1)).toEqual(makeBar(expectedCount - 1))
      expect(restored.training?.training.currentDate).toBe(barDate(expectedCount - 1))
    }

    expect(() => validateCompactRecording(file)).not.toThrow()
  })
})
