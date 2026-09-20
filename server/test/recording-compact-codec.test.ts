import { describe, expect, it } from 'vitest'
import {
  CompactBuilder,
  CompactReader,
  compactRecording,
} from '../../web/src/recording/compactCodec'
import type {
  CompactCheckpoint,
  CompactRecordingFile,
  CompactResources,
} from '../../web/src/recording/compactTypes'
import type { Bar, TrainingSnapshot } from '../../web/src/api'
import type { Drawing } from '../../web/src/drawingState'
import type {
  ChartCapture,
  RecordingCheckpoint,
  RecordingFile,
} from '../../web/src/recording/types'

function dateStr(offset: number): string {
  return new Date(Date.UTC(2020, 0, 1 + offset)).toISOString().slice(0, 10)
}

function makeBars(count: number, offset0 = 0, closeBase = 10): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    date: dateStr(offset0 + i),
    open: closeBase,
    high: closeBase + 1,
    low: closeBase - 1,
    close: closeBase + (offset0 + i) * 0.1,
    volume: 1000 + i,
    amount: 10500 + i,
  }))
}

function cloneBars(bars: Bar[]): Bar[] {
  return JSON.parse(JSON.stringify(bars)) as Bar[]
}

function makeTraining(overrides: Partial<TrainingSnapshot['training']> = {}): TrainingSnapshot {
  return {
    training: {
      id: 7,
      tier: '6M',
      code: '600000',
      name: '浦发银行',
      market: 'SH',
      startDate: '2025-12-01',
      plannedEnd: '2026-06-01',
      currentDate: '2026-03-05',
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

function cloneTraining(snapshot: TrainingSnapshot): TrainingSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TrainingSnapshot
}

function makeChart(bars: Bar[], drawings: Drawing[] = [], timeframe: ChartCapture['timeframe'] = '1D'): ChartCapture {
  return {
    timeframe,
    bars,
    drawings,
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: null,
  }
}

let checkpointSeq = 0

function makeCheckpoint(
  parts: {
    training?: TrainingSnapshot | null
    chart?: ChartCapture | null
    context?: Record<string, unknown> | null
    capturedAt?: string
  } = {},
): RecordingCheckpoint {
  checkpointSeq += 1
  return {
    id: `cp-${checkpointSeq}`,
    afterSeq: checkpointSeq * 2,
    segmentId: 'seg-1',
    capturedAt: parts.capturedAt ?? `2026-03-05T10:00:${String(checkpointSeq).padStart(2, '0')}.000Z`,
    training: parts.training ?? null,
    chart: parts.chart ?? null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: (parts.context ?? null) as RecordingCheckpoint['context'],
  }
}

/** 沿基础链计算某行情版本真实增量层数（不信任builder计数） */
function seriesChainDepth(resources: CompactResources, id: string): number {
  let depth = 0
  const seen = new Set<string>()
  let current = resources.series.find(v => v.id === id)
  while (current) {
    if (seen.has(current.id)) throw new Error(`循环引用：${current.id}`)
    seen.add(current.id)
    if (current.base === null) break
    depth += 1
    const next = resources.series.find(v => v.id === current?.base)
    if (!next) throw new Error(`基础版本不存在：${current.base}`)
    current = next
  }
  return depth
}

function maxSeriesChainDepth(resources: CompactResources): number {
  return Math.max(...resources.series.map(v => seriesChainDepth(resources, v.id)))
}

function assembleFile(checkpoints: CompactCheckpoint[], resources: CompactResources): CompactRecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 2,
    sessionId: 'sess-1',
    createdAt: '2026-03-05T09:00:00.000Z',
    app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    trainingKey: '600000|2025-12-01',
    events: [],
    checkpoints,
    gaps: [],
    complete: true,
    resources,
  }
}

