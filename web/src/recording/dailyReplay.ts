// REC-03 按交易日回放纯逻辑：稀疏日期索引、当日最后安全状态选择、纯浏览器周/月聚合。
// 只消费已通过校验的紧凑录制（v1 由调用方先经 compactRecording 迁移）；不触 DOM、
// 不引 Node/server 依赖。索引构建只读 checkpoint 元数据与资源表 id，不展开任何行情/画线版本；
// 解码按日惰性执行并限量缓存。防未来：当日状态只允许 afterSeq 不晚于当日末的检查点。
import type { Bar, Timeframe, TrainingSnapshot } from '../api'
import type { Drawing } from '../drawingState'
import { CompactReader } from './compactCodec'
import { businessEvents } from './businessEvents'
import type { CompactCheckpoint, CompactRecordingFile } from './compactTypes'
import type { Action, RecordingEvent, RecordingEventOutcome } from './types'

/** 业务动作中文说明（与 replay.ts 的 ACTION_LABELS 同源口径；该模块未导出，此处只列业务子集） */
const BUSINESS_ACTION_LABELS: Record<Action, string> = {
  'training.create': '创建训练',
  'training.advance': '推进交易日',
  'training.trade': '下单交易',
  'training.settle': '结算训练',
  'training.abandon': '放弃训练',
  'chart.load': '加载图表',
  'chart.timeframe': '切换周期',
  'chart.viewport': '调整视窗',
  'chart.tool': '切换画线工具',
  'chart.drawing.create': '新增画线',
  'chart.drawing.edit': '编辑画线',
  'chart.drawing.move': '移动画线',
  'chart.drawing.delete': '删除画线',
  'chart.drawing.undo': '撤销画线',
  'chart.drawing.redo': '重做画线',
  'chart.drawing.cancel': '取消画线',
  'chart.drawing.clear': '清空画线',
  'drawings.save': '保存画线',
  'ui.theme': '切换主题',
  'recording.pause': '暂停录制',
  'recording.resume': '恢复录制',
  'session.interrupted': '录制中断',
}

/** 播放为固定「秒/日」档位：推进一个已录交易日所需的固定时长 */
export const DAY_SPEEDS = [0.2, 0.5, 1, 2, 5, 10] as const

/** 已接受的完成事件：旧文件可能缺 outcome，缺省按接受处理 */
function acceptedOutcome(outcome: RecordingEventOutcome | undefined): boolean {
  return outcome === undefined || outcome === 'accepted'
}

/** 业务动作白名单：完成的买卖与实际图形/文字变更；工具/主题/加载/保存/暂停等一律不算业务操作 */


/**
 * 交易日轴的某一天。边界=已接受的推进事件；缺口内被吞掉的推进日按「已观察过日期的日段内
 * 元数据前移」补分界，盲训（无日期）无法补分界，只保留缺口提示。safe/training 为「含此前
 * 累积」的有效检查点下标（-1＝尚无）；daily 只认当日段内的日线观察（或已证明同日的跨段
 * 检查点），绝不把昨日日线冒充当日。当日范围命中与否另记 inDay 供「该日无快照」如实提示。
 */
export interface ReplayDay {
  index: number
  firstSeq: number
  lastSeq: number
  /** 元数据日期（非盲训练的 currentDate）；盲训或缺失为 null */
  date: string | null
  blind: boolean
  /** 当日范围内是否存在可用快照（training+chart 齐全）；否则展示累积状态并提示 */
  safeInDay: boolean
  effectiveSafe: number
  effectiveTraining: number
  effectiveDaily: number
}

export interface DailyIndex {
  days: ReplayDay[]
}

interface DayAccumulator {
  firstSeq: number
  lastSeq: number
  lastDate: string | null
  blind: boolean
  safeInDay: boolean
  effectiveSafe: number
  effectiveTraining: number
  effectiveDaily: number
  /** 当日段内最后一个 1D 检查点下标（-1＝当日段内没有日线观察） */
  dailyInDay: number
}

