import { describe, expect, it } from 'vitest'
import type {
  ChartCapture,
  Drawing,
  RecordingCheckpoint,
  RecordingEvent,
  RecordingFile,
  TrainingSnapshot,
} from '../../web/src/recording/types'
import { exportRecording, parseRecording, validateRecording } from '../../web/src/recording/validation'
import { DRAW_TOOLS } from '../../web/src/drawTools'

const CURRENT_DATE = '2026-03-31'
const MIB = 1024 * 1024

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
    drawings: [{ id: 'd1', name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1772256000000, value: 10 }] }],
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

function makeBulkEvents(count: number): RecordingEvent[] {
  const events: RecordingEvent[] = []
  for (let seq = 1; seq <= count; seq += 1) {
    const pairIndex = Math.floor((seq - 1) / 2)
    const event = makeEvent(seq, { opId: `op-${pairIndex}`, phase: seq % 2 === 1 ? 'started' : 'finished' })
    if (seq % 2 === 0) event.outcome = 'accepted'
    events.push(event)
  }
  return events
}

/** count 层嵌套数组 */
function nested(count: number): RecordingCheckpoint['context'] {
  let value: unknown = null
  for (let i = 0; i < count; i += 1) value = [value]
  return value as RecordingCheckpoint['context']
}

function setParams(event: RecordingEvent, params: unknown): void {
  ;(event as { params?: unknown }).params = params
}

function expectFail(fn: () => unknown, keyword?: string): void {
  let message: string | null = null
  try {
    fn()
  } catch (error) {
    message = (error as Error).message
  }
  expect(message, '预期校验抛错但通过了').not.toBeNull()
  expect(message).toContain('录制文件校验失败')
  if (keyword) expect(message).toContain(keyword)
}

describe('recording file acceptance', () => {
  it('accepts a fully valid file and keeps checkpoints in original order with duplicate afterSeq states', () => {
    const file = makeFile({
      checkpoints: [
        makeCheckpoint(2, { id: 'cp-3', chart: makeChart() }),
        makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ bars: [{ date: CURRENT_DATE, open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] }) }),
        makeCheckpoint(4, { id: 'cp-2', chart: makeChart() }),
      ],
    })
    const result = validateRecording(file)
    expect(result.checkpoints.map(cp => cp.id)).toEqual(['cp-3', 'cp-1', 'cp-2'])
  })

  it('round-trips through export and parse', () => {
    const file = makeFile()
    expect(parseRecording(exportRecording(file))).toEqual(file)
  })

  it('allows an initial checkpoint with no events yet', () => {
    const file = makeFile({ events: [], checkpoints: [makeCheckpoint(0, { training: null, chart: null })], complete: false })
    expect(() => validateRecording(file)).not.toThrow()
  })

  it('rejects non-object payloads', () => {
    expectFail(() => validateRecording(null), '对象')
    expectFail(() => validateRecording([makeFile()]), '对象')
    expectFail(() => validateRecording('trainer-session'), '对象')
  })
})

describe('top-level schema', () => {
  it('rejects wrong format and schemaVersion', () => {
    expectFail(() => validateRecording(makeFile({ format: 'other' })), 'format')
    expectFail(() => validateRecording(makeFile({ schemaVersion: 2 })), 'schemaVersion')
  })

  it('rejects invalid identity and metadata fields', () => {
    expectFail(() => validateRecording(makeFile({ sessionId: '' })), 'sessionId')
    expectFail(() => validateRecording(makeFile({ createdAt: 'yesterday' })), 'createdAt')
    expectFail(() => validateRecording(makeFile({ trainingKey: 5 as unknown as string })), 'trainingKey')
    expectFail(() => validateRecording(makeFile({ complete: 'true' as unknown as boolean })), 'complete')
  })

  it('rejects malformed app and environment blocks', () => {
    expectFail(() => validateRecording(makeFile({ app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: 1 as unknown as boolean, chartLibrary: 'klinecharts@10.0.3' } })), 'dirty')
    expectFail(() => validateRecording(makeFile({ environment: { timezone: 'Asia/Shanghai', viewport: { width: '1920' as unknown as number, height: 1080 }, dpr: 1 } })), 'width')
    expectFail(() => validateRecording(makeFile({ environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 }, dpr: Number.POSITIVE_INFINITY } })), 'dpr')
  })
})