describe('CompactBuilder series 增量', () => {
  it('几千bar共享内容，日增1条只追加1条patch', () => {
    const builder = new CompactBuilder()
    const bars0 = makeBars(3000)
    const cp0 = makeCheckpoint({ chart: makeChart(bars0) })
    const bars1 = [...cloneBars(bars0), ...makeBars(1, 3000)]
    const cp1 = makeCheckpoint({ chart: makeChart(bars1) })
    const c0 = builder.capture(cp0)
    const c1 = builder.capture(cp1)
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(2)
    const [v0, v1] = resources.series
    expect(v0.base).toBeNull()
    expect(v0.bars).toHaveLength(3000)
    expect(v1.base).toBe(v0.id)
    if (!('upsert' in v1)) throw new Error('v1 应为增量版本')
    expect(v1.upsert).toHaveLength(1)
    expect(v1.remove).toHaveLength(0)
    expect(c0.chart?.seriesRef).toBe(v0.id)
    expect(c1.chart?.seriesRef).toBe(v1.id)

    const reader = new CompactReader(assembleFile([c0, c1], resources))
    expect(reader.checkpointAt(0).chart?.bars).toEqual(bars0)
    expect(reader.checkpointAt(1).chart?.bars).toEqual(bars1)
  })

  it('复权旧bar变值按日期upsert并保留两个观察版本', () => {
    const builder = new CompactBuilder()
    const bars0 = makeBars(100)
    const c0 = builder.capture(makeCheckpoint({ chart: makeChart(bars0) }))
    const bars1 = cloneBars(bars0)
    bars1[50] = { ...bars1[50], open: 8, high: 9, low: 7, close: 8.5, volume: 1, amount: 2 }
    const c1 = builder.capture(makeCheckpoint({ chart: makeChart(bars1) }))
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(2)
    const v1 = resources.series[1]
    if (!('upsert' in v1)) throw new Error('v1 应为增量版本')
    expect(v1.upsert).toEqual([bars1[50]])
    expect(v1.remove).toHaveLength(0)
    const reader = new CompactReader(assembleFile([c0, c1], resources))
    expect(reader.checkpointAt(0).chart?.bars[50]).toEqual(bars0[50])
    expect(reader.checkpointAt(1).chart?.bars[50]).toEqual(bars1[50])
    expect(resources.series[0]).toHaveProperty('bars')
  })

  it('周/月当前柱同日期键更新OHLC走upsert', () => {
    for (const timeframe of ['1W', '1M'] as const) {
      const builder = new CompactBuilder()
      const week0 = makeBars(10, 0)
      const c0 = builder.capture(makeCheckpoint({ chart: makeChart(week0, [], timeframe) }))
      const week1 = cloneBars(week0)
      week1[9] = { ...week1[9], open: 20, high: 21, low: 19, close: 20.5 }
      const c1 = builder.capture(makeCheckpoint({ chart: makeChart(week1, [], timeframe) }))
      const resources = builder.getResources()
      expect(resources.series).toHaveLength(2)
      const v1 = resources.series[1]
      if (!('upsert' in v1)) throw new Error('v1 应为增量版本')
      expect(v1.upsert).toEqual([week1[9]])
      const reader = new CompactReader(assembleFile([c0, c1], resources))
      expect(reader.checkpointAt(1).chart?.timeframe).toBe(timeframe)
      expect(reader.checkpointAt(1).chart?.bars[9]).toEqual(week1[9])
      expect(reader.checkpointAt(0).chart?.bars[9]).toEqual(week0[9])
    }
  })
})

describe('CompactBuilder 内容去重', () => {
  it('两份完全相同capture资源不增长，checkpoint时间各自保留', () => {
    const builder = new CompactBuilder()
    const bars = makeBars(50)
    const training = makeTraining()
    const context = { rules: { t1: true }, rights: [{ date: '2026-02-01', dividend: 0.5 }] }
    const cp0 = makeCheckpoint({ training, chart: makeChart(bars), context })
    const cp1 = makeCheckpoint({ training: cloneTraining(training), chart: makeChart(cloneBars(bars)), context: JSON.parse(JSON.stringify(context)) })
    const c0 = builder.capture(cp0)
    const c1 = builder.capture(cp1)
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(1)
    expect(resources.drawings).toHaveLength(1)
    expect(resources.trainingMeta).toHaveLength(1)
    expect(resources.accounts).toHaveLength(1)
    expect(resources.trades).toHaveLength(0)
    expect(resources.contexts).toHaveLength(1)
    expect(c0.capturedAt).not.toBe(c1.capturedAt)
    expect(c1.capturedAt).toBe(cp1.capturedAt)
    expect(c0.chart?.seriesRef).toBe(c1.chart?.seriesRef)
    expect(c0.training?.metaRef).toBe(c1.training?.metaRef)
    expect(c0.contextRef).toBe(c1.contextRef)
  })

  it('账户内容相同去重，trade同序号chartPrice变化保留新版本', () => {
    const builder = new CompactBuilder()
    const snapshot = makeTraining()
    const trade0 = { seq: 1, date: '2026-03-05', side: 'buy' as const, price: 10, shares: 500, amount: 5000, fee: 5, chartPrice: 10 }
    const snapshotWithTrade: TrainingSnapshot = { ...cloneTraining(snapshot), trades: [trade0] }
    const c0 = builder.capture(makeCheckpoint({ training: snapshotWithTrade }))
    const c1 = builder.capture(makeCheckpoint({ training: cloneTraining(snapshotWithTrade) }))
    const trade1 = { ...trade0, chartPrice: 10.5 }
    const c2 = builder.capture(makeCheckpoint({ training: { ...cloneTraining(snapshot), trades: [trade1] } }))
    const resources = builder.getResources()
    expect(resources.trainingMeta).toHaveLength(1)
    expect(resources.accounts).toHaveLength(1)
    expect(resources.trades).toHaveLength(2)
    expect(c0.training?.tradeRefs).toHaveLength(1)
    expect(c1.training?.tradeRefs[0]).toBe(c0.training?.tradeRefs[0])
    expect(c2.training?.tradeRefs[0]).not.toBe(c0.training?.tradeRefs[0])
    const reader = new CompactReader(assembleFile([c0, c1, c2], resources))
    expect(reader.checkpointAt(0).training?.trades[0].chartPrice).toBe(10)
    expect(reader.checkpointAt(2).training?.trades[0].chartPrice).toBe(10.5)
    expect(reader.checkpointAt(2).training?.account).toEqual(snapshot.account)
  })
})

