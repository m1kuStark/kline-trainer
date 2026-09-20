import { describe, expect, it } from 'vitest'
import { CompactReader, compactRecording } from '../../web/src/recording/compactCodec'
import { validateCompactRecording } from '../../web/src/recording/compactValidation'
import type { ReplayEventWindow } from '../../web/src/recording/compactReplay'
import {
  REPLAY_EVENT_WINDOW,
  compactCheckpointIndexForSeq,
  replayEventWindow,
  replayNextWindowAnchor,
  replayPrevWindowAnchor,
  replayStepInWindow,
} from '../../web/src/recording/compactReplay'
import { checkpointForSeq, describeGap, gapCoveringSeq, stepWaitMs, summarizeGaps } from '../../web/src/recording/replay'
import type { Bar, TrainingSnapshot } from '../../web/src/api'
import type {
  ChartCapture,
  RecordingCheckpoint,
  RecordingEvent,
  RecordingFile,
} from '../../web/src/recording/types'

const BASE_DATE = '2026-01-05'

function makeBars(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10)
    return { date, open: 10, high: 11, low: 9.5, close: 10 + i, volume: 1000 + i, amount: 10500 + i }
  })
}

function makeTraining(equity: number, currentDate: string): TrainingSnapshot {
  return {
    training: {
      id: 7,
      tier: '6M',
      code: '600000',
      name: '浦发银行',
      market: 'SH',
      startDate: BASE_DATE,
      plannedEnd: '2026-07-01',
      currentDate,
      status: 'running',
      settleDate: null,
      earlySettle: false,
      blind: false,
      adjustMode: 'forward',
      initialCash: 100000,
      createdAt: '2026-01-05T01:00:00.000Z',
    },
    account: { cash: 95000, shares: 500, availableShares: 500, costPrice: 10, marketValue: 5000, equity },
    trades: [],
  }
}

function makeChart(barCount: number): ChartCapture {
  return {
    timeframe: '1D',
    bars: makeBars(barCount),
    drawings: [],
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: 10,
  }
}

function makeEvent(seq: number, overrides: Partial<RecordingEvent> = {}): RecordingEvent {
  return {
    seq,
    opId: `op-${seq}`,
    segmentId: 'seg-1',
    elapsedMs: seq * 10,
    phase: 'started',
    action: 'training.advance',
    source: 'ui',
    ...overrides,
  }
}

function makePair(seq: number, opId: string, checkpointId?: string): RecordingEvent[] {
  const finished = makeEvent(seq + 1, { opId, phase: 'finished', outcome: 'accepted' })
  if (checkpointId !== undefined) finished.checkpointId = checkpointId
  return [makeEvent(seq, { opId }), finished]
}

function makeCheckpoint(
  afterSeq: number,
  overrides: Partial<RecordingCheckpoint> = {},
): RecordingCheckpoint {
  return {
    id: `cp-${afterSeq}`,
    afterSeq,
    segmentId: 'seg-1',
    capturedAt: `2026-01-05T09:${String(afterSeq % 60).padStart(2, '0')}:00.000Z`,
    training: null,
    chart: null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: null,
    ...overrides,
  }
}

function makeFile(overrides: Partial<RecordingFile> = {}): RecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 1,
    sessionId: 'session-1',
    createdAt: '2026-01-05T01:00:00.000Z',
    app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: false, chartLibrary: 'klinecharts@10.0.3' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 }, dpr: 1 },
    trainingKey: '600000-SH-6M',
    events: [
      ...makePair(1, 'op-a'),
      ...makePair(3, 'op-b', 'cp-4'),
      ...makePair(5, 'op-c'),
      ...makePair(7, 'op-d', 'cp-8'),
      ...makePair(9, 'op-e'),
    ],
    checkpoints: [],
    gaps: [],
    complete: true,
    ...overrides,
  }
}

/** 入口合同：v1 先紧凑迁移，再按 v2 校验；后续断言都跑在校验过的紧凑数据上 */
function toCompact(file: RecordingFile) {
  return validateCompactRecording(compactRecording(file))
}