function betterMeta(cp: CompactCheckpoint | null, metas: Map<string, { currentDate: string | null; blind: boolean }>): { date: string | null; blind: boolean } | null {
  if (!cp?.training) return null
  const meta = metas.get(cp.training.metaRef)
  if (!meta) return null
  return { date: meta.currentDate, blind: meta.blind }
}

/** 检查点元数据的观察日期；无 training 或元数据缺失为 null */
function checkpointMetaDate(file: CompactRecordingFile, metas: Map<string, { currentDate: string | null; blind: boolean }>, checkpointIndex: number): string | null {
  const checkpoint = file.checkpoints[checkpointIndex]
  if (!checkpoint?.training) return null
  return metas.get(checkpoint.training.metaRef)?.currentDate ?? null
}

function insertSorted(values: number[], value: number): void {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid] < value) low = mid + 1
    else high = mid
  }
  values.splice(low, 0, value)
}

/**
 * 稀疏日期索引：一遍事件取推进日分界，一遍检查点（仅元数据，不解码资源）补缺口分界并累积
 * 各日有效检查点下标。检查点 afterSeq 沿校验合同非递减，单趟路由即可；绝不读取 afterSeq
 * 晚于当日末的任何检查点。
 */
export function buildDailyIndex(file: CompactRecordingFile): DailyIndex {
  const metas = new Map(file.resources.trainingMeta.map(entry => [entry.id, entry.value]))
  const boundaries = [0]
  for (const event of file.events) {
    const endedWithoutNextBar = (event.result as { settled?: unknown } | null)?.settled === true
    if (event.action === 'training.advance' && event.phase === 'finished' && acceptedOutcome(event.outcome) && !endedWithoutNextBar) {
      insertSorted(boundaries, event.seq)
    }
  }

  // 缺口内推进未录时，检查点元数据日期在区间中点前移：只认「已观察过日期的日段内再次前移」
  // 为真实补分界。推进分界后首个到达的元数据（哪怕因捕获去抖迟到、中间隔着空检查点）只是该
  // 新日段的首次定日，日期变化由推进分界本身解释——否则两个真实日会插出前一日重复的幻影日。
  const dayDates: Array<string | null> = [null]
  const dayObserved: Array<boolean> = [false]
  const dayBlind: Array<boolean> = [false]
  let dayPointer = 0
  for (const checkpoint of file.checkpoints) {
    while (dayPointer + 1 < boundaries.length && checkpoint.afterSeq >= boundaries[dayPointer + 1]) {
      dayPointer += 1
      if (dayDates.length <= dayPointer) {
        dayDates.push(dayDates[dayDates.length - 1] ?? null)
        dayObserved.push(false)
        dayBlind.push(dayBlind[dayBlind.length - 1] ?? false)
      }
    }
    const meta = betterMeta(checkpoint, metas)
    while (dayDates.length <= dayPointer) {
      dayDates.push(dayDates[dayDates.length - 1] ?? null)
      dayObserved.push(false)
      dayBlind.push(dayBlind[dayBlind.length - 1] ?? false)
    }
    if (meta) {
      dayBlind[dayPointer] = meta.blind
      if (meta.date !== null) {
        if (!dayObserved[dayPointer]) {
          // 该日段的首次元数据观察：直接定日，不补分界
          dayObserved[dayPointer] = true
          dayDates[dayPointer] = meta.date
        } else if (meta.date > dayDates[dayPointer]!) {
          // 已观察过的日段内日期前移：暂停缺口内被吞的推进 → 真实补分界
          insertSorted(boundaries, checkpoint.afterSeq)
          dayPointer += 1
          dayDates.push(meta.date)
          dayObserved.push(true)
          dayBlind.push(meta.blind)
        } else {
          dayDates[dayPointer] = meta.date
        }
      }
    }
  }

  const totalEvents = file.events.length
  // 天数由分界表决定；日期/盲标只覆盖被检查点走访过的前缀，尾部缺省为 null/false
  const accumulators: DayAccumulator[] = boundaries.map((firstSeq, index) => ({
    firstSeq,
    lastSeq: Math.min(boundaries[index + 1] ?? totalEvents + 1, totalEvents + 1) - 1,
    lastDate: dayDates[index] ?? null,
    blind: dayBlind[index] ?? false,
    safeInDay: false,
    effectiveSafe: -1,
    effectiveTraining: -1,
    effectiveDaily: -1,
    dailyInDay: -1,
  }))
  // 末日后残留（理论上不会出现）：并入最后一天
  if (accumulators.length === 0) {
    accumulators.push({
      firstSeq: 0,
      lastSeq: totalEvents,
      lastDate: null,
      blind: false,
      safeInDay: false,
      effectiveSafe: -1,
      effectiveTraining: -1,
      effectiveDaily: -1,
      dailyInDay: -1,
    })
  }

  let runningSafe = -1
  let runningTraining = -1
  let pointer = 0
  for (const [index, checkpoint] of file.checkpoints.entries()) {
    while (pointer + 1 < accumulators.length && checkpoint.afterSeq >= accumulators[pointer + 1]!.firstSeq) pointer += 1
    const day = accumulators[pointer]!
    const usable = checkpoint.training !== null && checkpoint.chart !== null
    if (usable) {
      runningSafe = index
      day.safeInDay = true
      day.effectiveSafe = index
    }
    if (checkpoint.training !== null) runningTraining = index
    // 日线是「当日当时已见」的观察而非累积持仓：只记当日段内的 1D 检查点
    if (checkpoint.chart?.timeframe === '1D') {
      day.dailyInDay = index
      day.effectiveDaily = index
    }
    day.effectiveTraining = runningTraining
    if (day.effectiveSafe === -1) day.effectiveSafe = runningSafe
    const meta = betterMeta(checkpoint, metas)
    if (meta?.date !== undefined && meta?.date !== null) day.lastDate = meta.date
    if (meta) day.blind = meta.blind
  }
  for (const [index, day] of accumulators.entries()) {
    if (index > 0) {
      const previous = accumulators[index - 1]!
      if (day.lastDate === null) day.lastDate = previous.lastDate
      if (day.effectiveSafe === -1) day.effectiveSafe = previous.effectiveSafe
      if (day.effectiveTraining === -1) day.effectiveTraining = previous.effectiveTraining
      if (day.effectiveDaily === -1 && previous.effectiveDaily >= 0) {
        // 当日段内没有日线观察时，只有证明借用检查点与当日同日才允许跨段沿用
        //（盲训无日期无从证明，如实缺日线），绝不把昨日日线冒充当日
        const candidateDate = checkpointMetaDate(file, metas, previous.effectiveDaily)
        if (candidateDate !== null && candidateDate === day.lastDate) day.effectiveDaily = previous.effectiveDaily
      }
    }
  }
  return {
    days: accumulators.map((day, index) => ({
      index,
      firstSeq: day.firstSeq,
      lastSeq: day.lastSeq,
      date: day.lastDate,
      blind: day.blind,
      safeInDay: day.safeInDay,
      effectiveSafe: day.effectiveSafe,
      effectiveTraining: day.effectiveTraining,
      effectiveDaily: day.effectiveDaily,
    })),
  }
}

