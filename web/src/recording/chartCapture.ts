// REC-CHART 图表捕获纯函数：KlineChart 的 captureState/emit 逻辑依赖本模块，不引入图表实例或 DOM。
// 契约见 docs/engineering/recording-contract.md。
import type { KLineData } from 'klinecharts'
import type { Bar, Timeframe } from '../api'
import type { Drawing } from '../drawingState'
import type { ChartCapture, ChartCaptureView } from './types'

/** 用户视窗手势后的捕获节流窗口（毫秒，尾沿触发＝末次完整捕获） */
export const VIEWPORT_CAPTURE_THROTTLE_MS = 150

/** feedData 存入的 KLineData 携带 date/amount 附加字段，捕获时需要完整还原为 Bar */
export type CaptureSourceBar = KLineData & { date?: string; amount?: number }

function fallbackDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

/** 数值有效性闸门：缺失/无效值显式报错，绝不 JSON 序列化成 null，也绝不假造 0 */
function assertBarValues(
  bar: { open?: number; high?: number; low?: number; close?: number; volume?: number; amount?: number },
  date: string,
): void {
  const fields: Array<[string, number | undefined]> = [['开价', bar.open], ['高价', bar.high], ['低价', bar.low], ['收价', bar.close], ['成交量', bar.volume], ['成交额', bar.amount]]
  for (const [label, value] of fields) {
    if (value === undefined || !Number.isFinite(value)) throw new Error(`图表捕获遇到无效${label}（${date}）`)
  }
  // 走到这里字段必为有限数值（缺失已在上方抛错）
  if ((bar.volume as number) < 0 || (bar.amount as number) < 0) throw new Error(`图表捕获遇到负值成交量/成交额（${date}）`)
}

/** loadedData → Bar：保留全部历史（不限可见窗口）与原始 date/amount，逐条新建对象 */
export function toCaptureBars(data: ReadonlyArray<CaptureSourceBar>): Bar[] {
  return data.map(item => {
    const date = typeof item.date === 'string' ? item.date : fallbackDate(item.timestamp)
    const bar = {
      date,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
      amount: item.amount,
    }
    assertBarValues(bar, date)
    return bar as Bar
  })
}

export interface CaptureViewInput {
  /** klinecharts 可见区间：from 含、to 为排他上界（可为小数），换算为实际左右时间锚点 */
  fromIndex: number
  toIndex: number
  data: ReadonlyArray<{ timestamp: number }>
  barSpace: number
  paneHeights: Record<string, number>
}

/** 视窗快照：左锚取 floor、右锚取 ceil(to)-1，各自钳制进已加载数据。非有限下标/时间戳与
 * 空窗（from>=to）一律两侧锚点作废（绝不输出倒置锚点）；非法窗格高度逐项丢弃；
 * 非有限/非正柱宽＝布局损坏，显式报错而不产出无法恢复的视窗 */
export function captureView(input: CaptureViewInput): ChartCaptureView {
  const paneHeights: Record<string, number> = {}
  for (const [name, height] of Object.entries(input.paneHeights)) {
    if (Number.isFinite(height) && height > 0) paneHeights[name] = height
  }
  if (!Number.isFinite(input.barSpace) || input.barSpace <= 0) throw new Error('图表捕获视窗柱宽无效')
  const nullAnchors = { fromTimestamp: null, toTimestamp: null, barSpace: input.barSpace, paneHeights }
  if (!Number.isFinite(input.fromIndex) || !Number.isFinite(input.toIndex) || input.fromIndex >= input.toIndex) return nullAnchors
  const count = input.data.length
  if (!count) return nullAnchors
  const from = Math.floor(input.fromIndex)
  const to = Math.ceil(input.toIndex) - 1
  if (from > count - 1 || to < 0) return nullAnchors
  const clamp = (index: number): number => Math.max(0, Math.min(count - 1, index))
  const fromTimestamp = input.data[clamp(from)]!.timestamp
  const toTimestamp = input.data[clamp(to)]!.timestamp
  if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp)) return nullAnchors
  return { fromTimestamp, toTimestamp, barSpace: input.barSpace, paneHeights }
}

export interface ChartCaptureInput {
  timeframe: Timeframe
  bars: ReadonlyArray<Bar>
  drawings: ReadonlyArray<Drawing>
  view: ChartCaptureView
  costPrice: number | null
}

/** 组装 ChartCapture：先校验数值有限（无效值显式报错），再对 bars/drawings/view 做不可变深拷贝 */
export function buildChartCapture(input: ChartCaptureInput): ChartCapture {
  for (const bar of input.bars) assertBarValues(bar, bar.date)
  // costPrice：null 是唯一的“无成本”表达，非有限数值必须报错（JSON.stringify 会把 NaN/±∞ 静默写成 null）
  if (input.costPrice !== null && !Number.isFinite(input.costPrice)) throw new Error('图表捕获成本价无效')
  assertFiniteTree(input.drawings, 'drawings')
  assertFiniteTree(input.view, 'view')
  return JSON.parse(JSON.stringify({
    timeframe: input.timeframe,
    bars: input.bars,
    drawings: input.drawings,
    view: { ...input.view, paneHeights: { ...input.view.paneHeights } },
    costPrice: input.costPrice,
  })) as ChartCapture
}

/** 序列化前闸门：深度校验嵌套数值全部有限，JSON.stringify 会把 NaN/±∞ 静默写成 null，必须在其前拦下 */
function assertFiniteTree(value: unknown, label: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`图表捕获发现无效数值（${label}）`)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertFiniteTree(value[i], `${label}[${i}]`)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertFiniteTree(item, `${label}.${key}`)
  }
}

/** 只读图形创建参数：lock 拒绝拖拽，ignoreEvent 拒绝选中/右键（klinecharts 10.0.3 OverlayCreate 公开字段） */
export const READ_ONLY_OVERLAY_CREATE = { lock: true, ignoreEvent: true } as const
