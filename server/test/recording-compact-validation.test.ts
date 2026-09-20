import { describe, expect, it } from 'vitest'
import type { Bar } from '../../web/src/api'
import { CompactBuilder, compactRecording } from '../../web/src/recording/compactCodec'
import type { CompactRecordingFile, CompactResources } from '../../web/src/recording/compactTypes'
import { validateCompactRecording } from '../../web/src/recording/compactValidation'
import type {
  ChartCapture,
  RecordingCheckpoint,
  RecordingEvent,
  RecordingFile,
  TrainingSnapshot,
} from '../../web/src/recording/types'
import { validateRecording } from '../../web/src/recording/validation'

const CURRENT_DATE = '2026-03-31'

function dateStr(offset: number): string {
  return new Date(Date.UTC(2020, 0, 1 + offset)).toISOString().slice(0, 10)
}

function bar(date: string, close = 10): Bar {
  return { date, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1000, amount: 10500 }
}

function makeSnapshot(overrides: Partial<TrainingSnapshot['training']> = {}): TrainingSnapshot {
  return {
    training: {
      id: 7,
      tier: '6M',
      code: '600000',
      name: '浦发银行',
      market: 'SH',
      startDate: '2025-12-01',
      plannedEnd: '2026-06-01',
      currentDate: CURRENT_DATE,
      status: 'running',
      settleDate: null,
      earlySettle: false,
      blind: false,
      adjustMode: 'forward',
      initialCash: 100000,
      createdAt: '2026-01-01T08:00:00.000Z',
      ...overrides,
    },
    account: {
      cash: 95000,
      shares: 500,
      availableShares: 500,
      costPrice: 10,
      marketValue: 5000,
      equity: 100000,
    },
    trades: [],
  }
}

function makeChart(bars: Bar[], timeframe: ChartCapture['timeframe'] = '1D'): ChartCapture {
  return {
    timeframe,
    bars,
    drawings: [],
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: null,
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

function makePair(seq: number, opId: string): RecordingEvent[] {
  return [
    makeEvent(seq, { opId, phase: 'started' }),
    makeEvent(seq + 1, { opId, phase: 'finished', outcome: 'accepted', result: null }),
  ]
}

function makeCheckpointInput(
  parts: { training?: TrainingSnapshot | null; chart?: ChartCapture | null; context?: Record<string, unknown> | null; id?: string; afterSeq?: number } = {},
): RecordingCheckpoint {
  return {
    id: parts.id ?? 'cp-1',
    afterSeq: parts.afterSeq ?? 2,
    segmentId: 'seg-1',
    capturedAt: '2026-03-31T15:00:00.000Z',
    training: parts.training ?? null,
    chart: parts.chart ?? null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: (parts.context ?? null) as RecordingCheckpoint['context'],
  }
}

function makeV1Checkpoint(index: number): RecordingCheckpoint {
  return {
    id: `cp-${index}`,
    afterSeq: 4,
    segmentId: 'seg-1',
    capturedAt: '2026-03-31T15:00:00.000Z',
    training: null,
    chart: null,
    ui: { theme: 'light', tool: null, magnet: 'off', multiSelect: false },
    context: null,
  }
}

function makeV1File(overrides: Partial<RecordingFile> = {}): RecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 1,
    sessionId: 'session-1',
    createdAt: '2026-01-05T09:30:00.000Z',
    app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: false, chartLibrary: 'klinecharts@10.0.3' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 }, dpr: 1 },
    trainingKey: '000001-SZ-3M',
    events: [
      ...makePair(1, 'op-create'),
      makeEvent(3, { opId: 'op-advance', phase: 'started' }),
      makeEvent(4, { opId: 'op-advance', phase: 'finished', outcome: 'accepted', result: null, checkpointId: 'cp-1' }),
    ],
    checkpoints: [
      makeCheckpointInput({
        id: 'cp-1',
        afterSeq: 4,
        training: makeSnapshot(),
        chart: makeChart([bar(CURRENT_DATE)]),
        context: { rules: { t1: true }, rights: [{ date: '2026-02-01', dividend: 0.5 }] },
      }),
    ],
    gaps: [],
    complete: true,
    ...overrides,
  }
}

function emptyResources(): CompactResources {
  return { series: [], drawings: [], trainingMeta: [], accounts: [], trades: [], contexts: [] }
}