describe('CompactBuilder drawings', () => {
  it('删除/恢复/文本样式原值保留', () => {
    const builder = new CompactBuilder()
    const drawingA: Drawing = {
      id: 'dw-a',
      name: 'horizontalLine',
      paneId: 'candle_pane',
      points: [{ timestamp: 1000, value: 10.5 }],
    }
    const drawingB: Drawing = {
      id: 'dw-b',
      name: 'segment',
      paneId: 'candle_pane',
      points: [
        { timestamp: 1000, value: 9 },
        { timestamp: 2000, value: 11 },
      ],
      styles: { color: '#ff0000', lineHeight: 2 },
      extendData: { text: '备注', tag: 'note-1' },
    }
    const drawingC: Drawing = {
      id: 'dw-c',
      name: 'horizontalLine',
      paneId: 'candle_pane',
      points: [{ timestamp: 3000, value: 12 }],
    }
    const bars = makeBars(20)
    const c0 = builder.capture(makeCheckpoint({ chart: makeChart(bars, [drawingA, drawingB, drawingC]) }))
    const c1 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(bars), [drawingA, drawingC]) }))
    const c2 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(bars), [drawingA, JSON.parse(JSON.stringify(drawingB)), drawingC]) }))
    const resources = builder.getResources()
    expect(resources.drawings).toHaveLength(2)
    const [d0, d1] = resources.drawings
    expect(d0.base).toBeNull()
    expect(d0.items).toHaveLength(3)
    if (!('remove' in d1)) throw new Error('d1 应为增量版本')
    expect(d1.remove).toEqual(['dw-b'])
    expect(d1.upsert).toHaveLength(0)
    // c2重新加回B后与d0完全同内容：复用历史版本而非追加新版本
    expect(c2.chart?.drawingsRef).toBe(d0.id)
    const reader = new CompactReader(assembleFile([c0, c1, c2], resources))
    expect(reader.checkpointAt(0).chart?.drawings).toEqual([drawingA, drawingB, drawingC])
    expect(reader.checkpointAt(1).chart?.drawings).toEqual([drawingA, drawingC])
    expect(reader.checkpointAt(2).chart?.drawings).toEqual([drawingA, drawingB, drawingC])
    expect(reader.checkpointAt(2).chart?.drawings[1].styles).toEqual({ color: '#ff0000', lineHeight: 2 })
    expect(reader.checkpointAt(2).chart?.drawings[1].extendData).toEqual({ text: '备注', tag: 'note-1' })
  })
})

