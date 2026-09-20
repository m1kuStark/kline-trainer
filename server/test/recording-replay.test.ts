import { describe, expect, it } from 'vitest'
import { Recorder } from '../../web/src/recording/recorder'
import { MemoryRecordingStorage } from '../../web/src/recording/storage'
import type {
  ChartCapture,
  CheckpointInput,
  RecordingCheckpoint,
  RecordingEvent,
  RecordingFile,
  TrainingSnapshot,
} from '../../web/src/recording/types'
import {
  MAX_STEP_WAIT_MS,
  checkpointForSeq,
  describeEvent,
  describeGap,
  gapCoveringSeq,
  stepWaitMs,
  summarizeGaps,
} from '../../web/src/recording/replay'
import { validateRecording } from '../../web/src/recording/validation'

const CURRENT_DATE = '2026-03-31'

function makeSnapshot(overrides: Partial<TrainingSnapshot> = {}): TrainingSnapshot {
  return {
    training: {
      id: 1,
      tier: '3M',
      code: '000001',
      name: '平安银行',
      market: 'SZ',
      startDate: '2026-01-05',
      plannedEnd: '2026-04-05',
      currentDate: CURRENT_DATE,
      status: 'running',
      settleDate: null,
      earlySettle: false,
      blind: false,
      adjustMode: 'forward',
      initialCash: 100000,
      createdAt: '2026-01-05T09:30:00.000Z',
    },
    account: { cash: 50000, shares: 1000, availableShares: 800, costPrice: 50, marketValue: 50000, equity: 100000 },
    trades: [],
    ...overrides,
  }
}

function makeChart(overrides: Partial<ChartCapture> = {}): ChartCapture {
  return {
    timeframe: '1D',
    bars: [{ date: CURRENT_DATE, open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000000, amount: 10500000 }],
    drawings: [],
    view: { fromTimestamp: 1767225600000, toTimestamp: 1772256000000, barSpace: 8, paneHeights: { candle_pane: 400 } },
    costPrice: 50,
    ...overrides,
  }
}

function makeEvent(seq: number, overrides: Partial<RecordingEvent> = {}): RecordingEvent {
  return {
    seq,
    opId: `op-${seq}`,
    segmentId: 'seg-1',
    elapsedMs: seq * 100,
    phase: 'started',
    action: 'training.advance',
    source: 'ui',
    ...overrides,
  }
}

function makePair(seq: number, action: RecordingEvent['action'], opId: string): RecordingEvent[] {
  return [
    makeEvent(seq, { opId, phase: 'started', action }),
    makeEvent(seq + 1, { opId, phase: 'finished', action, outcome: 'accepted', result: null }),
  ]
}

function makeCheckpoint(afterSeq: number, overrides: Partial<RecordingCheckpoint> = {}): RecordingCheckpoint {
  return {
    id: `cp-${afterSeq}`,
    afterSeq,
    segmentId: 'seg-1',
    capturedAt: '2026-03-31T15:00:00.000Z',
    training: makeSnapshot(),
    chart: makeChart(),
    ui: { theme: 'light', tool: null, magnet: 'off', multiSelect: false },
    context: null,
    ...overrides,
  }
}

function makeFile(overrides: Partial<RecordingFile> = {}): RecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 1,
    sessionId: 'session-1',
    createdAt: '2026-01-05T09:30:00.000Z',
    app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: false, chartLibrary: 'klinecharts@10.0.3' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 }, dpr: 1 },
    trainingKey: '000001-SZ-3M',
    events: [
      ...makePair(1, 'training.create', 'op-create'),
      makeEvent(3, { opId: 'op-advance', phase: 'started', action: 'training.advance' }),
      makeEvent(4, { opId: 'op-advance', phase: 'finished', action: 'training.advance', outcome: 'accepted', result: null, checkpointId: 'cp-1' }),
    ],
    checkpoints: [makeCheckpoint(4, { id: 'cp-1' })],
    gaps: [],
    complete: true,
    ...overrides,
  }
}

function expectFail(fn: () => unknown, keyword: string): void {
  let message: string | null = null
  try {
    fn()
  } catch (error) {
    message = (error as Error).message
  }
  expect(message, '预期校验抛错但通过了').not.toBeNull()
  expect(message).toContain('录制文件校验失败')
  expect(message).toContain(keyword)
}