function makeCompactFile(overrides: Partial<CompactRecordingFile> = {}): CompactRecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 2,
    sessionId: 'session-1',
    createdAt: '2026-01-05T09:30:00.000Z',
    app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: false, chartLibrary: 'klinecharts@10.0.3' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 }, dpr: 1 },
    trainingKey: '000001-SZ-3M',
    events: makePair(1, 'op-1'),
    checkpoints: [minimalCheckpoint('cp-0')],
    gaps: [],
    complete: true,
    resources: emptyResources(),
    ...overrides,
  }
}

type CompactCheckpoint = CompactRecordingFile['checkpoints'][number]

function minimalCheckpoint(id: string, overrides: Partial<CompactCheckpoint> = {}): CompactCheckpoint {
  return {
    id,
    afterSeq: 0,
    segmentId: 'seg-0',
    capturedAt: '2026-03-31T15:00:00.000Z',
    training: null,
    chart: null,
    ui: { theme: 'light', tool: null, magnet: 'off', multiSelect: false },
    contextRef: null,
    ...overrides,
  }
}

/** 手工组装的最小行情版本（无训练截止约束时 asOf 传 null） */
function seriesVersion(overrides: Partial<Extract<CompactResources['series'][number], { base: null }>> = {}): CompactResources['series'][number] {
  return {
    id: 's1',
    timeframe: '1D',
    asOf: null,
    firstCheckpoint: 0,
    base: null,
    bars: [bar(dateStr(0))],
    ...overrides,
  }
}

function chartRef(seriesRef: string, drawingsRef = 'dw1'): NonNullable<CompactRecordingFile['checkpoints'][number]['chart']> {
  return {
    timeframe: '1D',
    seriesRef,
    drawingsRef,
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: null,
  }
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

describe('compact validation acceptance', () => {
  it('accepts compactRecording output of a valid v1 session and returns the input as-is', () => {
    const compact = compactRecording(makeV1File())
    const result = validateCompactRecording(compact)
    expect(result).toBe(compact)
    expect(result.resources.series).toHaveLength(1)
    expect(result.resources.contexts).toHaveLength(1)
  })

  it('accepts 10000 viewport checkpoints sharing one series without charging restore per reference', () => {
    const builder = new CompactBuilder()
    const chart = makeChart([bar(dateStr(0)), bar(dateStr(1))])
    const training = makeSnapshot()
    const context = { rules: { r1: true } }
    const checkpoints = Array.from({ length: 10000 }, (_, index) =>
      builder.capture(
        makeCheckpointInput({
          id: `cp-${index}`,
          afterSeq: 2,
          training,
          chart,
          context,
        }),
      ),
    )
    const file = makeCompactFile({ checkpoints, resources: builder.getResources() })
    const result = validateCompactRecording(file)
    expect(result.resources.series).toHaveLength(1)
    expect(result.checkpoints).toHaveLength(10000)
  })

  it('accepts exactly 20000 minimal checkpoints and rejects 20001', () => {
    const checkpoints = Array.from({ length: 20000 }, (_, index) => minimalCheckpoint(`cp-${index}`))
    expect(() => validateCompactRecording(makeCompactFile({ checkpoints }))).not.toThrow()
    checkpoints.push(minimalCheckpoint('cp-20000'))
    expect(() => validateCompactRecording(makeCompactFile({ checkpoints }))).toThrow('超过上限 20000')
  })
})

describe('v1 migration budget option', () => {
  function bigV1File(): RecordingFile {
    return makeV1File({ checkpoints: Array.from({ length: 2001 }, (_, index) => makeV1Checkpoint(index)) })
  }

  it('keeps the old 2000 default but allows maxCheckpoints=20000 for migration', () => {
    const file = bigV1File()
    expect(() => validateRecording(file)).toThrow('超过上限 2000')
    expect(() => validateRecording(file, { maxCheckpoints: 20000 })).not.toThrow()
  })

  it('never reads the budget from the imported file content', () => {
    const file = bigV1File() as RecordingFile & { maxCheckpoints?: number }
    file.maxCheckpoints = 20000
    expect(() => validateRecording(file)).toThrow('超过上限 2000')
  })

  it('migrates the large v1 session to compact and validates under the v2 budget', () => {
    const compact = compactRecording(bigV1File())
    expect(() => validateCompactRecording(compact)).not.toThrow()
  })
})

describe('resource references and ids', () => {
  it('rejects checkpoints referencing missing series drawings meta account trade or context resources', () => {
    const base = { series: [seriesVersion()], drawings: [{ id: 'dw1', base: null, items: [] }] } as Partial<CompactResources>
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s999') })], resources: { ...emptyResources(), ...base } })),
    's999')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s1', 'dw9') })], resources: { ...emptyResources(), ...base } })),
    'dw9')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', training: { metaRef: 'm9', accountRef: 'a1', tradeRefs: [] } })],
        resources: { ...emptyResources(), accounts: [{ id: 'a1', value: makeSnapshot().account }] },
      })),
    'm9')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', training: { metaRef: 'm1', accountRef: 'a1', tradeRefs: ['t9'] } })],
        resources: { ...emptyResources(), trainingMeta: [{ id: 'm1', value: makeSnapshot().training }], accounts: [{ id: 'a1', value: makeSnapshot().account }] },
      })),
    't9')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { contextRef: 'x9' })] })),
    'x9')
  })

  it('rejects duplicate resource ids inside one table', () => {
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        resources: { ...emptyResources(), series: [seriesVersion(), seriesVersion()] },
      })),
    '行情版本id重复')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        resources: { ...emptyResources(), drawings: [{ id: 'dw1', base: null, items: [] }, { id: 'dw1', base: null, items: [] }] },
      })),
    '画线版本id重复')
  })
})