describe('紧凑检查点选择（二分索引）', () => {
  const file = makeFile({
    checkpoints: [
      makeCheckpoint(4, { id: 'cp-4', training: makeTraining(100000, '2026-01-07'), chart: makeChart(3) }),
      makeCheckpoint(8, { id: 'cp-8', training: makeTraining(101000, '2026-01-08'), chart: makeChart(4) }),
      makeCheckpoint(8, { id: 'cp-8b', training: makeTraining(102000, '2026-01-09'), chart: makeChart(5) }),
    ],
  })
  const compact = toCompact(file)
  const reader = new CompactReader(compact)

  function selectedId(seq: number): string | null {
    const index = compactCheckpointIndexForSeq(compact.checkpoints, seq)
    return index === null ? null : compact.checkpoints[index]!.id
  }

  it('旧 v1 与新 v2 对同 seq 选到同一检查点，还原内容一致', () => {
    for (let seq = 0; seq <= file.events.length; seq += 1) {
      const v1 = checkpointForSeq(file.checkpoints, seq)
      const v2 = selectedId(seq)
      expect(v2).toBe(v1?.id ?? null)
      if (v1) expect(reader.checkpointAt(compactCheckpointIndexForSeq(compact.checkpoints, seq)!)).toEqual(v1)
    }
  })

  it('同 afterSeq 取靠后者（更完整状态），尾步与末尾之后同样是它', () => {
    expect(selectedId(8)).toBe('cp-8b')
    expect(selectedId(9)).toBe('cp-8b')
    expect(selectedId(10)).toBe('cp-8b')
    const decoded = reader.checkpointAt(compactCheckpointIndexForSeq(compact.checkpoints, 8)!)
    expect(decoded.training?.account.equity).toBe(102000)
    expect(decoded.chart?.bars).toHaveLength(5)
  })

  it('首步无覆盖检查点返回 null，空检查点表返回 null', () => {
    expect(selectedId(0)).toBeNull()
    expect(selectedId(3)).toBeNull()
    expect(compactCheckpointIndexForSeq([], 0)).toBeNull()
  })

  it('afterSeq=0 的初始检查点在第 0 步命中', () => {
    const initial = toCompact(makeFile({
      checkpoints: [makeCheckpoint(0, { id: 'cp-0', chart: makeChart(1) })],
      events: [],
    }))
    const index = compactCheckpointIndexForSeq(initial.checkpoints, 0)
    expect(index).toBe(0)
    const reader0 = new CompactReader(initial)
    expect(reader0.checkpointAt(0).chart?.bars).toHaveLength(1)
  })

  it('不前窥：未到 afterSeq 的步骤只还原过去内容，绝不引用未来图表', () => {
    expect(selectedId(5)).toBe('cp-4')
    expect(selectedId(7)).toBe('cp-4')
    const decoded = reader.checkpointAt(compactCheckpointIndexForSeq(compact.checkpoints, 7)!)
    expect(decoded.chart?.bars.map(bar => bar.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07'])
    expect(decoded.chart?.bars.some(bar => bar.date > '2026-01-07')).toBe(false)
  })
})

describe('有界事件窗口', () => {
  const TOTAL = 50_000

  it('以锚点为中心，最多 100 项，边界稳定且夹取到 1..总数', () => {
    expect(replayEventWindow(0, TOTAL)).toEqual({ first: 1, last: 100 })
    expect(replayEventWindow(50, TOTAL)).toEqual({ first: 1, last: 100 })
    expect(replayEventWindow(300, TOTAL)).toEqual({ first: 251, last: 350 })
    expect(replayEventWindow(TOTAL, TOTAL)).toEqual({ first: TOTAL - REPLAY_EVENT_WINDOW + 1, last: TOTAL })
    for (const anchor of [0, 1, 50, 251, 25000, 49999, 50000]) {
      const w = replayEventWindow(anchor, TOTAL)
      expect(w.last - w.first + 1).toBe(REPLAY_EVENT_WINDOW)
      expect(w.first).toBeGreaterThanOrEqual(1)
      expect(w.last).toBeLessThanOrEqual(TOTAL)
    }
    // 同输入边界稳定：重复计算不漂移
    expect(replayEventWindow(300, TOTAL)).toEqual(replayEventWindow(300, TOTAL))
  })

  it('不足一窗的小录制与空录制', () => {
    expect(replayEventWindow(3, 7)).toEqual({ first: 1, last: 7 })
    expect(replayEventWindow(7, 7)).toEqual({ first: 1, last: 7 })
    expect(replayEventWindow(0, 0)).toEqual({ first: 1, last: 0 })
  })

  it('步包含判定：第 0 步视作首窗，窗口外步触发回锚', () => {
    const first = replayEventWindow(0, TOTAL)
    expect(replayStepInWindow(0, first)).toBe(true)
    expect(replayStepInWindow(100, first)).toBe(true)
    expect(replayStepInWindow(101, first)).toBe(false)
    const middle = replayEventWindow(300, TOTAL)
    expect(replayStepInWindow(300, middle)).toBe(true)
    expect(replayStepInWindow(250, middle)).toBe(false)
    // 播放越过窗口末端的回锚结果：重新以当前步为中心
    const reanchored = replayEventWindow(101, TOTAL)
    expect(replayStepInWindow(101, reanchored)).toBe(true)
  })

  it('手动下一组/上一组整窗相邻，往返覆盖全部事件', () => {
    let w: ReplayEventWindow = replayEventWindow(0, TOTAL)
    expect(replayPrevWindowAnchor(w)).toBe(50)
    expect(replayEventWindow(50, TOTAL)).toEqual(w)
    let groups = 1
    while (w.last < TOTAL) {
      const next = replayEventWindow(replayNextWindowAnchor(w, TOTAL), TOTAL)
      expect(next.first).toBe(w.last + 1)
      w = next
      groups += 1
    }
    expect(groups).toBe(TOTAL / REPLAY_EVENT_WINDOW)
    expect(w).toEqual({ first: TOTAL - REPLAY_EVENT_WINDOW + 1, last: TOTAL })
    // 末组再点下一组保持原地
    expect(replayEventWindow(replayNextWindowAnchor(w, TOTAL), TOTAL)).toEqual(w)
    while (w.first > 1) {
      const prev = replayEventWindow(replayPrevWindowAnchor(w), TOTAL)
      expect(prev.last).toBe(w.first - 1)
      w = prev
    }
    expect(w).toEqual({ first: 1, last: REPLAY_EVENT_WINDOW })
  })
})

describe('大数据量：10000 检查点 / 50000 事件仍只返回窗口', () => {
  const events: RecordingEvent[] = []
  for (let seq = 1; seq <= 50_000; seq += 2) {
    events.push(makeEvent(seq, { opId: `op-${seq}` }))
    events.push(makeEvent(seq + 1, { opId: `op-${seq}`, phase: 'finished', outcome: 'accepted' }))
  }
  const checkpoints: RecordingCheckpoint[] = Array.from({ length: 10_000 }, (_, i) =>
    makeCheckpoint(i * 5, { id: `cp-big-${i}` }),
  )
  const compact = toCompact(makeFile({ events, checkpoints }))
  const reader = new CompactReader(compact)

  it('二分索引在大表上仍选最近覆盖检查点', () => {
    for (const seq of [0, 4, 5, 6, 24_999, 25_000, 49_994, 49_995, 50_000]) {
      const index = compactCheckpointIndexForSeq(compact.checkpoints, seq)
      expect(index).toBe(Math.min(Math.floor(seq / 5), 9_999))
      const decoded = reader.checkpointAt(index!)
      expect(decoded.afterSeq).toBeLessThanOrEqual(seq)
      expect(decoded.id).toBe(`cp-big-${index}`)
    }
  })

  it('窗口只含最多 100 个真实事件，序号连续且不越界', () => {
    const w = replayEventWindow(25_000, 50_000)
    expect(w).toEqual({ first: 24_951, last: 25_050 })
    const listed = compact.events.slice(w.first - 1, w.last)
    expect(listed).toHaveLength(REPLAY_EVENT_WINDOW)
    expect(listed[0]!.seq).toBe(w.first)
    expect(listed[REPLAY_EVENT_WINDOW - 1]!.seq).toBe(w.last)
    expect(replayStepInWindow(25_000, w)).toBe(true)
    // 末组锚点只展示最后 100 项
    expect(replayEventWindow(50_000, 50_000)).toEqual({ first: 49_901, last: 50_000 })
  })
})

describe('null chart/training 与缺口原 helper 兼容', () => {
  const file = makeFile({
    events: [
      ...makePair(1, 'op-a'),
      ...makePair(3, 'op-pause').map(event => ({ ...event, action: 'recording.pause' as const })),
      ...makePair(5, 'op-resume').map(event => ({ ...event, action: 'recording.resume' as const })),
    ],
    checkpoints: [makeCheckpoint(6, { id: 'cp-6' })],
    gaps: [{ afterSeq: 4, resumedAtSeq: 5 }],
  })
  const compact = toCompact(file)
  const reader = new CompactReader(compact)

  it('null chart/training/context 原样还原，未覆盖步骤返回 null', () => {
    const index = compactCheckpointIndexForSeq(compact.checkpoints, 6)
    const decoded = reader.checkpointAt(index!)
    expect(decoded.chart).toBeNull()
    expect(decoded.training).toBeNull()
    expect(decoded.context).toBeNull()
    expect(compactCheckpointIndexForSeq(compact.checkpoints, 5)).toBeNull()
  })

  it('缺口边界步命中、恢复后消失，摘要与文案保持 v1 helper 语义', () => {
    expect(gapCoveringSeq(compact.gaps, 4)).toEqual({ afterSeq: 4, resumedAtSeq: 5 })
    expect(gapCoveringSeq(compact.gaps, 5)).toEqual({ afterSeq: 4, resumedAtSeq: 5 })
    expect(gapCoveringSeq(compact.gaps, 3)).toBeNull()
    expect(gapCoveringSeq(compact.gaps, 6)).toBeNull()
    expect(summarizeGaps(compact.gaps)).toBe('本录制含 1 段未记录区间')
    expect(describeGap(compact.gaps[0]!)).toBe('录制自第 4 个事件后暂停，至第 5 个事件恢复，期间的操作未记录')
  })

  it('播放时距仍按事件真实 elapsedMs 计算', () => {
    expect(stepWaitMs(compact.events, 1, 1)).toBe(10)
    expect(stepWaitMs(compact.events, 5, 2)).toBe(5)
    expect(stepWaitMs(compact.events, 6, 1)).toBe(0)
  })
})