describe('CompactBuilder 不可变性', () => {
  it('capture后修改输入对象不影响已记录资源与reader输出', () => {
    const builder = new CompactBuilder()
    const bars = makeBars(30)
    const drawing: Drawing = { id: 'dw-x', name: 'segment', paneId: 'p', points: [{ timestamp: 1, value: 1 }] }
    const context = { rules: { a: 1 } }
    const training = makeTraining()
    const cp = makeCheckpoint({ training, chart: makeChart(bars, [drawing]), context })
    const c0 = builder.capture(cp)
    bars[0].close = 999
    bars.push(makeBars(1, 100)[0])
    drawing.points.push({ timestamp: 2, value: 2 })
    drawing.styles = { color: 'green' }
    context.rules.a = 2
    cp.ui.theme = 'light'
    const resources = builder.getResources()
    const reader = new CompactReader(assembleFile([c0], resources))
    const restored = reader.checkpointAt(0)
    expect(restored.chart?.bars).toHaveLength(30)
    expect(restored.chart?.bars[0].close).toBe(10)
    expect(restored.chart?.drawings[0].points).toEqual([{ timestamp: 1, value: 1 }])
    expect(restored.chart?.drawings[0].styles).toBeUndefined()
    expect(restored.context).toEqual({ rules: { a: 1 } })
    expect(restored.ui.theme).toBe('dark')
  })

  it('reader输出为深拷贝，修改输出不污染后续读取', () => {
    const builder = new CompactBuilder()
    const bars = makeBars(10)
    const c0 = builder.capture(makeCheckpoint({ training: makeTraining(), chart: makeChart(bars) }))
    const reader = new CompactReader(assembleFile([c0], builder.getResources()))
    const first = reader.checkpointAt(0)
    first.chart!.bars[0].close = -1
    first.chart!.view.paneHeights['candle_pane'] = 1
    first.training!.account.cash = -1
    if (first.chart!.drawings.length) first.chart!.drawings[0].points = []
    const second = reader.checkpointAt(0)
    expect(second.chart?.bars[0].close).toBe(10)
    expect(second.chart?.view.paneHeights['candle_pane']).toBe(300)
    expect(second.chart?.bars).not.toBe(first.chart?.bars)
  })

  it('restore Builder复制传入资源并从checkpointCount继续', () => {
    const builder1 = new CompactBuilder()
    const c0 = builder1.capture(makeCheckpoint({ chart: makeChart(makeBars(10)) }))
    const c1 = builder1.capture(makeCheckpoint({ chart: makeChart(makeBars(11)) }))
    const restored = builder1.getResources()
    const seriesBefore = restored.series.length
    const builder2 = new CompactBuilder(restored, 2)
    const c2 = builder2.capture(makeCheckpoint({ chart: makeChart(makeBars(12)) }))
    expect(restored.series.length).toBe(seriesBefore)
    const resources = builder2.getResources()
    expect(resources.series).toHaveLength(seriesBefore + 1)
    const v2 = resources.series[resources.series.length - 1]
    expect(v2.firstCheckpoint).toBe(2)
    expect(v2.base).toBe(resources.series[seriesBefore - 1].id)
    if (!('upsert' in v2)) throw new Error('v2 应为增量版本')
    expect(v2.upsert).toHaveLength(1)
    const reader = new CompactReader(assembleFile([c0, c1, c2], resources))
    expect(reader.checkpointAt(0).chart?.bars).toHaveLength(10)
    expect(reader.checkpointAt(1).chart?.bars).toHaveLength(11)
    expect(reader.checkpointAt(2).chart?.bars).toHaveLength(12)
    expect(reader.checkpointAt(2).chart?.bars[11]).toEqual(makeBars(12)[11])
  })
})

describe('CompactBuilder 链深度与全量回退', () => {
  it('最多31层增量，第33个版本存新基础', () => {
    const builder = new CompactBuilder()
    const checkpoints = [makeCheckpoint({ chart: makeChart(makeBars(1)) })]
    for (let i = 1; i <= 33; i += 1) {
      checkpoints.push(makeCheckpoint({ chart: makeChart(makeBars(1 + i)) }))
    }
    const compact = checkpoints.map(cp => builder.capture(cp))
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(34)
    expect(resources.series[0].base).toBeNull()
    for (let i = 1; i <= 31; i += 1) {
      expect(resources.series[i].base).not.toBeNull()
    }
    expect(resources.series[32].base).toBeNull()
    expect(resources.series[32].bars).toHaveLength(33)
    expect(resources.series[33].base).toBe(resources.series[32].id)
    const reader = new CompactReader(assembleFile(compact, resources))
    expect(reader.checkpointAt(33).chart?.bars).toHaveLength(34)
    expect(reader.checkpointAt(31).chart?.bars).toHaveLength(32)
  })

  it('变化大于全量时存新基础', () => {
    const builder = new CompactBuilder()
    builder.capture(makeCheckpoint({ chart: makeChart(makeBars(100)) }))
    builder.capture(makeCheckpoint({ chart: makeChart(makeBars(100, 1000, 50)) }))
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(2)
    expect(resources.series[1].base).toBeNull()
    expect(resources.series[1].bars).toHaveLength(100)
  })
})