describe('series base chains', () => {
  it('rejects forward base references so cycles cannot exist', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's2', upsert: [], remove: [] },
      { id: 's2', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: null, bars: [bar(dateStr(0))] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '基础版本必须先出现')
  })

  it('rejects missing base references', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's0', upsert: [], remove: [] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '引用的基础版本不存在')
  })

  it('allows a 31-level delta chain and rejects the 32nd level', () => {
    const build = (deltas: number) => {
      const resources = { ...emptyResources() }
      const series: CompactResources['series'] = [
        { id: 's0', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: null, bars: [bar(dateStr(0))] },
      ]
      for (let i = 1; i <= deltas; i += 1) {
        series.push({ id: `s${i}`, timeframe: '1D', asOf: null, firstCheckpoint: 0, base: `s${i - 1}`, upsert: [bar(dateStr(i))], remove: [] })
      }
      resources.series = series
      return makeCompactFile({ checkpoints: [minimalCheckpoint('cp-0')], resources })
    }
    expect(() => validateCompactRecording(build(31))).not.toThrow()
    expectFail(() => validateCompactRecording(build(32)), '超过上限 31')
  })

  it('rejects cross-timeframe base references', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      seriesVersion({ id: 's0' }),
      { id: 's1', timeframe: '1W', asOf: null, firstCheckpoint: 0, base: 's0', upsert: [bar(dateStr(1))], remove: [] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '周期必须一致')
  })
})