describe('JSON finite values and depth', () => {
  it('rejects NaN with a finite-number reason where native stringify would silently write null', () => {
    expect(JSON.stringify({ price: Number.NaN })).toBe('{"price":null}')
    const file = makeFile()
    setParams(file.events[0], { price: Number.NaN })
    expectFail(() => validateRecording(file), '有限')
    expectFail(() => exportRecording(file), '有限')
  })

  it('rejects Infinity deep inside bars and reports the path', () => {
    const file = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ bars: [{ date: CURRENT_DATE, open: 1, high: 1, low: 1, close: Number.POSITIVE_INFINITY, volume: 1, amount: 1 }] }) })] })
    expectFail(() => validateRecording(file), 'close')
  })

  it('rejects undefined values that stringify would silently drop', () => {
    const file = makeFile()
    setParams(file.events[0], { note: undefined })
    expectFail(() => validateRecording(file), 'undefined')
  })

  it('rejects functions, Dates and other non-plain objects', () => {
    const withFunction = makeFile()
    setParams(withFunction.events[0], { onClick: () => {} })
    expectFail(() => validateRecording(withFunction), '序列化')
    const withDate = makeFile({ createdAt: new Date() as unknown as string })
    expectFail(() => validateRecording(withDate), 'createdAt')
  })

  it('rejects nesting deeper than 40 levels but accepts exactly 40', () => {
    const tooDeep = makeFile()
    ;(tooDeep.checkpoints[0] as { context: unknown }).context = nested(37)
    expectFail(() => validateRecording(tooDeep), '深度')

    const acceptable = makeFile()
    ;(acceptable.checkpoints[0] as { context: unknown }).context = nested(36)
    expect(() => validateRecording(acceptable)).not.toThrow()
  })
})

describe('event sequence and whitelist', () => {
  it('rejects actions outside the whitelist', () => {
    const file = makeFile()
    file.events[0].action = 'training.delete' as RecordingEvent['action']
    expectFail(() => validateRecording(file), '白名单')
  })

  it('rejects seq that does not start at 1 or has holes', () => {
    const shifted = makeFile()
    shifted.events = shifted.events.map((event, index) => ({ ...event, seq: index + 2 }))
    expectFail(() => validateRecording(shifted), 'seq')

    const hole = makeFile()
    hole.events[3].seq = 5
    expectFail(() => validateRecording(hole), 'seq')

    const fractional = makeFile()
    fractional.events[1].seq = 2.5
    expectFail(() => validateRecording(fractional), '整数')
  })

  it('rejects invalid source, phase, outcome and negative elapsedMs', () => {
    const file = makeFile()
    file.events[0].source = 'mouse' as RecordingEvent['source']
    expectFail(() => validateRecording(file), 'source')

    const phase = makeFile()
    phase.events[0].phase = 'pending' as RecordingEvent['phase']
    expectFail(() => validateRecording(phase), 'phase')

    const outcome = makeFile()
    outcome.events[1].outcome = 'ok' as RecordingEvent['outcome']
    expectFail(() => validateRecording(outcome), 'outcome')

    const elapsed = makeFile()
    elapsed.events[0].elapsedMs = -1
    expectFail(() => validateRecording(elapsed), 'elapsedMs')
  })
})