/**
 * 从当日「当时已见的日线」聚合周（周一起始）/月K：开=首日开、高=最高、低=最低、收=末日收、
 * 量额求和；键与 server 端 aggregateBars 完全一致（Monday 键 / YYYY-MM）。只吃调用方传入的
 * 当日日线，不含任何未来数据；空输入返回空数组。
 */
export function aggregateDailyBars(daily: readonly Bar[], timeframe: '1W' | '1M'): Bar[] {
  const groups = new Map<string, Bar>()
  for (const bar of daily) {
    let key: string
    if (timeframe === '1M') {
      key = bar.date.slice(0, 7)
    } else {
      const day = new Date(`${bar.date}T00:00:00Z`)
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
      key = day.toISOString().slice(0, 10)
    }
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { ...bar, date: key })
      continue
    }
    if (bar.high > group.high) group.high = bar.high
    if (bar.low < group.low) group.low = bar.low
    group.close = bar.close
    group.volume += bar.volume
    group.amount += bar.amount
  }
  return [...groups.values()]
}

/** 某日解码后的最终状态（全部来自 afterSeq 不晚于当日末的检查点） */
export interface ReplayDayState {
  dayIndex: number
  /** 展示日期：元数据日期优先，盲训在有日线时回填真实末根日期，否则 T+序号 */
  date: string
  /** 当日范围内没有任何可用快照，展示的是此前最近一次已记录状态 */
  stale: boolean
  training: TrainingSnapshot | null
  drawings: Drawing[]
  /** 画线版本内容 id：内容寻址，跨日比较即可判断画线是否真的变化 */
  drawingsRef: string | null
  /** 覆盖当日的完整日线（末根日期=当日）；null＝该日没有当日日线 */
  dailyBars: Bar[] | null
  /** 无当日日线时的兜底：该日最后快照自身的周期与K线（旧文件只有周/月快照） */
  fallback: { timeframe: Timeframe; bars: Bar[] } | null
  costPrice: number | null
}