describe('firstCheckpoint and asOf protection', () => {
  it('rejects firstCheckpoint outside the checkpoint array and later-than-referencing checkpoints', () => {
    const resources = { ...emptyResources(), series: [seriesVersion({ firstCheckpoint: 5 })], drawings: [{ id: 'dw1', base: null, items: [] }] }
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s1') })], resources })),
    '须是检查点数组下标')
    const future = { ...emptyResources(), series: [seriesVersion({ firstCheckpoint: 1 })], drawings: [{ id: 'dw1', base: null, items: [] }] }
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [
          minimalCheckpoint('cp-0', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s1') }),
          minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1' }),
        ],
        resources: future,
      })),
    '不得回填未来步骤')
  })

  it('rejects monthly bars beyond a known asOf even when the month key differs only past the boundary', () => {
    const resources = { ...emptyResources(), drawings: [{ id: 'dw1', base: null, items: [] }] }
    resources.series = [
      { id: 's1', timeframe: '1M', asOf: '2026-03-05', firstCheckpoint: 0, base: null, bars: [bar('2026-02'), bar('2026-03')] },
    ]
    expect(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: { ...chartRef('s1'), timeframe: '1M' } })], resources })),
    ).not.toThrow()
    const late = { ...resources }
    late.series = [
      { id: 's1', timeframe: '1M', asOf: '2026-03-05', firstCheckpoint: 0, base: null, bars: [bar('2026-02'), bar('2026-04')] },
    ]
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: { ...chartRef('s1'), timeframe: '1M' } })], resources: late })),
    '晚于asOf')
  })

  it('rejects weekly period starts crossing a known asOf', () => {
    const resources = { ...emptyResources(), drawings: [{ id: 'dw1', base: null, items: [] }] }
    resources.series = [
      { id: 's1', timeframe: '1W', asOf: '2026-03-05', firstCheckpoint: 0, base: null, bars: [bar('2026-03-09')] },
    ]
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: { ...chartRef('s1'), timeframe: '1W' } })], resources })),
    '晚于asOf')
  })

  it('forbids known-cutoff checkpoints from referencing asOf=null or later-asOf versions', () => {
    const meta = makeSnapshot({ currentDate: '2026-03-05' }).training
    const account = makeSnapshot().account
    const build = (asOf: string | null) => {
      const resources = { ...emptyResources(), drawings: [{ id: 'dw1', base: null, items: [] }] }
      resources.series = [seriesVersion({ asOf, bars: [bar('2026-03-04')] })]
      return makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-1', {
          afterSeq: 2,
          segmentId: 'seg-1',
          training: { metaRef: 'm1', accountRef: 'a1', tradeRefs: [] },
          chart: chartRef('s1'),
        })],
        resources: { ...resources, trainingMeta: [{ id: 'm1', value: meta }], accounts: [{ id: 'a1', value: account }] },
      })
    }
    expectFail(() => validateCompactRecording(build(null)), 'asOf=null')
    expectFail(() => validateCompactRecording(build('2026-03-06')), '晚于检查点截止')
    expect(() => validateCompactRecording(build('2026-03-04'))).not.toThrow()
  })

  it('rejects a base whose known asOf is later than the derived asOf', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      { id: 's0', timeframe: '1D', asOf: '2026-03-06', firstCheckpoint: 0, base: null, bars: [bar('2026-03-05'), bar('2026-03-06')] },
      { id: 's1', timeframe: '1D', asOf: '2026-03-05', firstCheckpoint: 0, base: 's0', upsert: [bar('2026-03-05', 11)], remove: [] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '基础已知asOf不得晚于派生')
  })
})

describe('series delta semantics', () => {
  it('rejects upserts whose new keys break strict date order after resolution', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      seriesVersion({ id: 's0', bars: [bar('2026-01-05')] }),
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's0', upsert: [bar('2026-01-01')], remove: [] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '严格递增')
  })

  it('rejects non-finite bar values inside resources', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      seriesVersion({ bars: [{ ...bar(dateStr(0)), close: Number.NaN }] }),
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '数值必须有限')
  })
})

describe('json safety and drawing content', () => {
  it('rejects context nesting deeper than 40 levels', () => {
    let deep: unknown = null
    for (let i = 0; i < 41; i += 1) deep = [deep]
    const compact = compactRecording(makeV1File({ checkpoints: [makeCheckpointInput({ context: deep as RecordingCheckpoint['context'] })] }))
    expectFail(() => validateCompactRecording(compact), '嵌套深度超过 40')
  })

  it('rejects engine-reserved drawing names inside drawing versions', () => {
    const resources = { ...emptyResources() }
    resources.drawings = [
      { id: 'dw1', base: null, items: [{ id: 'd1', name: 'bsMark', paneId: 'candle_pane', points: [{ timestamp: 1, value: 10 }] }] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), 'drawTools')
  })

  it('rejects schemaVersion 1 payloads', () => {
    const v1 = makeV1File()
    expectFail(() => validateCompactRecording(v1), '必须是 2')
  })
})

describe('events gaps and pairing reuse', () => {
  it('rejects seq holes and dangling finished events in compact files', () => {
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ events: [makeEvent(2, { phase: 'finished', outcome: 'accepted' })] })),
    '必须从 1 连续递增')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ events: [makeEvent(1, { phase: 'finished', outcome: 'accepted' })] })),
    '缺少配对的 started')
  })

  it('rejects out-of-order gaps and open gaps with complete files', () => {
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ gaps: [{ afterSeq: 2, resumedAtSeq: null }, { afterSeq: 1, resumedAtSeq: 2 }] })),
    '严格递增')
    expectFail(() =>
      validateCompactRecording(makeCompactFile({ gaps: [{ afterSeq: 1, resumedAtSeq: null }] })),
    'complete 不能为 true')
  })

  it('rejects checkpoints whose afterSeq decreases', () => {
    const checkpoints = [
      minimalCheckpoint('cp-a', { afterSeq: 2, segmentId: 'seg-1' }),
      minimalCheckpoint('cp-b'),
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ checkpoints })), '非递减')
  })
})