describe('CompactBuilder asOf', () => {
  it('未知截止切已知生成新版本，已知相同内容可复用，已知不引用null或更晚asOf', () => {
    const builder = new CompactBuilder()
    const bars = makeBars(10)
    const c0 = builder.capture(makeCheckpoint({ chart: makeChart(bars) }))
    const c1 = builder.capture(
      makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-05' }), chart: makeChart(cloneBars(bars)) }),
    )
    const c2 = builder.capture(
      makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-06' }), chart: makeChart(cloneBars(bars)) }),
    )
    const c3 = builder.capture(
      makeCheckpoint({ training: makeTraining({ blind: true, currentDate: null }), chart: makeChart(cloneBars(bars)) }),
    )
    const c4 = builder.capture(
      makeCheckpoint({ training: makeTraining({ currentDate: null }), chart: makeChart(cloneBars(bars)) }),
    )
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(3)
    const [v0, v1, v2] = resources.series
    expect(v0.asOf).toBeNull()
    expect(v1.asOf).toBe('2026-03-05')
    expect(v1.base).toBe(v0.id)
    expect(c0.chart?.seriesRef).toBe(v0.id)
    expect(c1.chart?.seriesRef).toBe(v1.id)
    expect(c2.chart?.seriesRef).toBe(v1.id)
    expect(c3.chart?.seriesRef).toBe(v1.id)
    expect(v2.asOf).toBe('2025-12-01')
    expect(v2.base).toBeNull()
    expect(c4.chart?.seriesRef).toBe(v2.id)
  })

  it('training的asOf依currentDate/startDate/盲态推导', () => {
    const builder = new CompactBuilder()
    builder.capture(makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-05' }), chart: makeChart(makeBars(5)) }))
    builder.capture(makeCheckpoint({ training: makeTraining({ currentDate: null }), chart: makeChart(makeBars(6)) }))
    builder.capture(
      makeCheckpoint({ training: makeTraining({ currentDate: null, blind: true }), chart: makeChart(makeBars(7)) }),
    )
    const resources = builder.getResources()
    expect(resources.series.map(v => v.asOf)).toEqual(['2026-03-05', '2025-12-01', null])
  })
})

describe('CompactBuilder 空checkpoint', () => {
  it('null training/chart/context输出null并正确还原', () => {
    const builder = new CompactBuilder()
    const c0 = makeCheckpoint()
    const c1 = makeCheckpoint({ training: makeTraining(), chart: makeChart(makeBars(3)), context: { k: 'v' } })
    const compact = [builder.capture(c0), builder.capture(c1)]
    const resources = builder.getResources()
    expect(compact[0].training).toBeNull()
    expect(compact[0].chart).toBeNull()
    expect(compact[0].contextRef).toBeNull()
    const reader = new CompactReader(assembleFile(compact, resources))
    const r0 = reader.checkpointAt(0)
    expect(r0.training).toBeNull()
    expect(r0.chart).toBeNull()
    expect(r0.context).toBeNull()
    const r1 = reader.checkpointAt(1)
    expect(r1.training).toEqual(c1.training)
    expect(r1.chart?.bars).toEqual(c1.chart?.bars)
    expect(r1.context).toEqual({ k: 'v' })
  })
})

describe('compactRecording v1迁移', () => {
  it('原v1逐checkpoint/events/gaps完全相等', () => {
    const builder = new CompactBuilder()
    const bars = makeBars(10)
    const drawings: Drawing[] = [{ id: 'dw-1', name: 'segment', paneId: 'p', points: [{ timestamp: 1, value: 2 }] }]
    const checkpoint0 = makeCheckpoint({ chart: makeChart(bars, drawings), context: { rules: {} } })
    const trade = { seq: 1, date: '2026-03-05', side: 'buy' as const, price: 10, shares: 100, amount: 1000, fee: 1 }
    const checkpoint1 = makeCheckpoint({ training: { ...makeTraining(), trades: [trade] } })
    const checkpoint2 = makeCheckpoint()
    const captured = [checkpoint0, checkpoint1, checkpoint2].map(cp => builder.capture(cp))
    const file: RecordingFile = {
      format: 'trainer-session',
      schemaVersion: 1,
      sessionId: 'sess-v1',
      createdAt: '2026-03-05T09:00:00.000Z',
      app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: false, chartLibrary: 'klinecharts' },
      environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
      trainingKey: '600000|2025-12-01',
      events: [
        { seq: 1, opId: 'op-1', segmentId: 'seg-1', elapsedMs: 0, phase: 'started', action: 'training.create', source: 'ui' },
        { seq: 2, opId: 'op-1', segmentId: 'seg-1', elapsedMs: 10, phase: 'finished', action: 'training.create', source: 'ui', outcome: 'accepted', result: { ok: true }, checkpointId: checkpoint0.id },
        { seq: 3, opId: 'op-2', segmentId: 'seg-2', elapsedMs: 20, phase: 'started', action: 'chart.load', source: 'chart' },
        { seq: 4, opId: 'op-2', segmentId: 'seg-2', elapsedMs: 30, phase: 'finished', action: 'chart.load', source: 'chart', outcome: 'accepted', checkpointId: checkpoint1.id },
      ],
      checkpoints: [checkpoint0, checkpoint1, checkpoint2],
      gaps: [{ afterSeq: 2, resumedAtSeq: 3 }],
      complete: false,
    }
    const compact = compactRecording(file)
    expect(compact.schemaVersion).toBe(2)
    expect(compact.format).toBe('trainer-session')
    expect(compact.sessionId).toBe('sess-v1')
    expect(compact.events).toEqual(file.events)
    expect(compact.gaps).toEqual(file.gaps)
    expect(compact.complete).toBe(false)
    expect(compact.checkpoints.map(cp => cp.id)).toEqual(captured.map(cp => cp.id))
    const reader = new CompactReader(compact)
    for (let i = 0; i < 3; i += 1) {
      expect(reader.checkpointAt(i)).toEqual(file.checkpoints[i])
    }
  })
})