describe('opId pairing', () => {
  it('rejects a finished event without a paired start', () => {
    const file = makeFile({ events: [makeEvent(1, { opId: 'op-x', phase: 'finished', outcome: 'accepted' })], complete: false })
    expectFail(() => validateRecording(file), 'started')
  })

  it('rejects duplicate starts and duplicate finishes for the same opId', () => {
    const doubleStart = makeFile({
      events: [makeEvent(1, { opId: 'op-a', phase: 'started' }), makeEvent(2, { opId: 'op-a', phase: 'started' })],
      complete: false,
    })
    expectFail(() => validateRecording(doubleStart), 'opId')

    const doubleFinish = makeFile({
      events: [
        makeEvent(1, { opId: 'op-a', phase: 'started' }),
        makeEvent(2, { opId: 'op-a', phase: 'finished', outcome: 'accepted' }),
        makeEvent(3, { opId: 'op-a', phase: 'finished', outcome: 'accepted' }),
      ],
      complete: false,
    })
    expectFail(() => validateRecording(doubleFinish), 'opId')
  })

  it('forbids dangling started operations when complete is true but allows them when complete is false', () => {
    const dangling = makePair(1, 'training.create', 'op-create')
    const openEnded = makeFile({ events: [...dangling, makeEvent(3, { opId: 'op-open', phase: 'started' })], checkpoints: [makeCheckpoint(2, { id: 'cp-1' })], complete: false })
    expect(() => validateRecording(openEnded)).not.toThrow()

    expectFail(() => validateRecording({ ...openEnded, complete: true }), 'complete')
  })
})

describe('checkpoint references and uniqueness', () => {
  it('rejects events referencing a missing checkpoint id', () => {
    const file = makeFile()
    file.events[3].checkpointId = 'cp-missing'
    expectFail(() => validateRecording(file), '检查点')
  })

  it('rejects checkpoints whose segmentId never appears in events', () => {
    const file = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', segmentId: 'seg-9' })] })
    expectFail(() => validateRecording(file), 'segmentId')
  })

  it('rejects duplicate checkpoint ids', () => {
    const file = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1' }), makeCheckpoint(4, { id: 'cp-1' })] })
    expectFail(() => validateRecording(file), '重复')
  })

  it('rejects afterSeq outside 0..eventCount', () => {
    expectFail(() => validateRecording(makeFile({ checkpoints: [makeCheckpoint(5, { id: 'cp-1' })] })), 'afterSeq')
    expectFail(() => validateRecording(makeFile({ checkpoints: [makeCheckpoint(-1, { id: 'cp-1' })] })), 'afterSeq')
    expectFail(() => validateRecording(makeFile({ checkpoints: [makeCheckpoint(1.5, { id: 'cp-1' })] })), 'afterSeq')
  })
})

describe('bars and drawings', () => {
  it('rejects malformed bar dates including impossible calendar days', () => {
    const slashed = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ bars: [{ date: '2026/03/31', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] }) })] })
    expectFail(() => validateRecording(slashed), 'YYYY-MM-DD')

    const impossible = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ bars: [{ date: '2026-02-30', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] }) })] })
    expectFail(() => validateRecording(impossible), '日历')
  })

  it('rejects non-finite or non-numeric OHLC volume and amount', () => {
    const nanOpen = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ bars: [{ date: CURRENT_DATE, open: Number.NaN, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] }) })] })
    expectFail(() => validateRecording(nanOpen), '有限')

    const stringAmount = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ bars: [{ date: CURRENT_DATE, open: 1, high: 1, low: 1, close: 1, volume: 1, amount: '100' as unknown as number }] }) })] })
    expectFail(() => validateRecording(stringAmount), 'amount')
  })

  it('rejects non-finite drawing points and duplicate drawing ids within one checkpoint', () => {
    const infinitePoint = makeFile({
      checkpoints: [makeCheckpoint(4, {
        id: 'cp-1',
        chart: makeChart({ drawings: [{ id: 'd1', name: 'segment', paneId: 'candle_pane', points: [{ timestamp: Number.POSITIVE_INFINITY, value: 10 }] }] }),
      })],
    })
    expectFail(() => validateRecording(infinitePoint), '有限')

    const drawing: Drawing = { id: 'dup', name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1, value: 1 }] }
    const duplicated = makeFile({
      checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ drawings: [drawing, { ...drawing }] }) })],
    })
    expectFail(() => validateRecording(duplicated), '重复')
  })

  it('rejects non-object drawing styles and non-numeric pane heights', () => {
    const styles = makeFile({
      checkpoints: [makeCheckpoint(4, {
        id: 'cp-1',
        chart: makeChart({ drawings: [{ id: 'd1', name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1, value: 1 }], styles: [1, 2] as unknown as Record<string, unknown> }] }),
      })],
    })
    expectFail(() => validateRecording(styles), 'styles')

    const heights = makeFile({
      checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ view: { fromTimestamp: null, toTimestamp: null, barSpace: 8, paneHeights: { candle_pane: Number.NaN } } }) })],
    })
    expectFail(() => validateRecording(heights), 'paneHeights')
  })
})