describe('restored budgets and cross-resource consistency', () => {
  function drawing(id: string) {
    return { id, name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }] }
  }

  it('rejects a derived series whose firstCheckpoint precedes its base even when asOf is null', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      { id: 's0', timeframe: '1D', asOf: null, firstCheckpoint: 1, base: null, bars: [bar(dateStr(0))] },
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's0', upsert: [], remove: [] },
    ]
    resources.drawings = [{ id: 'dw1', base: null, items: [] }]
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [
          minimalCheckpoint('cp-0', { chart: chartRef('s1') }),
          minimalCheckpoint('cp-1', { chart: chartRef('s0') }),
        ],
        resources,
      })),
    '基础版本firstCheckpoint')
  })

  it('allows a derived series whose firstCheckpoint equals its base', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      { id: 's0', timeframe: '1D', asOf: null, firstCheckpoint: 1, base: null, bars: [bar(dateStr(0))] },
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 1, base: 's0', upsert: [bar(dateStr(1))], remove: [] },
    ]
    resources.drawings = [{ id: 'dw1', base: null, items: [] }]
    expect(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-0'), minimalCheckpoint('cp-1', { chart: chartRef('s1') })],
        resources,
      })),
    ).not.toThrow()
  })

  it('rejects a checkpoint chart timeframe that differs from the referenced series', () => {
    const resources = { ...emptyResources() }
    resources.series = [seriesVersion({ id: 's1', timeframe: '1M', bars: [bar('2026-02'), bar('2026-03')] })]
    resources.drawings = [{ id: 'dw1', base: null, items: [] }]
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s1') })],
        resources,
      })),
    '周期须与引用的行情版本一致')
  })

  it('rejects a drawing chain whose restored id set exceeds 500', () => {
    const resources = { ...emptyResources() }
    resources.series = [seriesVersion()]
    resources.drawings = [
      { id: 'dw0', base: null, items: Array.from({ length: 500 }, (_, index) => drawing(`d${index}`)) },
      { id: 'dw1', base: 'dw0', upsert: [drawing('d500')], remove: [] },
    ]
    expectFail(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s1', 'dw1') })],
        resources,
      })),
    '还原后画线数量')
  })

  it('allows drawing replace and remove deltas that keep the restored set within 500', () => {
    const resources = { ...emptyResources() }
    resources.series = [seriesVersion()]
    resources.drawings = [
      { id: 'dw0', base: null, items: Array.from({ length: 500 }, (_, index) => drawing(`d${index}`)) },
      { id: 'dw1', base: 'dw0', upsert: [drawing('d0'), drawing('d1')], remove: [] },
      { id: 'dw2', base: 'dw1', upsert: [drawing('d-new')], remove: ['d2'] },
    ]
    expect(() =>
      validateCompactRecording(makeCompactFile({
        checkpoints: [minimalCheckpoint('cp-1', { afterSeq: 2, segmentId: 'seg-1', chart: chartRef('s1', 'dw2') })],
        resources,
      })),
    ).not.toThrow()
  })

  it('rejects a delta whose restored bar array exceeds 20000', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      seriesVersion({ id: 's0', bars: Array.from({ length: 20000 }, (_, index) => bar(dateStr(index))) }),
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's0', upsert: [bar(dateStr(20000))], remove: [] },
    ]
    expectFail(() => validateCompactRecording(makeCompactFile({ resources })), '还原后bar数量')
  })

  it('allows replace and remove deltas that keep restored bars within 20000', () => {
    const resources = { ...emptyResources() }
    resources.series = [
      seriesVersion({ id: 's0', bars: Array.from({ length: 20000 }, (_, index) => bar(dateStr(index))) }),
      { id: 's1', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's0', upsert: [bar(dateStr(0), 11)], remove: [] },
      { id: 's2', timeframe: '1D', asOf: null, firstCheckpoint: 0, base: 's1', upsert: [bar(dateStr(20000))], remove: [dateStr(1)] },
    ]
    expect(() => validateCompactRecording(makeCompactFile({ resources }))).not.toThrow()
  })
})