describe('checkpointForSeq', () => {
  const checkpoints = [
    makeCheckpoint(2, { id: 'cp-a' }),
    makeCheckpoint(4, { id: 'cp-b', training: makeSnapshot({ account: { cash: 1, shares: 1, availableShares: 1, costPrice: null, marketValue: 1, equity: 2 } }) }),
    makeCheckpoint(4, { id: 'cp-c' }),
  ]

  it('selects the latest checkpoint whose afterSeq is at or before the current step', () => {
    expect(checkpointForSeq(checkpoints, 4)?.id).toBe('cp-c')
    expect(checkpointForSeq(checkpoints, 3)?.id).toBe('cp-a')
    expect(checkpointForSeq(checkpoints, 2)?.id).toBe('cp-a')
  })

  it('returns null on the first step when no checkpoint covers seq 0', () => {
    expect(checkpointForSeq(checkpoints, 0)).toBeNull()
    expect(checkpointForSeq(checkpoints, 1)).toBeNull()
  })

  it('returns null for an empty checkpoint list', () => {
    expect(checkpointForSeq([], 0)).toBeNull()
    expect(checkpointForSeq([], 10)).toBeNull()
  })

  it('never peeks ahead: a later future checkpoint is skipped even in a malformed array', () => {
    const unordered = [makeCheckpoint(5, { id: 'cp-future' }), makeCheckpoint(2, { id: 'cp-past' })]
    expect(checkpointForSeq(unordered, 2)).toBeNull()
    expect(checkpointForSeq(unordered, 3)).toBeNull()
    expect(checkpointForSeq(unordered, 4)).toBeNull()
  })
})

describe('gapCoveringSeq', () => {
  it('covers the pause and resume boundary steps of a closed gap', () => {
    const gaps = [{ afterSeq: 2, resumedAtSeq: 5 }]
    expect(gapCoveringSeq(gaps, 2)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 5)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 1)).toBeNull()
    expect(gapCoveringSeq(gaps, 6)).toBeNull()
    expect(gapCoveringSeq(gaps, 0)).toBeNull()
  })

  it('treats an open gap as extending from its boundary to the end', () => {
    const gaps = [{ afterSeq: 2, resumedAtSeq: null }]
    expect(gapCoveringSeq(gaps, 2)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 999)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 1)).toBeNull()
  })

  it('covers step 0 for a gap opened before any event', () => {
    const gaps = [{ afterSeq: 0, resumedAtSeq: null }]
    expect(gapCoveringSeq(gaps, 0)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 3)).toEqual(gaps[0])
  })

  it('resolves each boundary to its own gap when several exist', () => {
    const gaps = [{ afterSeq: 2, resumedAtSeq: 3 }, { afterSeq: 6, resumedAtSeq: 7 }]
    expect(gapCoveringSeq(gaps, 2)?.afterSeq).toBe(2)
    expect(gapCoveringSeq(gaps, 3)?.afterSeq).toBe(2)
    expect(gapCoveringSeq(gaps, 4)).toBeNull()
    expect(gapCoveringSeq(gaps, 5)).toBeNull()
    expect(gapCoveringSeq(gaps, 6)?.afterSeq).toBe(6)
    expect(gapCoveringSeq(gaps, 7)?.afterSeq).toBe(6)
    expect(gapCoveringSeq(gaps, 8)).toBeNull()
    expect(gapCoveringSeq([], 3)).toBeNull()
  })
})