describe('snapshot account and metadata', () => {
  it('rejects non-finite account numbers and missing account fields', () => {
    const nanCash = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot({ account: { cash: Number.NaN, shares: 0, availableShares: 0, costPrice: null, marketValue: 0, equity: 0 } }) })] })
    expectFail(() => validateRecording(nanCash), 'cash')

    const missing = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot({ account: { cash: 1, shares: 0, availableShares: 0, costPrice: null, marketValue: 0 } as unknown as TrainingSnapshot['account'] }) })] })
    expectFail(() => validateRecording(missing), 'equity')
  })

  it('rejects invalid enums and date formats in training meta and trades', () => {
    const snapshot = makeSnapshot()
    snapshot.trades = [{ seq: 1, date: '2026-03-30', side: 'long' as unknown as 'buy', price: 10, shares: 100, amount: 1000, fee: 5 }]
    expectFail(() => validateRecording(makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: snapshot })] })), 'side')

    const tier = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot() })] })
    ;(((tier.checkpoints[0] as { training: TrainingSnapshot | null })!.training as TrainingSnapshot).training as { tier: unknown }).tier = '4M'
    expectFail(() => validateRecording(tier), 'tier')

    const status = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot() })] })
    ;(((status.checkpoints[0] as { training: TrainingSnapshot | null })!.training as TrainingSnapshot).training as { status: unknown }).status = 'closed'
    expectFail(() => validateRecording(status), 'status')

    const adjust = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot() })] })
    ;(((adjust.checkpoints[0] as { training: TrainingSnapshot | null })!.training as TrainingSnapshot).training as { adjustMode: unknown }).adjustMode = 'backward'
    expectFail(() => validateRecording(adjust), 'adjustMode')

    const startDate = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot() })] })
    ;(((startDate.checkpoints[0] as { training: TrainingSnapshot | null })!.training as TrainingSnapshot).training as { startDate: unknown }).startDate = '2026.01.05'
    expectFail(() => validateRecording(startDate), 'startDate')

    const currentDate = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot() })] })
    ;(((currentDate.checkpoints[0] as { training: TrainingSnapshot | null })!.training as TrainingSnapshot).training as { currentDate: unknown }).currentDate = '2026/03/31'
    expectFail(() => validateRecording(currentDate), 'currentDate')
  })
})

describe('bars cutoff against training current date', () => {
  function withBars(timeframe: ChartCapture['timeframe'], date: string): RecordingFile {
    return makeFile({
      checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart: makeChart({ timeframe, bars: [{ date, open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] }) })],
    })
  }

  it('accepts daily bars up to and including currentDate', () => {
    expect(() => validateRecording(withBars('1D', CURRENT_DATE))).not.toThrow()
  })

  it('rejects daily bars after currentDate', () => {
    expectFail(() => validateRecording(withBars('1D', '2026-04-01')), 'currentDate')
  })

  it('treats weekly and monthly dates as period starts that must not cross the boundary', () => {
    expect(() => validateRecording(withBars('1W', '2026-03-30'))).not.toThrow()
    expectFail(() => validateRecording(withBars('1W', '2026-04-06')), 'currentDate')
    expect(() => validateRecording(withBars('1M', '2026-03-01'))).not.toThrow()
    expectFail(() => validateRecording(withBars('1M', '2026-04-01')), 'currentDate')
  })

  it('falls back to startDate as the cutoff when currentDate is null so blind mode cannot smuggle future bars', () => {
    const blind = makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', training: makeSnapshot() })] })
    const meta = ((blind.checkpoints[0] as { training: TrainingSnapshot | null })!.training as TrainingSnapshot).training as { currentDate: unknown; blind: unknown }
    meta.currentDate = null
    meta.blind = true
    const chart = (blind.checkpoints[0] as { chart: ChartCapture | null }).chart as ChartCapture

    chart.bars = [{ date: '2026-01-05', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }]
    expect(() => validateRecording(blind)).not.toThrow()

    chart.bars = [{ date: '2026-06-01', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }]
    expectFail(() => validateRecording(blind), 'startDate')
  })
})