describe('CompactReader 边界', () => {
  it('越界抛出可行动错误', () => {
    const builder = new CompactBuilder()
    const c0 = builder.capture(makeCheckpoint())
    const reader = new CompactReader(assembleFile([c0], builder.getResources()))
    expect(() => reader.checkpointAt(-1)).toThrow(/越界|范围/)
    expect(() => reader.checkpointAt(1)).toThrow(/越界|范围/)
  })

  it('损坏引用与循环基础链抛出明确错误', () => {
    const builder = new CompactBuilder()
    builder.capture(makeCheckpoint({ chart: makeChart(makeBars(5)) }))
    const source = builder.getResources()
    const baseView = { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: {} }
    const brokenCp: CompactCheckpoint = {
      id: 'cp-broken',
      afterSeq: 1,
      segmentId: 'seg-1',
      capturedAt: '2026-03-05T10:00:00.000Z',
      ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
      training: null,
      chart: { timeframe: '1D', seriesRef: 's-missing', drawingsRef: 'dw-missing', view: baseView, costPrice: null },
      contextRef: null,
    }
    const brokenReader = new CompactReader(assembleFile([brokenCp], source))
    expect(() => brokenReader.checkpointAt(0)).toThrow(/s-missing/)
    const cyclicCp: CompactCheckpoint = {
      ...brokenCp,
      chart: { timeframe: '1D', seriesRef: source.series[0].id, drawingsRef: source.drawings[0].id, view: baseView, costPrice: null },
    }
    const cyclic = assembleFile([cyclicCp], JSON.parse(JSON.stringify(source)))
    const v0 = cyclic.resources.series[0] as { base: unknown }
    v0.base = cyclic.resources.series[0].id
    const cyclicReader = new CompactReader(cyclic)
    expect(() => cyclicReader.checkpointAt(0)).toThrow(/循环/)
  })
})