describe('stepWaitMs', () => {
  // elapsedMs: 0, 1000, 1600；seq→seq+1 的等待＝elapsed[seq]−elapsed[seq−1]（起点按 0）
  const events = [
    makeEvent(1, { elapsedMs: 0 }),
    makeEvent(2, { elapsedMs: 1000 }),
    makeEvent(3, { elapsedMs: 1600 }),
  ]

  it('scales the adjacent elapsedMs delta by playback speed', () => {
    expect(stepWaitMs(events, 0, 1)).toBe(0)
    expect(stepWaitMs(events, 1, 1)).toBe(1000)
    expect(stepWaitMs(events, 2, 1)).toBe(600)
    expect(stepWaitMs(events, 2, 2)).toBe(300)
    expect(stepWaitMs(events, 2, 4)).toBe(150)
  })

  it('caps the wait at MAX_STEP_WAIT_MS for sparse recordings', () => {
    const sparse = [makeEvent(1, { elapsedMs: 0 }), makeEvent(2, { elapsedMs: 60000 })]
    expect(stepWaitMs(sparse, 1, 0.5)).toBe(MAX_STEP_WAIT_MS)
    expect(stepWaitMs(sparse, 1, 1)).toBe(MAX_STEP_WAIT_MS)
    expect(MAX_STEP_WAIT_MS).toBeLessThan(60000)
  })

  it('returns 0 past the last step, for equal timestamps and for non-positive speeds', () => {
    expect(stepWaitMs(events, 3, 1)).toBe(0)
    const flat = [makeEvent(1, { elapsedMs: 500 }), makeEvent(2, { elapsedMs: 500 })]
    expect(stepWaitMs(flat, 1, 1)).toBe(0)
    expect(stepWaitMs(events, 0, 0)).toBe(0)
    expect(stepWaitMs(events, 1, -2)).toBe(0)
  })
})

describe('describeEvent', () => {
  it('labels started events by action, source and phase', () => {
    expect(describeEvent(makeEvent(1, { action: 'training.advance', source: 'ui', phase: 'started' }))).toBe('推进交易日 · 界面 · 开始')
    expect(describeEvent(makeEvent(1, { action: 'chart.drawing.create', source: 'keyboard', phase: 'started' }))).toBe('新增画线 · 键盘 · 开始')
  })

  it('labels finished events by outcome and falls back to unknown', () => {
    expect(describeEvent(makeEvent(1, { phase: 'finished', outcome: 'accepted' }))).toBe('推进交易日 · 界面 · 完成')
    expect(describeEvent(makeEvent(1, { phase: 'finished', outcome: 'rejected' }))).toBe('推进交易日 · 界面 · 被拒绝')
    expect(describeEvent(makeEvent(1, { phase: 'finished', outcome: undefined }))).toBe('推进交易日 · 界面 · 结果未知')
  })
})

describe('describeGap', () => {
  it('describes a closed gap as a pause interval, never as missing event numbers', () => {
    expect(describeGap({ afterSeq: 4, resumedAtSeq: 5 })).toBe(
      '录制自第 4 个事件后暂停，至第 5 个事件恢复，期间的操作未记录',
    )
  })

  it('describes open gaps from session start and from a pause boundary', () => {
    expect(describeGap({ afterSeq: 0, resumedAtSeq: null })).toBe('录制自会话开始暂停，此后未记录')
    expect(describeGap({ afterSeq: 4, resumedAtSeq: null })).toBe('录制自第 4 个事件后暂停，此后未记录')
  })
})

describe('summarizeGaps', () => {
  it('keeps a persistent interval count and returns null without gaps', () => {
    expect(summarizeGaps([])).toBeNull()
    expect(summarizeGaps([{ afterSeq: 4, resumedAtSeq: 5 }])).toBe('本录制含 1 段未记录区间')
    expect(summarizeGaps([{ afterSeq: 0, resumedAtSeq: 3 }, { afterSeq: 5, resumedAtSeq: null }])).toBe(
      '本录制含 2 段未记录区间',
    )
  })
})

describe('out-of-order input', () => {
  it('validator rejects events whose seq is out of order', () => {
    const file = makeFile()
    const swapped = file.events[0]
    file.events[0] = file.events[1]
    file.events[1] = swapped
    expectFail(() => validateRecording(file), 'seq')
  })

  it('validator rejects checkpoints whose afterSeq goes backwards', () => {
    const file = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1' }), makeCheckpoint(2, { id: 'cp-2' })] })
    expectFail(() => validateRecording(file), 'afterSeq')
  })

  it('validator rejects event timings that go backwards', () => {
    const file = makeFile()
    file.events[3].elapsedMs = file.events[2].elapsedMs - 1000
    expectFail(() => validateRecording(file), 'elapsedMs')
  })

  it('replay helpers do not reorder and never surface a future checkpoint from unordered data', () => {
    const file = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1' }), makeCheckpoint(2, { id: 'cp-2' })] })
    expect(() => validateRecording(structuredClone(file))).toThrow()
    expect(file.checkpoints.map(checkpoint => checkpoint.id)).toEqual(['cp-1', 'cp-2'])
    expect(checkpointForSeq(file.checkpoints, 3)).toBeNull()
  })
})