describe('gaps ordering and range', () => {
  it('accepts ordered gaps including a leading from-the-start gap and adjacent resumes', () => {
    expect(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: 3 }, { afterSeq: 3, resumedAtSeq: 4 }] }))).not.toThrow()
    expect(() => validateRecording(makeFile({ gaps: [{ afterSeq: 0, resumedAtSeq: 1 }] }))).not.toThrow()
    expect(() => validateRecording(makeFile({ events: makeBulkEvents(6), gaps: [{ afterSeq: 2, resumedAtSeq: 4 }, { afterSeq: 4, resumedAtSeq: 6 }] }))).not.toThrow()
  })

  it('rejects gaps out of order or with duplicate afterSeq, so afterSeq 0 can only lead', () => {
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 3, resumedAtSeq: 4 }, { afterSeq: 2, resumedAtSeq: 3 }] })), '递增')
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: 3 }, { afterSeq: 2, resumedAtSeq: 4 }] })), '递增')
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: 3 }, { afterSeq: 0, resumedAtSeq: null }] })), 'afterSeq')
  })

  it('rejects overlapping gaps', () => {
    expectFail(() => validateRecording(makeFile({ events: makeBulkEvents(6), gaps: [{ afterSeq: 2, resumedAtSeq: 4 }, { afterSeq: 3, resumedAtSeq: 5 }] })), '重叠')
  })

  it('requires an open gap to be last and to forbid complete', () => {
    expect(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: 3 }, { afterSeq: 3, resumedAtSeq: null }], complete: false }))).not.toThrow()
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: null }, { afterSeq: 3, resumedAtSeq: 4 }] })), '末尾')
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: null }], complete: true })), 'complete')
  })

  it('rejects gap seqs outside event ranges', () => {
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 5, resumedAtSeq: null }] })), 'afterSeq')
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: 2 }] })), 'afterSeq')
    expectFail(() => validateRecording(makeFile({ gaps: [{ afterSeq: 2, resumedAtSeq: 5 }] })), 'resumedAtSeq')
  })

  it('accepts the enabled=false initial state and round-trips it without fabricated events', () => {
    const file = makeFile({
      events: [],
      checkpoints: [makeCheckpoint(0, { training: null, chart: null, segmentId: 'seg-bootstrap' })],
      gaps: [{ afterSeq: 0, resumedAtSeq: null }],
      complete: false,
    })
    expect(validateRecording(file)).toBeDefined()
    expect(parseRecording(exportRecording(file))).toEqual(file)
  })

  it('accepts the normal initial checkpoint state and round-trips it', () => {
    const file = makeFile({
      events: [],
      checkpoints: [makeCheckpoint(0, { training: null, chart: null })],
      gaps: [],
      complete: false,
    })
    expect(validateRecording(file)).toBeDefined()
    expect(parseRecording(exportRecording(file))).toEqual(file)
  })
})

