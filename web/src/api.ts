export type Timeframe = '1D' | '1W' | '1M'
import type { Drawing } from './drawingState'
import type { DrawingPriceBasis } from './drawingPriceBasis'
export type Tier = '1M' | '3M' | '6M' | '1Y' | '2Y'

export interface Stock {
  code: string
  market: string
  name: string
  bars: number
  lastDate: string | null
}

export interface TrainingMeta {
  id: number
  tier: Tier
  code: string | null
  name: string | null
  market: string
  startDate: string
  plannedEnd: string
  /** 双盲进行中为 null，前端显示"今日" */
  currentDate: string | null
  status: 'running' | 'settled' | 'abandoned'
  settleDate: string | null
  earlySettle: boolean
  blind: boolean
  adjustMode: 'forward' | 'raw'
  initialCash: number
  createdAt: string
}

export interface AccountView {
  cash: number
  shares: number
  availableShares: number
  costPrice: number | null
  marketValue: number
  equity: number
}

export interface TradeView {
  seq: number
  date: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  amount: number
  fee: number
  /** 图表空间价格（按当前复权基准调整），B/S 标记用；price 为原始成交价 */
  chartPrice?: number
  /** 双盲进行中：成交日在推进序列中的序号（0=起始日），前端映射相对时间戳 */
  blindIndex?: number
  /** 双盲进行中：相对日期标签（今日 / T-n）；date 恒为真实值 */
  blindLabel?: string
}

export interface TrainingSnapshot {
  training: TrainingMeta
  account: AccountView
  trades: TradeView[]
}

export interface Bar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
}

export interface EquityPoint { date: string; equity: number }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError' }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new ApiError(payload.message ?? payload.error ?? `请求失败（${response.status}）`, response.status)
  return payload
}

export interface RecordingContext {
  app: { version: string; gitCommit: string; dirty: boolean; chartLibrary: string }
  rules: { [key: string]: string | number | boolean }
  positionEvents: Array<{ seq: number; date: string; kind: string; sharesDelta: number; cashDelta: number; costDelta: number | null }>
}
export function fetchRecordingContext(id: number): Promise<RecordingContext> {
  return request(`/api/trainings/${id}/recording-context`)
}

export function fetchEnv(): Promise<{ status: string; tdxRoot: string | null; dataCutoff: string | null; stockCount: number; capabilities: Record<string, boolean>; activeTrainingId: number | null }> {
  return request('/api/env')
}

export function searchStocks(q: string): Promise<{ items: Stock[]; total: number }> {
  return request(`/api/stocks?q=${encodeURIComponent(q)}`)
}

export function createTraining(input: { tier: Tier; code: string; start_date: string; initial_cash?: number; blind?: boolean; adjust_mode?: string }): Promise<{ training: TrainingMeta }> {
  return request('/api/trainings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function fetchActiveTraining(): Promise<TrainingSnapshot | { training: null }> {
  return request('/api/trainings/active')
}

export interface TrainingBarsPayload extends TrainingSnapshot {
  chartCostPrice: number | null
  timeframe: Timeframe
  bars: Bar[]
  /** 是否还有更早历史可动态加载 */
  hasMore: boolean
  /** 画线前复权基准（已发生权息累计仿射变换），与 bars 同次返回；旧服务端缺省（可选保持兼容） */
  drawingPriceBasis?: DrawingPriceBasis
}

export function fetchTrainingBars(id: number, tf: Timeframe, params?: { before?: string; count?: number }): Promise<TrainingBarsPayload> {
  const search = new URLSearchParams({ tf })
  if (params?.before) search.set('before', params.before)
  if (params?.count) search.set('count', String(params.count))
  return request(`/api/trainings/${id}/bars?${search}`)
}

export function advanceTraining(id: number): Promise<{ snapshot: TrainingSnapshot; settled: boolean; bar: Bar | null }> {
  return request(`/api/trainings/${id}/next`, { method: 'POST' })
}

export function tradeTraining(id: number, input: { side: 'buy' | 'sell'; shares?: number; weightPct?: number }): Promise<{ snapshot: TrainingSnapshot; plan: { side: string; shares: number; amount: number; price: number; fee: number } }> {
  return request(`/api/trainings/${id}/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function settleTraining(id: number): Promise<TrainingSnapshot & { equityCurve: EquityPoint[] }> {
  return request(`/api/trainings/${id}/settle`, { method: 'POST' })
}

export function abandonTraining(id: number): Promise<{ training: TrainingMeta }> {
  return request(`/api/trainings/${id}/abandon`, { method: 'POST' })
}

export function fetchDrawings(id: number): Promise<{ drawings: Drawing[] }> {
  return request(`/api/trainings/${id}/drawings`)
}

export async function saveDrawings(id: number, drawings: Drawing[], keepalive = false): Promise<void> {
  await request(`/api/trainings/${id}/drawings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(drawings), keepalive,
  })
}

// ===== 日线数据更新（R1：状态检查 + 触发更新） =====

export type DataState = 'idle' | 'running' | 'unchanged' | 'updated' | 'failed'

export interface DataSourceInfo {
  kind: 'tdx' | 'online' | 'none'
  name: string
  available: boolean
}

export interface DataRefreshResult {
  finishedAt: string
  outcome: 'unchanged' | 'updated' | 'failed'
  added: number
  removed: number
  revised: number
  message: string
}

export interface DataStatus {
  state: DataState
  needsUpdate: boolean
  reason: string
  source: DataSourceInfo
  tdx: { available: boolean; root: string | null }
  online: { configured: boolean; provider: string | null }
  sourceMaxDate: string | null
  lastCheckedAt: string | null
  lastResult: DataRefreshResult | null
  revisionWarning: string | null
}

export function fetchDataStatus(): Promise<DataStatus> {
  return request('/api/data/status')
}

export function postDataRefresh(): Promise<{ taskId: string; state: DataState; joined: boolean }> {
  return request('/api/data/refresh', { method: 'POST' })
}