describe('真实 Recorder 缺口合同', () => {
  function makeCheckpointInput(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
    return {
      training: null,
      chart: null,
      ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
      context: null,
      ...overrides,
    }
  }

  async function makeRealRecorder(): Promise<Recorder> {
    return new Recorder(new MemoryRecordingStorage(), {
      app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
      environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    })
  }

  /** 首屏关闭：start(enabled=false) 后从未恢复 */
  async function recordInitiallyPaused(): Promise<RecordingFile> {
    const recorder = await makeRealRecorder()
    await recorder.start('train-1', makeCheckpointInput(), false)
    return recorder.getFile()
  }

  /** pause→resume，暂停与恢复之间不记录任何操作 */
  async function recordPauseResume(): Promise<RecordingFile> {
    const recorder = await makeRealRecorder()
    await recorder.start('train-1', makeCheckpointInput())
    const opId = recorder.begin('training.advance')
    recorder.finish(opId!, 'accepted')
    await recorder.pause(makeCheckpointInput())
    await recorder.resume(makeCheckpointInput())
    return recorder.getFile()
  }

  /** 末尾暂停且从未恢复 */
  async function recordEndPause(): Promise<RecordingFile> {
    const recorder = await makeRealRecorder()
    await recorder.start('train-1', makeCheckpointInput())
    const opId = recorder.begin('training.advance')
    recorder.finish(opId!, 'accepted')
    await recorder.pause(makeCheckpointInput())
    return recorder.getFile()
  }

  it('pause 与 resume 相邻：afterSeq=N、resumedAtSeq=N+1，缺口在两个边界步命中，恢复后消失', async () => {
    const file = validateRecording(await recordPauseResume())
    expect(file.events.map(event => event.action)).toEqual([
      'training.advance',
      'training.advance',
      'recording.pause',
      'recording.pause',
      'recording.resume',
      'recording.resume',
    ])
    expect(file.gaps).toEqual([{ afterSeq: 4, resumedAtSeq: 5 }])
    expect(file.gaps[0]!.resumedAtSeq).toBe(file.gaps[0]!.afterSeq + 1)
    const gaps = file.gaps
    expect(gapCoveringSeq(gaps, 4)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 5)).toEqual(gaps[0])
    expect(gapCoveringSeq(gaps, 3)).toBeNull()
    expect(gapCoveringSeq(gaps, 6)).toBeNull()
  })

  it('complete=true 与未记录区间并存：摘要仍报告 1 段，边界文案不声称缺失事件', async () => {
    const file = validateRecording(await recordPauseResume())
    expect(file.complete).toBe(true)
    expect(file.gaps.length).toBe(1)
    expect(summarizeGaps(file.gaps)).toBe('本录制含 1 段未记录区间')
    expect(describeGap(file.gaps[0]!)).toBe('录制自第 4 个事件后暂停，至第 5 个事件恢复，期间的操作未记录')
    expect(describeGap(file.gaps[0]!)).not.toContain('无缺失')
  })

  it('首屏关闭：afterSeq=0 的开放缺口在初始第 0 步命中', async () => {
    const file = validateRecording(await recordInitiallyPaused())
    expect(file.events).toEqual([])
    expect(file.gaps).toEqual([{ afterSeq: 0, resumedAtSeq: null }])
    expect(file.complete).toBe(false)
    expect(gapCoveringSeq(file.gaps, 0)).toEqual(file.gaps[0]!)
    expect(describeGap(file.gaps[0]!)).toBe('录制自会话开始暂停，此后未记录')
  })

  it('末尾暂停未恢复：缺口在最后一步命中且延续到其后', async () => {
    const file = validateRecording(await recordEndPause())
    expect(file.events).toHaveLength(4)
    expect(file.gaps).toEqual([{ afterSeq: 4, resumedAtSeq: null }])
    expect(file.complete).toBe(false)
    expect(gapCoveringSeq(file.gaps, 4)).toEqual(file.gaps[0]!)
    expect(gapCoveringSeq(file.gaps, 5)).toEqual(file.gaps[0]!)
    expect(describeGap(file.gaps[0]!)).toBe('录制自第 4 个事件后暂停，此后未记录')
  })
})