describe('CompactBuilder 恢复后内容去重', () => {
  it('恢复Builder重建指纹索引，相同capture不重复入库（问题1）', () => {
    const builder1 = new CompactBuilder()
    const training = makeTraining()
    const trade = { seq: 1, date: '2026-03-05', side: 'buy' as const, price: 10, shares: 500, amount: 5000, fee: 5, chartPrice: 10 }
    const withTrade: TrainingSnapshot = { ...cloneTraining(training), trades: [trade] }
    const context = { rules: { t1: true } }
    const bars = makeBars(10)
    const c0 = builder1.capture(makeCheckpoint({ training: withTrade, chart: makeChart(bars), context }))
    const restored = builder1.getResources()
    expect(restored.trainingMeta).toHaveLength(1)
    expect(restored.trades).toHaveLength(1)

    const builder2 = new CompactBuilder(restored, 1)
    const c1 = builder2.capture(
      makeCheckpoint({
        training: cloneTraining(withTrade),
        chart: makeChart(cloneBars(bars)),
        context: JSON.parse(JSON.stringify(context)),
      }),
    )
    const resources = builder2.getResources()
    expect(resources.trainingMeta).toHaveLength(1)
    expect(resources.accounts).toHaveLength(1)
    expect(resources.trades).toHaveLength(1)
    expect(resources.contexts).toHaveLength(1)
    expect(resources.series).toHaveLength(restored.series.length)
    expect(c1.training?.metaRef).toBe(c0.training?.metaRef)
    expect(c1.training?.accountRef).toBe(c0.training?.accountRef)
    expect(c1.training?.tradeRefs[0]).toBe(c0.training?.tradeRefs[0])
    expect(c1.chart?.seriesRef).toBe(c0.chart?.seriesRef)
    expect(c1.contextRef).toBe(c0.contextRef)

    // 恢复后同seq不同chartPrice仍保留为新成交版本，不按seq覆盖
    const trade1 = { ...trade, chartPrice: 10.5 }
    builder2.capture(makeCheckpoint({ training: { ...cloneTraining(training), trades: [trade1] } }))
    expect(builder2.getResources().trades).toHaveLength(2)

    const reader = new CompactReader(assembleFile([c0, c1], builder2.getResources()))
    expect(reader.checkpointAt(1).training?.trades[0].chartPrice).toBe(10)
  })
})

describe('CompactBuilder 恢复后链深', () => {
  it('恢复后父链深度计入追加，连续刷新不突破31层（问题2）', () => {
    const builder1 = new CompactBuilder()
    builder1.capture(makeCheckpoint({ chart: makeChart(makeBars(1)) }))
    for (let i = 1; i <= 30; i += 1) {
      builder1.capture(makeCheckpoint({ chart: makeChart(makeBars(1 + i)) }))
    }
    expect(maxSeriesChainDepth(builder1.getResources())).toBe(30)

    const builder2 = new CompactBuilder(builder1.getResources(), 31)
    builder2.capture(makeCheckpoint({ chart: makeChart(makeBars(32)) }))
    builder2.capture(makeCheckpoint({ chart: makeChart(makeBars(33)) }))
    const resources = builder2.getResources()
    expect(maxSeriesChainDepth(resources)).toBeLessThanOrEqual(31)
    const last = resources.series[resources.series.length - 1]
    expect(last.base).toBeNull()
    expect(last.firstCheckpoint).toBe(32)
  })

  it('未知截止链达到31层后，相同bars切已知截止存新基础而非第32层空增量（问题3）', () => {
    const builder = new CompactBuilder()
    const compact = [builder.capture(makeCheckpoint({ chart: makeChart(makeBars(1)) }))]
    for (let i = 1; i <= 31; i += 1) {
      compact.push(builder.capture(makeCheckpoint({ chart: makeChart(makeBars(1 + i)) })))
    }
    expect(maxSeriesChainDepth(builder.getResources())).toBe(31)
    const bars = makeBars(32)
    compact.push(
      builder.capture(
        makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-05' }), chart: makeChart(bars) }),
      ),
    )
    const resources = builder.getResources()
    expect(maxSeriesChainDepth(resources)).toBeLessThanOrEqual(31)
    const version = resources.series.find(v => v.id === compact[32].chart?.seriesRef)
    expect(version).toBeDefined()
    expect(version?.asOf).toBe('2026-03-05')
    expect(version?.base).toBeNull()
    const reader = new CompactReader(assembleFile(compact, resources))
    expect(reader.checkpointAt(32).chart?.bars).toEqual(bars)
    expect(reader.checkpointAt(31).chart?.bars).toEqual(makeBars(32))
  })
})