describe('capacity limits', () => {
  it('accepts exactly 50000 events and 2000 checkpoints', () => {
    const file = makeFile({
      events: makeBulkEvents(50000),
      checkpoints: Array.from({ length: 2000 }, (_, index) => makeCheckpoint(4, { id: `cp-${index}`, training: null, chart: null })),
      complete: true,
    })
    expect(() => validateRecording(file)).not.toThrow()
  }, 20000)

  it('rejects 50001 events', () => {
    expectFail(() => validateRecording(makeFile({ events: makeBulkEvents(50001), checkpoints: [], complete: false })), '50000')
  })

  it('rejects 2001 checkpoints', () => {
    const file = makeFile({
      checkpoints: Array.from({ length: 2001 }, (_, index) => makeCheckpoint(4, { id: `cp-${index}`, training: null, chart: null })),
    })
    expectFail(() => validateRecording(file), '2000')
  })
})

function fileWithChart(chart: ChartCapture): RecordingFile {
  return validateRecording(makeFile({ checkpoints: [makeCheckpoint(4, { id: 'cp-1', chart })] }))
}

function drawingOf(id: string, name: string, paneId: string, pointCount = 1): Drawing {
  return {
    id,
    name,
    paneId,
    points: Array.from({ length: pointCount }, (_, index) => ({ timestamp: 1000 + index, value: 10 })),
  }
}

describe('opId pairing consistency and elapsedMs', () => {
  it('rejects started/finished with mismatched action source or segmentId', () => {
    const action = makeFile()
    action.events[2].action = 'training.create'
    expectFail(() => validateRecording(action), 'action')

    const source = makeFile()
    source.events[2].source = 'system'
    expectFail(() => validateRecording(source), 'source')

    const segment = makeFile()
    segment.events[2].segmentId = 'seg-2'
    expectFail(() => validateRecording(segment), 'segmentId')
  })

  it('requires outcome on finished and forbids it on started', () => {
    const missing = makeFile()
    delete (missing.events[3] as Partial<RecordingEvent>).outcome
    expectFail(() => validateRecording(missing), 'outcome')

    const started = makeFile()
    started.events[2].outcome = 'accepted'
    expectFail(() => validateRecording(started), 'started')
  })

  it('enforces globally non-decreasing elapsedMs across events', () => {
    const decreasing = makeFile()
    decreasing.events[3].elapsedMs = decreasing.events[2].elapsedMs - 1000
    expectFail(() => validateRecording(decreasing), 'elapsedMs')

    const equal = makeFile()
    equal.events[3].elapsedMs = equal.events[2].elapsedMs
    expect(() => validateRecording(equal)).not.toThrow()
  })
})

describe('checkpoint ordering and reference direction', () => {
  it('rejects checkpoints whose afterSeq decreases', () => {
    expectFail(() => validateRecording(makeFile({
      checkpoints: [makeCheckpoint(4, { id: 'cp-1' }), makeCheckpoint(2, { id: 'cp-2' })],
    })), 'afterSeq')
  })

  it('rejects an event referencing a checkpoint captured after the event', () => {
    const file = makeFile()
    file.events[1].checkpointId = 'cp-1'
    expectFail(() => validateRecording(file), '未来')
  })

  it('allows an initial afterSeq=0 checkpoint with a segment that never appears in events', () => {
    const file = makeFile({ checkpoints: [makeCheckpoint(0, { id: 'cp-1', segmentId: 'seg-bootstrap' })] })
    expect(() => validateRecording(file)).not.toThrow()
  })
})

