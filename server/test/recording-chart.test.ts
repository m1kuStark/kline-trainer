import { describe, expect, it } from 'vitest'
import {
  VIEWPORT_CAPTURE_THROTTLE_MS,
  buildChartCapture,
  captureView,
  toCaptureBars,
} from '../../web/src/recording/chartCapture'
import type { CaptureSourceBar } from '../../web/src/recording/chartCapture'
import type { Drawing } from '../../web/src/drawingState'

function sourceBar(date: string, close: number, amount: number): CaptureSourceBar {
  return { timestamp: Date.parse(`${date}T00:00:00Z`), open: close - 1, high: close + 1, low: close - 2, close, volume: 1000, amount, date }
}

describe('REC chart capture pure conversions', () => {
  it('captures the full loaded history (not only the visible window) and preserves original date/amount', () => {
    // loadedData = 初始窗口 + 动态补齐的更早历史；捕获必须覆盖全部，不得截断为 props.bars
    const loadedData = [sourceBar('2024-01-01', 10, 99), sourceBar('2024-01-02', 20, 1234.5), sourceBar('2024-01-03', 30, 0)]
    const bars = toCaptureBars(loadedData)
    expect(bars).toHaveLength(3)
    expect(bars[0]).toEqual({ date: '2024-01-01', open: 9, high: 11, low: 8, close: 10, volume: 1000, amount: 99 })
    // amount 必须逐条保留原始值，包括合法的 0
    expect(bars[1]!.amount).toBe(1234.5)
    expect(bars[2]!.amount).toBe(0)
    expect(bars.map(bar => bar.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03'])
  })

  it('throws instead of fabricating values when volume/amount are missing, NaN or negative', () => {
    // 无 amount 不得假造 0（生产 toK 保证带 amount，缺失即上游缺陷，必须显式失败）
    expect(() => toCaptureBars([{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, date: '2024-01-01' }])).toThrow(/成交额/)
    expect(() => toCaptureBars([{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: Number.NaN, amount: 8, date: '2024-01-01' }])).toThrow(/成交量/)
    expect(() => toCaptureBars([{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: -1, amount: 8, date: '2024-01-01' }])).toThrow()
    expect(() => toCaptureBars([{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, amount: -0.5, date: '2024-01-01' }])).toThrow()
  })

  it('derives the date from the timestamp when the feed bar carries no date', () => {
    const bars = toCaptureBars([{ timestamp: Date.parse('2024-01-02T00:00:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, amount: 8 }])
    expect(bars[0]!.date).toBe('2024-01-02')
  })

  it('returns independent bar objects: mutating the source or the capture does not leak', () => {
    const loadedData = [{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, amount: 8, date: '2024-01-01' }]
    const bars = toCaptureBars(loadedData)
    loadedData[0]!.close = 999
    loadedData.pop()
    expect(bars[0]!.close).toBe(1.5)
    bars[0]!.amount = -1
    expect(bars).not.toEqual(toCaptureBars([{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, amount: 8, date: '2024-01-01' }]))
  })

  it('treats the visible to index as an exclusive upper bound: left=floor, right=ceil(to)-1, clamped into data', () => {
    const data = [100, 200, 300, 400, 500].map(timestamp => ({ timestamp }))
    // from 含、to 排除：[1,4) → 左锚 200、右锚 400
    expect(captureView({ fromIndex: 1, toIndex: 4, data, barSpace: 12.5, paneHeights: { candle_pane: 400, VOL: 120 } })).toEqual({
      fromTimestamp: 200,
      toTimestamp: 400,
      barSpace: 12.5,
      paneHeights: { candle_pane: 400, VOL: 120 },
    })
    // 小数区间：from 取 floor、to 取 ceil(to)-1
    expect(captureView({ fromIndex: 1.4, toIndex: 4.6, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: 200,
      toTimestamp: 500,
      barSpace: 1,
      paneHeights: {},
    })
    // 越界钳制进已加载数据范围，不得编造也不得丢锚点
    expect(captureView({ fromIndex: -3, toIndex: 99, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: 100,
      toTimestamp: 500,
      barSpace: 1,
      paneHeights: {},
    })
  })

  it('copies pane heights and keeps mutations from leaking in either direction', () => {
    const data = [{ timestamp: 100 }, { timestamp: 200 }]
    const paneHeights = { candle_pane: 400, VOL: 120 }
    const view = captureView({ fromIndex: 0, toIndex: 2, data, barSpace: 12.5, paneHeights })
    expect(view.paneHeights).toEqual({ candle_pane: 400, VOL: 120 })
    paneHeights.VOL = 999
    view.paneHeights.candle_pane = 1
    expect(view.paneHeights.VOL).toBe(120)
    expect(captureView({ fromIndex: 0, toIndex: 2, data, barSpace: 1, paneHeights }).paneHeights.VOL).toBe(999)
  })

  it('returns null anchors only for an empty dataset or a non-overlapping window', () => {
    // 完全空数据（初始空图）→ 合法默认值
    expect(captureView({ fromIndex: 0, toIndex: 2, data: [], barSpace: 8, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 8,
      paneHeights: {},
    })
    const data = [{ timestamp: 100 }]
    // 窗口完全在数据之外 / 空窗（from==to）→ null 锚点
    expect(captureView({ fromIndex: 5, toIndex: 6, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 1,
      paneHeights: {},
    })
    expect(captureView({ fromIndex: 0, toIndex: 0, data, barSpace: 1, paneHeights: {} }).toTimestamp).toBeNull()
  })

  it('builds a deeply immutable ChartCapture from bars, drawings and view', () => {
    const bars = [{ date: '2024-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, amount: 8 }]
    const drawing: Drawing = { id: 'd1', name: 'horizontalSegment', paneId: 'candle_pane', points: [{ timestamp: 100, value: 3 }] }
    const view = captureView({ fromIndex: 0, toIndex: 1, data: [{ timestamp: 100 }], barSpace: 8, paneHeights: { candle_pane: 300 } })
    const capture = buildChartCapture({ timeframe: '1D', bars, drawings: [drawing], view, costPrice: 12.34 })
    expect(capture).toEqual({
      timeframe: '1D',
      bars: [{ date: '2024-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, amount: 8 }],
      drawings: [drawing],
      view: { fromTimestamp: 100, toTimestamp: 100, barSpace: 8, paneHeights: { candle_pane: 300 } },
      costPrice: 12.34,
    })
    // 深拷贝双向隔离
    bars[0]!.close = 0
    drawing.points[0]!.value = 0
    view.barSpace = 0
    expect(capture.bars[0]!.close).toBe(1.5)
    expect(capture.drawings[0]!.points[0]!.value).toBe(3)
    expect(capture.view.barSpace).toBe(8)
    capture.view.paneHeights.candle_pane = 5
    expect(view.paneHeights.candle_pane).toBe(300)
  })

  it('throws on non-finite costPrice/drawing/view numbers instead of serializing them as null', () => {
    const view = captureView({ fromIndex: 0, toIndex: 1, data: [{ timestamp: 100 }], barSpace: 8, paneHeights: {} })
    // null 是唯一的“无成本”值；NaN/∞ 不得经 JSON.stringify 静默变成 null
    expect(() => buildChartCapture({ timeframe: '1D', bars: [], drawings: [], view, costPrice: Number.NaN })).toThrow(/成本价/)
    expect(() => buildChartCapture({ timeframe: '1D', bars: [], drawings: [], view, costPrice: Number.POSITIVE_INFINITY })).toThrow(/成本价/)
    expect(buildChartCapture({ timeframe: '1D', bars: [], drawings: [], view, costPrice: null }).costPrice).toBeNull()
    // bars 沿用既有闸门：非有限开高低收量额显式报错
    expect(() => buildChartCapture({
      timeframe: '1D',
      bars: [{ date: '2024-01-01', open: 1, high: 2, low: 0.5, close: Number.POSITIVE_INFINITY, volume: 7, amount: 8 }],
      drawings: [],
      view,
      costPrice: null,
    })).toThrow()
    // 画线锚点与嵌套数值（styles/extendData）同样把守：序列化前拦截，绝不产出 null 值
    const drawing: Drawing = { id: 'd1', name: 'horizontalSegment', paneId: 'candle_pane', points: [{ timestamp: 100, value: 3 }] }
    expect(() => buildChartCapture({
      timeframe: '1D',
      bars: [],
      drawings: [{ ...drawing, points: [{ timestamp: Number.NaN, value: 3 }] }],
      view,
      costPrice: null,
    })).toThrow(/无效数值/)
    expect(() => buildChartCapture({
      timeframe: '1D',
      bars: [],
      drawings: [{ ...drawing, points: [{ timestamp: 100, value: Number.POSITIVE_INFINITY }] }],
      view,
      costPrice: null,
    })).toThrow(/无效数值/)
    expect(() => buildChartCapture({
      timeframe: '1D',
      bars: [],
      drawings: [{ ...drawing, extendData: { size: Number.NaN } }],
      view,
      costPrice: null,
    })).toThrow(/无效数值/)
    // 视窗嵌套数值（paneHeights）同样把守
    expect(() => buildChartCapture({ timeframe: '1D', bars: [], drawings: [], view: { ...view, paneHeights: { candle_pane: Number.NaN } }, costPrice: null })).toThrow(/无效数值/)
  })

  it('rejects an empty or reversed window: from>=to yields null anchors instead of swapped ones', () => {
    // 回归：fromIndex==toIndex 曾经返回 data[from]/data[to] 的倒置锚点
    const data = [100, 200, 300].map(timestamp => ({ timestamp }))
    expect(captureView({ fromIndex: 1, toIndex: 1, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 1,
      paneHeights: {},
    })
    expect(captureView({ fromIndex: 2, toIndex: 1, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 1,
      paneHeights: {},
    })
    // 真实可见的单根窗口（floor(from)==ceil(to)-1）不受影响：锚点仍指向同一根
    expect(captureView({ fromIndex: 1, toIndex: 2, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: 200,
      toTimestamp: 200,
      barSpace: 1,
      paneHeights: {},
    })
  })

  it('rejects non-finite indexes and non-finite anchor timestamps with null anchors', () => {
    const data = [{ timestamp: 100 }, { timestamp: Number.NaN }, { timestamp: 300 }]
    expect(captureView({ fromIndex: Number.NaN, toIndex: 3, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 1,
      paneHeights: {},
    })
    expect(captureView({ fromIndex: 0, toIndex: Number.POSITIVE_INFINITY, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 1,
      paneHeights: {},
    })
    // 右锚命中 NaN 时间戳：窗口无法表达，两侧一并作废，绝不序列化出 NaN
    expect(captureView({ fromIndex: 0, toIndex: 2, data, barSpace: 1, paneHeights: {} })).toEqual({
      fromTimestamp: null,
      toTimestamp: null,
      barSpace: 1,
      paneHeights: {},
    })
  })

  it('throws on non-finite or non-positive barSpace instead of producing an unrestorable view', () => {
    const data = [{ timestamp: 100 }, { timestamp: 200 }]
    expect(() => captureView({ fromIndex: 0, toIndex: 2, data, barSpace: Number.NaN, paneHeights: {} })).toThrow(/柱宽/)
    expect(() => captureView({ fromIndex: 0, toIndex: 2, data, barSpace: 0, paneHeights: {} })).toThrow(/柱宽/)
    expect(() => captureView({ fromIndex: 0, toIndex: 2, data, barSpace: -2.5, paneHeights: {} })).toThrow(/柱宽/)
  })

  it('drops non-finite and non-positive pane heights while keeping valid ones', () => {
    const view = captureView({ fromIndex: 0, toIndex: 1, data: [{ timestamp: 100 }], barSpace: 1, paneHeights: { candle_pane: 400, VOL: Number.NaN, MACD: 0, junk: -5 } })
    expect(view.paneHeights).toEqual({ candle_pane: 400 })
  })

  it('keeps the viewport capture throttle around 150ms', () => {
    expect(VIEWPORT_CAPTURE_THROTTLE_MS).toBeGreaterThanOrEqual(100)
    expect(VIEWPORT_CAPTURE_THROTTLE_MS).toBeLessThanOrEqual(250)
  })
})