/** 当前日可观察的周期：有当日日线则三个周期都可（周月由前端聚合），否则只有兜底快照周期 */
export function availablePeriods(state: ReplayDayState): Timeframe[] {
  if (state.dailyBars) return ['1D', '1W', '1M']
  return state.fallback ? [state.fallback.timeframe] : []
}

/** 观察周期→实际K线：周月只从当日日线聚合；无当日日线时只回放该日快照自身的周期 */
export function observationBars(
  state: ReplayDayState,
  timeframe: Timeframe,
): { timeframe: Timeframe; bars: Bar[] } | null {
  if (state.dailyBars) {
    if (timeframe === '1D') return { timeframe, bars: state.dailyBars }
    return { timeframe, bars: aggregateDailyBars(state.dailyBars, timeframe) }
  }
  if (state.fallback && state.fallback.timeframe === timeframe) {
    return { timeframe, bars: state.fallback.bars }
  }
  return null
}

/** 业务操作条目：一天最多归属到其发生日，点击跳转该日 */
export interface BusinessItem {
  seq: number
  action: Action
  outcome: RecordingEventOutcome
  label: string
  dayIndex: number
}

function tradeLabel(event: RecordingEvent, started?: RecordingEvent): string {
  const params = (event.params ?? started?.params) as { side?: string; shares?: number } | undefined
  const result = event.result as { plan?: { side?: string; shares?: number; price?: number } } | undefined
  const plan = result?.plan
  const side = plan?.side ?? params?.side
  const sideText = side === 'sell' ? '卖出' : side === 'buy' ? '买入' : '交易'
  const shares = plan?.shares ?? params?.shares
  const price = plan?.price
  const parts = [sideText]
  if (typeof shares === 'number') parts.push(`${shares}股`)
  if (typeof price === 'number' && Number.isFinite(price)) parts.push(`@${price.toFixed(2)}`)
  return parts.join(' ')
}

function businessLabel(event: RecordingEvent, started?: RecordingEvent): string {
  if (event.action === 'training.trade') return tradeLabel(event, started)
  const params = (event.params ?? started?.params) as { name?: string } | undefined
  const base = BUSINESS_ACTION_LABELS[event.action]
  if (params?.name === 'textAnnotation') return `${base} · 文字标注`
  return base
}