describe('positivity and chart payload limits', () => {
  it('requires positive viewport dpr barSpace and pane heights', () => {
    expectFail(() => validateRecording(makeFile({ environment: { timezone: 'Asia/Shanghai', viewport: { width: 0, height: 1080 }, dpr: 1 } })), 'width')
    expectFail(() => validateRecording(makeFile({ environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: -1 }, dpr: 1 } })), 'height')
    expectFail(() => validateRecording(makeFile({ environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 }, dpr: 0 } })), 'dpr')
    expectFail(() => fileWithChart(makeChart({ view: { fromTimestamp: null, toTimestamp: null, barSpace: 0, paneHeights: { candle_pane: 400 } } })), 'barSpace')
    expectFail(() => fileWithChart(makeChart({ view: { fromTimestamp: null, toTimestamp: null, barSpace: 8, paneHeights: { candle_pane: 0 } } })), 'paneHeights')
  })

  it('requires bars strictly increasing by date', () => {
    expect(() => fileWithChart(makeChart({ bars: [
      { date: '2026-03-30', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-03-31', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ] }))).not.toThrow()
    expectFail(() => fileWithChart(makeChart({ bars: [
      { date: '2026-03-31', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-03-31', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ] })), '递增')
    expectFail(() => fileWithChart(makeChart({ bars: [
      { date: '2026-03-31', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-03-30', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ] })), '递增')
  })

  it('caps drawings at 500 per capture and points at 256 per drawing', () => {
    expect(() => fileWithChart(makeChart({ drawings: Array.from({ length: 500 }, (_, index) => drawingOf(`d-${index}`, 'segment', 'candle_pane')) }))).not.toThrow()
    expectFail(() => fileWithChart(makeChart({ drawings: Array.from({ length: 501 }, (_, index) => drawingOf(`d-${index}`, 'segment', 'candle_pane')) })), '500')
    expect(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', 'polyline', 'candle_pane', 256)] }))).not.toThrow()
    expectFail(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', 'polyline', 'candle_pane', 257)] })), '256')
  })

  it('restricts drawing panes and names to the registered draw tools, rejecting engine drawings', () => {
    for (const pane of ['candle_pane', 'VOL', 'MACD']) {
      expect(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', 'segment', pane)] }))).not.toThrow()
    }
    expectFail(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', 'segment', 'MAIN')] })), 'pane')
    for (const tool of DRAW_TOOLS) {
      expect(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', tool.name, 'VOL')] }))).not.toThrow()
    }
    expectFail(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', 'bsMark', 'candle_pane')] })), 'name')
    expectFail(() => fileWithChart(makeChart({ drawings: [drawingOf('d-1', 'costLine', 'candle_pane')] })), 'name')
  })
})

describe('monthly month-key bars', () => {
  it('accepts real YYYY-MM monthly bars for ordering and cutoff via month-start normalization', () => {
    expect(() => fileWithChart(makeChart({ timeframe: '1M', bars: [
      { date: '2026-02', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-03', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ] }))).not.toThrow()
    expectFail(() => fileWithChart(makeChart({ timeframe: '1M', bars: [
      { date: '2026-02', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-02', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ] })), '递增')
    expectFail(() => fileWithChart(makeChart({ timeframe: '1M', bars: [
      { date: '2026-03', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-04', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ] })), 'currentDate')
  })

  it('keeps daily and weekly bars on full dates', () => {
    expectFail(() => fileWithChart(makeChart({ timeframe: '1D', bars: [{ date: '2026-03', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] })), 'YYYY-MM-DD')
    expectFail(() => fileWithChart(makeChart({ timeframe: '1W', bars: [{ date: '2026-03', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }] })), 'YYYY-MM-DD')
  })
})

describe('parse and export entries', () => {
  it('rejects invalid JSON text and non-string input', () => {
    expectFail(() => parseRecording('{'), 'JSON')
    expectFail(() => parseRecording(JSON.stringify([1, 2])), '对象')
    expectFail(() => parseRecording(42 as unknown as string), '字符串')
  })

  it('enforces the 25MiB size limit at the parse entry with the boundary accepted', () => {
    const over = JSON.stringify('a'.repeat(25 * MIB - 1))
    expectFail(() => parseRecording(over), '大小')

    const exact = JSON.stringify('a'.repeat(25 * MIB - 2))
    expectFail(() => parseRecording(exact), '对象')
  }, 20000)

  it('exports a validated JSON string that parses back identically', () => {
    const file = makeFile()
    const text = exportRecording(file)
    expect(typeof text).toBe('string')
    expect(parseRecording(text)).toEqual(file)
  })

  it('refuses to export a file carrying NaN instead of silently writing null', () => {
    const file = makeFile()
    setParams(file.events[0], { price: Number.NaN })
    expectFail(() => exportRecording(file), '有限')
  })
})