describe('CompactBuilder 历史内容复用', () => {
  it('series A→B→A复用历史版本（问题5）', () => {
    const builder = new CompactBuilder()
    const x = makeBars(5)
    const y = makeBars(6)
    const c0 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(x)) }))
    const c1 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(y)) }))
    const c2 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(x)) }))
    const resources = builder.getResources()
    expect(resources.series).toHaveLength(2)
    expect(c2.chart?.seriesRef).toBe(c0.chart?.seriesRef)
    const reader = new CompactReader(assembleFile([c0, c1, c2], resources))
    expect(reader.checkpointAt(0).chart?.bars).toEqual(x)
    expect(reader.checkpointAt(2).chart?.bars).toEqual(x)
  })

  it('drawings A→B→A复用历史版本（问题5）', () => {
    const builder = new CompactBuilder()
    const a: Drawing = { id: 'dw-a', name: 'segment', paneId: 'p', points: [{ timestamp: 1, value: 1 }] }
    const b: Drawing = { id: 'dw-b', name: 'segment', paneId: 'p', points: [{ timestamp: 2, value: 2 }] }
    const bars = makeBars(5)
    const c0 = builder.capture(makeCheckpoint({ chart: makeChart(bars, [a]) }))
    const c1 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(bars), [a, b]) }))
    const c2 = builder.capture(makeCheckpoint({ chart: makeChart(cloneBars(bars), [JSON.parse(JSON.stringify(a)) as Drawing]) }))
    const resources = builder.getResources()
    expect(resources.drawings).toHaveLength(2)
    expect(c2.chart?.drawingsRef).toBe(c0.chart?.drawingsRef)
    const reader = new CompactReader(assembleFile([c0, c1, c2], resources))
    expect(reader.checkpointAt(2).chart?.drawings).toEqual([a])
  })

  it('跨恢复的A→B→A仍复用：恢复后索引正确（问题5）', () => {
    const builder1 = new CompactBuilder()
    const x = makeBars(5)
    const c0 = builder1.capture(makeCheckpoint({ chart: makeChart(cloneBars(x)) }))
    const builder2 = new CompactBuilder(builder1.getResources(), 1)
    const y = makeBars(6)
    builder2.capture(makeCheckpoint({ chart: makeChart(cloneBars(y)) }))
    const c2 = builder2.capture(makeCheckpoint({ chart: makeChart(cloneBars(x)) }))
    const resources = builder2.getResources()
    expect(resources.series).toHaveLength(2)
    expect(c2.chart?.seriesRef).toBe(c0.chart?.seriesRef)
  })

  it('历史复用受asOf许可约束：已知截止不得复用更晚asOf的历史版本', () => {
    const builder = new CompactBuilder()
    const x = makeBars(5)
    const y = makeBars(6)
    const c0 = builder.capture(
      makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-06' }), chart: makeChart(cloneBars(x)) }),
    )
    builder.capture(makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-07' }), chart: makeChart(cloneBars(y)) }))
    const c2 = builder.capture(
      makeCheckpoint({ training: makeTraining({ currentDate: '2026-03-05' }), chart: makeChart(cloneBars(x)) }),
    )
    const resources = builder.getResources()
    const version = resources.series.find(v => v.id === c2.chart?.seriesRef)
    expect(version).toBeDefined()
    // x在03-06已记录，更早截止03-05不能引用它，也不能引用03-07的y版本 → 存新基础
    expect(version?.base).toBeNull()
    expect(version?.asOf).toBe('2026-03-05')
    expect(version).not.toBe(resources.series[0])
    expect(c2.chart?.seriesRef).not.toBe(c0.chart?.seriesRef)
    const reader = new CompactReader(assembleFile([c0, c2], resources))
    expect(reader.checkpointAt(1).chart?.bars).toEqual(x)
  })

  it('纯删除按序列化字节小于全量走增量（byte例：remove键6字节 < 全量约400字节）', () => {
    const builder = new CompactBuilder()
    const a: Drawing = { id: 'dw-a', name: 'segment', paneId: 'p', points: [{ timestamp: 1, value: 1 }] }
    const b: Drawing = {
      id: 'dw-b',
      name: 'horizontalLine',
      paneId: 'candle_pane',
      points: [{ timestamp: 2, value: 9 }],
      styles: { color: '#ff0000' },
      extendData: { text: 'x'.repeat(200) },
    }
    const c0 = builder.capture(makeCheckpoint({ chart: makeChart(makeBars(5), [a, b]) }))
    const c1 = builder.capture(makeCheckpoint({ chart: makeChart(makeBars(5), [b]) }))
    const resources = builder.getResources()
    expect(resources.drawings).toHaveLength(2)
    const v1 = resources.drawings[1]
    if (!('remove' in v1)) throw new Error('纯删除应存增量而非全量基础')
    expect(v1.remove).toEqual(['dw-a'])
    expect(v1.upsert).toHaveLength(0)
    const reader = new CompactReader(assembleFile([c0, c1], resources))
    expect(reader.checkpointAt(0).chart?.drawings).toEqual([a, b])
    expect(reader.checkpointAt(1).chart?.drawings).toEqual([b])
  })
})