function dayIndexForSeq(days: readonly ReplayDay[], seq: number): number {
  let low = 0
  let high = days.length - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (days[mid]!.firstSeq <= seq) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

class Lru<V> {
  private readonly map = new Map<string, V>()

  constructor(private readonly limit: number) {}

  get(key: number): V | undefined {
    const value = this.map.get(String(key))
    if (value !== undefined) {
      this.map.delete(String(key))
      this.map.set(String(key), value)
    }
    return value
  }

  set(key: number, value: V): void {
    this.map.delete(String(key))
    this.map.set(String(key), value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }
}

const DAY_STATE_CACHE_LIMIT = 16

/**
 * 单个录制文件的按日回放会话：惰性解码当日终态并限量缓存；业务操作列表一次算好。
 * 同一文件内复用同一个 CompactReader（其内部 LRU 复用版本展开结果）。
 */
export class DailyReplaySession {
  readonly index: DailyIndex

  readonly businessItems: BusinessItem[]

  private readonly reader: CompactReader

  private readonly states = new Lru<ReplayDayState>(DAY_STATE_CACHE_LIMIT)

  constructor(private readonly file: CompactRecordingFile) {
    this.reader = new CompactReader(file)
    this.index = buildDailyIndex(file)
    // 完成/拒绝事件只带 result，params 在配对的 started 事件上：先按 opId 配对再生成业务条目
    const startedByOpId = new Map(file.events.filter(event => event.phase === 'started').map(event => [event.opId, event]))
    this.businessItems = businessEvents(file.events)
      .map(event => ({
        seq: event.seq,
        action: event.action,
        outcome: event.outcome ?? 'unknown',
        label: businessLabel(event, startedByOpId.get(event.opId)),
        dayIndex: dayIndexForSeq(this.index.days, event.seq),
      }))
  }

  get dayCount(): number {
    return this.index.days.length
  }

  day(dayIndex: number): ReplayDay {
    return this.index.days[Math.min(Math.max(dayIndex, 0), this.index.days.length - 1)]!
  }

  /** 当日终态：同日重复访问走缓存；缓存淘汰后重解码结果一致（纯函数式展开） */
  state(dayIndex: number): ReplayDayState {
    const bounded = Math.min(Math.max(dayIndex, 0), this.index.days.length - 1)
    const cached = this.states.get(bounded)
    if (cached) return cached
    const decoded = this.decode(this.day(bounded))
    this.states.set(bounded, decoded)
    return decoded
  }

  private decode(day: ReplayDay): ReplayDayState {
    const safeCheckpoint = day.effectiveSafe >= 0 ? this.reader.checkpointAt(day.effectiveSafe) : null
    const trainingCheckpoint =
      day.effectiveTraining >= 0 && day.effectiveTraining !== day.effectiveSafe
        ? this.reader.checkpointAt(day.effectiveTraining)
        : safeCheckpoint
    const training = trainingCheckpoint?.training ?? null
    const chart = safeCheckpoint?.chart ?? null
    // 画线版本内容 id 是紧凑元数据（内容寻址），解码后的 ChartCapture 不携带，从 checkpoint 表直读
    const drawingsRef =
      day.effectiveSafe >= 0 ? this.file.checkpoints[day.effectiveSafe]?.chart?.drawingsRef ?? null : null
    const dailyCheckpoint =
      day.effectiveDaily >= 0 && day.effectiveDaily !== day.effectiveSafe
        ? this.reader.checkpointAt(day.effectiveDaily)
        : safeCheckpoint
    const dailyBars = dailyCheckpoint?.chart?.timeframe === '1D' ? dailyCheckpoint.chart.bars : null
    const referenceDate = training?.training.currentDate ?? day.date
    const dailyComplete =
      dailyBars !== null &&
      dailyBars.length > 0 &&
      (referenceDate === null || dailyBars[dailyBars.length - 1]!.date >= referenceDate)
    let date = day.date
    if (date === null && dailyComplete) date = dailyBars![dailyBars!.length - 1]!.date
    const blind = training?.training.blind ?? day.blind
    const stale = !day.safeInDay
    return {
      dayIndex: day.index,
      date: date ?? (blind ? `T+${day.index}` : '日期未知'),
      stale,
      training,
      drawings: chart?.drawings ?? [],
      drawingsRef,
      dailyBars: dailyComplete ? dailyBars : null,
      fallback:
        !dailyComplete && chart !== null
          ? { timeframe: chart.timeframe, bars: chart.bars }
          : null,
      costPrice: chart?.costPrice ?? null,
    }
  }
}
