import { describe, expect, it, vi } from 'vitest'
import { Recorder } from '../../web/src/recording/recorder'
import { MemoryRecordingStorage } from '../../web/src/recording/storage'
import { validateRecording } from '../../web/src/recording/validation'
import type {
  ChartCapture,
  CheckpointInput,
  RecorderOptions,
  RecorderStatus,
  RecordingEvent,
  RecordingFile,
} from '../../web/src/recording/types'

function makeCheckpointInput(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
  return {
    training: null,
    chart: null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: null,
    ...overrides,
  }
}

function makeRecorder(
  storage = new MemoryRecordingStorage(),
  overrides: Partial<RecorderOptions> = {},
): { recorder: Recorder; storage: MemoryRecordingStorage; statuses: RecorderStatus[] } {
  const statuses: RecorderStatus[] = []
  const recorder = new Recorder(storage, {
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

function settleMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

const SAMPLE_CHART: ChartCapture = {
  timeframe: '1D',
  bars: [{ date: '2026-01-05', open: 10, high: 11, low: 9, close: 10.5, volume: 1000, amount: 10500 }],
  drawings: [],
  view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
  costPrice: null,
}

describe('Recorder 基本录制', () => {
  it('begin/finish 配对，seq 与 elapsed 单调，params/result/checkpoint 深拷贝', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('train-1', makeCheckpointInput())

    const params = { side: 'buy', shares: 100 }
    const opId = recorder.begin('training.trade', params, 'ui')
    expect(typeof opId).toBe('string')
    expect(recorder.getFile().complete).toBe(false)
    params.side = 'sell'

    const result = { amount: 12345 }
    recorder.finish(opId!, 'accepted', result, makeCheckpointInput())
    result.amount = 0

    const file = recorder.getFile()
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
    const linked = file.checkpoints.find(checkpoint => checkpoint.id === finished.checkpointId)
    expect(linked?.afterSeq).toBe(2)

    file.events[0].action = 'ui.theme'
    expect(recorder.getFile().events[0].action).toBe('training.trade')
    const status = recorder.getStatus()
    status.eventCount = 999
    expect(recorder.getStatus().eventCount).toBe(2)
    expect(recorder.getStatus().state).toBe('recording')
  })

  it('默认 enabled=true 进入 recording；enabled=false 明确 paused 并记录未闭合 gap', async () => {
    const on = makeRecorder()
    await on.recorder.start('k', makeCheckpointInput())
    expect(on.recorder.getStatus().state).toBe('recording')
    const openOp = on.recorder.begin('ui.theme', undefined, 'ui')
    expect(openOp).not.toBeNull()
    expect(on.recorder.getFile().complete).toBe(false)
    on.recorder.finish(openOp!, 'accepted')
    expect(on.recorder.getFile().complete).toBe(true)

    const off = makeRecorder()
    await off.recorder.start('k', makeCheckpointInput(), false)
    expect(off.recorder.getStatus().state).toBe('paused')
    expect(off.recorder.begin('ui.theme', undefined, 'ui')).toBeNull()
    const file = off.recorder.getFile()
    expect(file.gaps).toEqual([{ afterSeq: 0, resumedAtSeq: null }])
    expect(file.complete).toBe(false)
    const checkpointCount = file.checkpoints.length
    off.recorder.capture(makeCheckpointInput())
    expect(off.recorder.getFile().checkpoints).toHaveLength(checkpointCount)
  })

  it('capture 保存不可变 checkpoint，字段指向当前 seq 与分段', async () => {
    const { recorder } = makeRecorder()
    await recorder.start(null, makeCheckpointInput())
    const chart = structuredClone(SAMPLE_CHART)
    recorder.capture(makeCheckpointInput({ chart }))
    chart.bars[0].close = 999
    chart.view.barSpace = 0

    const file = recorder.getFile()
    const checkpoint = file.checkpoints.at(-1)!
    expect(checkpoint.chart?.bars[0].close).toBe(10.5)
    expect(checkpoint.chart?.view.barSpace).toBe(8)
    expect(checkpoint.afterSeq).toBe(file.events.length)
    expect(checkpoint.segmentId).toBe(file.checkpoints[0].segmentId)
    expect(Number.isNaN(Date.parse(checkpoint.capturedAt))).toBe(false)
  })
})

describe('暂停与恢复', () => {
  it('pause 先闭合进行中操作为 interrupted，恢复开启新 segment 并闭合 gap', async () => {
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
    expect(file.gaps[0].resumedAtSeq).toBeNull()
    expect(file.complete).toBe(false)
    assertSeqAndElapsedMonotonic(file.events)

    expect(recorder.begin('ui.theme', undefined, 'ui')).toBeNull()
    const checkpointCount = file.checkpoints.length
    recorder.capture(makeCheckpointInput())
    expect(recorder.getFile().checkpoints).toHaveLength(checkpointCount)

    await recorder.resume(makeCheckpointInput({ chart: SAMPLE_CHART }))
    file = recorder.getFile()
    expect(recorder.getStatus().state).toBe('recording')
    expect(file.gaps[0].resumedAtSeq).not.toBeNull()
    expect(file.gaps[0].resumedAtSeq).toBeLessThanOrEqual(file.events.at(-1)!.seq)
    expect(file.events.filter(event => event.action === 'recording.resume')).toHaveLength(2)
    const segmentAfterResume = file.events.at(-1)!.segmentId
    expect(segmentAfterResume).not.toBe(file.events[0].segmentId)
    const resumeCheckpoint = file.checkpoints.at(-1)!
    expect(resumeCheckpoint.segmentId).toBe(segmentAfterResume)
    expect(resumeCheckpoint.chart).toEqual(SAMPLE_CHART)
    expect(file.complete).toBe(true)
    assertSeqAndElapsedMonotonic(file.events)

    expect(recorder.begin('ui.theme', undefined, 'ui')).not.toBeNull()
    assertSeqAndElapsedMonotonic(recorder.getFile().events)
  })
})

describe('存储串行与故障', () => {
  it('保存严格串行执行，最后一份快照包含全部事件', async () => {
    const storage = new MemoryRecordingStorage()
    const snapshots: number[] = []
    let active = 0
    let maxActive = 0
    let blockCount = 1
    const held: Array<() => void> = []
    storage.onSave = async file => {
      snapshots.push(file.events.length)
      active += 1
      maxActive = Math.max(maxActive, active)
      if (blockCount > 0) {
        blockCount -= 1
        await new Promise<void>(resolve => held.push(resolve))
      }
      active -= 1
    }
    const { recorder } = makeRecorder(storage)

    const startPromise = recorder.start('k', makeCheckpointInput())
    await settleMacrotask()
    expect(snapshots).toEqual([0])

    const opId = recorder.begin('chart.load', undefined, 'chart')
    recorder.finish(opId!, 'accepted')
    await settleMacrotask()
    expect(maxActive).toBe(1)
    expect(snapshots).toEqual([0])

    held[0]()
    await startPromise
    await recorder.flush()
    expect(maxActive).toBe(1)
    expect(snapshots).toEqual([0, 2])
  })

  it('保存失败立即上报 onChange 与 error 状态，flush/export 抛中文可行动错误，恢复后不丢事件', async () => {
    const storage = new MemoryRecordingStorage()
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
    expect(persisted?.complete).toBe(true)
  })

  it('export 等待持久化完成并返回深拷贝', async () => {
    const storage = new MemoryRecordingStorage()
    let blockCount = 0
    let release!: () => void
    let gate = Promise.resolve()
    storage.onSave = () => {
      if (blockCount > 0) {
        blockCount -= 1
        gate = new Promise<void>(resolve => { release = resolve })
        return gate
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
  it('restore 修补悬空 started 为 interrupted，不伪造结果，续录保持单调', async () => {
    const storage = new MemoryRecordingStorage()
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
    const patched = restored.events.at(-1)!
    expect(patched.opId).toBe(opId)
    expect(patched.phase).toBe('finished')
    expect(patched.outcome).toBe('interrupted')
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
    const storage = new MemoryRecordingStorage()
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
    expect(second.recorder.getFile().gaps[0].resumedAtSeq).not.toBeNull()
    expect(second.recorder.getFile().complete).toBe(true)
    expect(second.recorder.begin('ui.theme', undefined, 'ui')).not.toBeNull()
  })

  it('restore 失败如实报告，不假成功', async () => {
    const storage = new MemoryRecordingStorage()
    const missing = makeRecorder(storage)
    await expect(missing.recorder.restore('no-such-session')).rejects.toThrow('不存在')
    expect(missing.recorder.getStatus().state).toBe('error')
    expect(missing.statuses.at(-1)?.state).toBe('error')

    const broken = new MemoryRecordingStorage()
    broken.loadFailure = new Error('存储读取被拒绝')
    const failing = makeRecorder(broken)
    await expect(failing.recorder.restore('any')).rejects.toThrow('存储读取被拒绝')
    expect(failing.recorder.getStatus().state).toBe('error')
  })

  it('restore 后墙钟 +100ms 的事件 elapsed 严格等于基准 +100（anchorWall 只减一次）', async () => {
    const storage = new MemoryRecordingStorage()
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
})

describe('export 与 validateRecording 交叉', () => {
  it('初始 enabled=false 的会话文件通过 validateRecording', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput(), false)
    expect(recorder.getFile().gaps).toEqual([{ afterSeq: 0, resumedAtSeq: null }])
    expect(() => validateRecording(recorder.getFile())).not.toThrow()
  })

  it('pause 与 resume 后 export 均通过 validateRecording', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput())
    const opId = recorder.begin('training.trade', { side: 'buy' }, 'ui')
    await recorder.pause(makeCheckpointInput())
    expect(() => validateRecording(recorder.getFile())).not.toThrow()

    await recorder.resume(makeCheckpointInput())
    const next = recorder.begin('ui.theme', undefined, 'ui')
    recorder.finish(next!, 'accepted')
    const exported = await recorder.export()
    expect(() => validateRecording(exported)).not.toThrow()
  })

  it('restore 沿用停止时 segment 续录，capture 后 export 通过 validateRecording', async () => {
    const storage = new MemoryRecordingStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeCheckpointInput())
    const dangling = first.recorder.begin('training.trade', { side: 'buy' }, 'ui')
    const closed = first.recorder.begin('chart.load', undefined, 'chart')
    first.recorder.finish(closed!, 'accepted')
    await first.recorder.flush()
    const sessionId = first.recorder.getStatus().sessionId

    const second = makeRecorder(storage)
    await second.recorder.restore(sessionId)
    const restored = second.recorder.getFile()
    const stoppedSegment = restored.events.at(-1)!.segmentId
    const patched = restored.events.find(event => event.opId === dangling && event.phase === 'finished')!
    expect(patched.outcome).toBe('interrupted')
    expect(patched.segmentId).toBe(stoppedSegment)
    expect(() => validateRecording(restored)).not.toThrow()

    second.recorder.capture(makeCheckpointInput({ chart: structuredClone(SAMPLE_CHART) }))
    expect(second.recorder.getFile().checkpoints.at(-1)!.segmentId).toBe(stoppedSegment)
    expect(() => validateRecording(second.recorder.getFile())).not.toThrow()

    const next = second.recorder.begin('ui.theme', undefined, 'ui')
    second.recorder.finish(next!, 'accepted')
    const exported = await second.recorder.export()
    expect(() => validateRecording(exported)).not.toThrow()
    expect(exported.checkpoints.at(-1)!.segmentId).toBe(stoppedSegment)
  })

  it('损坏的存量会话被 restore 拒绝并进入 error 状态', async () => {
    const storage = new MemoryRecordingStorage()
    const first = makeRecorder(storage)
    await first.recorder.start('k', makeCheckpointInput())
    const opId = first.recorder.begin('ui.theme', undefined, 'ui')
    first.recorder.finish(opId!, 'accepted')
    await first.recorder.flush()
    const sessionId = first.recorder.getStatus().sessionId

    const persisted = await storage.load(sessionId)
    persisted!.events[0].seq = 9
    storage.records.set(sessionId, persisted!)

    const second = makeRecorder(storage)
    await expect(second.recorder.restore(sessionId)).rejects.toThrow('未通过校验')
    expect(second.recorder.getStatus().state).toBe('error')
    expect(second.statuses.at(-1)?.state).toBe('error')
  })
})

describe('RecordingFile 完整性', () => {
  it('文件头携带合同要求的 app/environment 元数据', async () => {
    const { recorder } = makeRecorder()
    await recorder.start('k', makeCheckpointInput())
    const file: RecordingFile = recorder.getFile()
    expect(file.format).toBe('trainer-session')
    expect(file.schemaVersion).toBe(1)
    expect(file.app).toEqual({ version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' })
    expect(file.environment).toEqual({ timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 })
    expect(Number.isNaN(Date.parse(file.createdAt))).toBe(false)
    expect(file.events).toHaveLength(0)
    expect(file.checkpoints).toHaveLength(1)
    expect(file.checkpoints[0].afterSeq).toBe(0)
  })
})
