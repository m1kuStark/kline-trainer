// REC-01 v2紧凑存储合同：web/src/recording/compactValidation.ts
// 纯校验（docs/engineering/recording-v2-contract.md「校验、文件封装」节）。
// 逐检查点/资源做有界校验并原样返回有效数据：不构造展开的v1会话，不重算业务，
// 不执行输入中的任何代码或 URL；gzip/文件封装属后续独立任务。
import type {
  CompactRecordingFile,
} from './compactTypes'
import {
  assertAccountView,
  assertArray,
  assertBar,
  assertChartView,
  assertDateOrNull,
  assertDrawing,
  assertEnum,
  assertEvent,
  assertEventPairing,
  assertInteger,
  assertJson,
  assertNumberOrNull,
  assertRecord,
  assertString,
  assertStringOrNull,
  assertTimestamp,
  assertTrade,
  assertTrainingMeta,
  assertBoolean,
  assertPositive,
  fail,
  isRecord,
  MAX_DRAWINGS,
  MAX_EVENTS,
  TIMEFRAMES,
} from './validation'

/** v2 检查点预算（合同「校验、文件封装」节）；事件预算沿用 v1 的 50000 */
const MAX_CHECKPOINTS = 20_000
/** 单个行情版本 bar 数组（base.bars / delta.upsert）上限 */
const MAX_SERIES_BARS = 20_000
/** 全资源 Bar 条目（base.bars 与所有 upsert 合计）上限 */
const MAX_RESOURCE_BARS = 1_000_000
/** 校验期唯一行情版本累计还原遍历预算；checkpoint 只查摘要，不重复计费 */
const MAX_RESTORE_BARS = 5_000_000
/** 同一基础链最大增量层数（第32层必须改存新基础） */
const MAX_DELTA_CHAIN = 31
/** 单个画线版本 items/upsert 数组上限 */
const MAX_DRAWING_ITEMS = 500

interface CheckedEventInfo {
  segmentId: string
  checkpointId: string | undefined
}

interface SeriesPlan {
  id: string
  field: string
  timeframe: string
  asOf: string | null
  firstCheckpoint: number
  baseIndex: number | null
  raw: Record<string, unknown>
}

interface DrawingPlan {
  id: string
  field: string
  baseIndex: number | null
  /** base 版本为 items 的 id 集合，delta 版本为 upsert 的 id 集合（数组内已去重） */
  ownIds: Set<string>
  /** delta 版本的 remove 键集合；base 版本为空集 */
  removes: Set<string>
  raw: Record<string, unknown>
}

/** 行情版本的已验证还原态：归一化日期严格递增，键 → 位置供增量覆写 */
interface SeriesState {
  dates: string[]
  posByKey: Map<string, number>
}

interface SeriesSummary {
  timeframe: string
  asOf: string | null
  firstCheckpoint: number
}

interface MetaCutoff {
  currentDate: string | null
  blind: boolean
  startDate: string
}

/** 训练截止（与codec deriveAsOf一致）：currentDate 优先，非盲无 currentDate 用 startDate，盲态未知为 null */
function deriveCutoff(meta: MetaCutoff): string | null {
  if (meta.currentDate !== null) return meta.currentDate
  return meta.blind ? null : meta.startDate
}

function assertAppAndEnvironment(value: Record<string, unknown>): void {
  const app = assertRecord(value.app, 'app')
  assertString(app.version, 'app.version')
  assertString(app.gitCommit, 'app.gitCommit')
  assertBoolean(app.dirty, 'app.dirty')
  assertString(app.chartLibrary, 'app.chartLibrary')

  const environment = assertRecord(value.environment, 'environment')
  assertString(environment.timezone, 'environment.timezone')
  const viewport = assertRecord(environment.viewport, 'environment.viewport')
  assertPositive(viewport.width, 'environment.viewport.width')
  assertPositive(viewport.height, 'environment.viewport.height')
  assertPositive(environment.dpr, 'environment.dpr')
}

/** 事件序列：白名单、seq连续、elapsedMs单调、started/finished配对；返回 segment/检查点引用 */
function assertEvents(value: Record<string, unknown>): { events: unknown[]; refs: CheckedEventInfo[]; segmentIds: Set<string> } {
  const events = assertArray(value.events, 'events')
  if (events.length > MAX_EVENTS) fail('events', `事件数量 ${events.length} 超过上限 ${MAX_EVENTS}`)
  const refs: CheckedEventInfo[] = []
  const segmentIds = new Set<string>()
  let lastElapsedMs = Number.NEGATIVE_INFINITY
  events.forEach((raw, index) => {
    const checked = assertEvent(raw, `events[${index}]`, index)
    if (checked.elapsedMs < lastElapsedMs) {
      fail(`events[${index}].elapsedMs`, `须全局单调不减（前一事件 ${lastElapsedMs}，本事件 ${checked.elapsedMs}）`)
    }
    lastElapsedMs = checked.elapsedMs
    segmentIds.add(checked.segmentId)
    refs.push({ segmentId: checked.segmentId, checkpointId: checked.checkpointId })
  })
  assertEventPairing(events, value.complete as boolean)
  return { events, refs, segmentIds }
}

function assertCompactCheckpoint(
  raw: unknown,
  field: string,
  eventCount: number,
  segmentIds: ReadonlySet<string>,
  checkpointIds: Map<string, number>,
): number {
  const checkpoint = assertRecord(raw, field)
  const id = assertString(checkpoint.id, `${field}.id`)
  if (checkpointIds.has(id)) fail(`${field}.id`, `检查点 id 重复（${id}）`)
  const afterSeq = assertInteger(checkpoint.afterSeq, `${field}.afterSeq`)
  if (afterSeq < 0 || afterSeq > eventCount) {
    fail(`${field}.afterSeq`, `须在 0..${eventCount} 范围内（收到 ${afterSeq}）`)
  }
  checkpointIds.set(id, afterSeq)
  const segmentId = assertString(checkpoint.segmentId, `${field}.segmentId`)
  // afterSeq=0 的初始检查点先于任何事件，segmentId 允许独立；afterSeq>0 必须能在事件中证实
  if (afterSeq > 0 && !segmentIds.has(segmentId)) {
    fail(`${field}.segmentId`, `未出现在任何事件中（${segmentId}）`)
  }
  assertTimestamp(checkpoint.capturedAt, `${field}.capturedAt`)

  const ui = assertRecord(checkpoint.ui, `${field}.ui`)
  assertString(ui.theme, `${field}.ui.theme`)
  assertStringOrNull(ui.tool, `${field}.ui.tool`)
  assertString(ui.magnet, `${field}.ui.magnet`)
  assertBoolean(ui.multiSelect, `${field}.ui.multiSelect`)

  if (checkpoint.training !== null) {
    const training = assertRecord(checkpoint.training, `${field}.training`)
    assertString(training.metaRef, `${field}.training.metaRef`)
    assertString(training.accountRef, `${field}.training.accountRef`)
    const tradeRefs = assertArray(training.tradeRefs, `${field}.training.tradeRefs`)
    tradeRefs.forEach((ref, index) => assertString(ref, `${field}.training.tradeRefs[${index}]`))
  }
  if (checkpoint.chart !== null) {
    const chart = assertRecord(checkpoint.chart, `${field}.chart`)
    assertEnum(chart.timeframe, `${field}.chart.timeframe`, TIMEFRAMES)
    assertString(chart.seriesRef, `${field}.chart.seriesRef`)
    assertString(chart.drawingsRef, `${field}.chart.drawingsRef`)
    assertChartView(chart.view, `${field}.chart.view`)
    assertNumberOrNull(chart.costPrice, `${field}.chart.costPrice`)
  }
  if (checkpoint.contextRef !== null) assertString(checkpoint.contextRef, `${field}.contextRef`)
  return afterSeq
}

/** checkpoints 结构与预算；afterSeq 顺序不变，返回 id → afterSeq */
function assertCompactCheckpoints(value: Record<string, unknown>, eventCount: number, segmentIds: ReadonlySet<string>): Map<string, number> {
  const checkpoints = assertArray(value.checkpoints, 'checkpoints')
  if (checkpoints.length > MAX_CHECKPOINTS) {
    fail('checkpoints', `检查点数量 ${checkpoints.length} 超过上限 ${MAX_CHECKPOINTS}`)
  }
  const checkpointIds = new Map<string, number>()
  let previousAfterSeq = 0
  checkpoints.forEach((raw, index) => {
    const field = `checkpoints[${index}]`
    const afterSeq = assertCompactCheckpoint(raw, field, eventCount, segmentIds, checkpointIds)
    if (afterSeq < previousAfterSeq) {
      fail(`${field}.afterSeq`, `须按 afterSeq 非递减（前值 ${previousAfterSeq}，收到 ${afterSeq}），同 seq 允许多个更完整状态`)
    }
    previousAfterSeq = afterSeq
  })
  return checkpointIds
}

function assertEventCheckpointRefs(refs: CheckedEventInfo[], checkpointIds: Map<string, number>): void {
  refs.forEach(({ checkpointId }, index) => {
    if (checkpointId === undefined) return
    const afterSeq = checkpointIds.get(checkpointId)
    if (afterSeq === undefined) {
      fail(`events[${index}].checkpointId`, `引用了不存在的检查点 id（${checkpointId}）`)
    }
    if (afterSeq !== undefined && afterSeq > index + 1) {
      fail(`events[${index}].checkpointId`, `指向未来快照（检查点 afterSeq=${afterSeq} 晚于事件 seq=${index + 1}）`)
    }
  })
}

/** gaps 与 v1 同语义：afterSeq 严格递增、范围合法、未闭合 gap 必须在末尾且禁 complete */
function assertGaps(value: Record<string, unknown>, eventCount: number): void {
  const gaps = assertArray(value.gaps, 'gaps')
  let previousGapAfterSeq = -1
  let hasOpenGap = false
  gaps.forEach((raw, index) => {
    const gap = assertRecord(raw, `gaps[${index}]`)
    const field = `gaps[${index}]`
    const afterSeq = assertInteger(gap.afterSeq, `${field}.afterSeq`)
    if (afterSeq < 0 || afterSeq > eventCount) {
      fail(`${field}.afterSeq`, `须在 0..${eventCount} 范围内（0 表示自开始未录制，收到 ${afterSeq}）`)
    }
    if (afterSeq <= previousGapAfterSeq) {
      fail(`${field}.afterSeq`, `gaps 须按 afterSeq 严格递增（前值 ${previousGapAfterSeq}，收到 ${afterSeq}），afterSeq=0 仅允许用于首个 gap`)
    }
    if (hasOpenGap) fail(field, '未闭合 gap（resumedAtSeq=null）必须位于末尾，其后不得再有 gap')
    if (gap.resumedAtSeq === null) {
      hasOpenGap = true
    } else {
      const resumedAtSeq = assertInteger(gap.resumedAtSeq, `${field}.resumedAtSeq`)
      if (resumedAtSeq <= afterSeq) fail(`${field}.resumedAtSeq`, `必须大于 afterSeq（${afterSeq}）`)
      if (resumedAtSeq > eventCount) {
        fail(`${field}.resumedAtSeq`, `超出事件范围（最大 ${eventCount}，收到 ${resumedAtSeq}）`)
      }
      const previous = gaps[index - 1] as { resumedAtSeq?: unknown } | undefined
      if (index > 0 && typeof previous?.resumedAtSeq === 'number' && previous.resumedAtSeq > afterSeq) {
        fail(`${field}.afterSeq`, `与前一个 gap 重叠（前一 gap 恢复于 seq ${previous.resumedAtSeq}，本 gap 开始于 seq ${afterSeq}）`)
      }
    }
    previousGapAfterSeq = afterSeq
  })
  if (hasOpenGap && (value.complete as boolean)) {
    fail('complete', '存在未闭合的 gap（resumedAtSeq=null，录制自该处停止），complete 不能为 true')
  }
}

/** 内容寻址表：id 非空且表内唯一，value 走对应旧语义校验；返回 id 集合 */
function assertValueTable(
  raw: unknown,
  field: string,
  validateValue: (value: unknown, valueField: string) => void,
): Set<string> {
  const entries = assertArray(raw, field)
  const ids = new Set<string>()
  entries.forEach((entryRaw, index) => {
    const entryField = `${field}[${index}]`
    const entry = assertRecord(entryRaw, entryField)
    const id = assertString(entry.id, `${entryField}.id`)
    if (ids.has(id)) fail(`${entryField}.id`, `资源id重复（${id}）`)
    ids.add(id)
    validateValue(entry.value, `${entryField}.value`)
  })
  return ids
}

/**
 * 行情版本计划：id 唯一、base 必须先出现（前向引用/环不可能）、同周期、链深≤31、
 * 基础已知asOf不得晚于派生、firstCheckpoint 是检查点下标。
 */
function planSeries(resources: Record<string, unknown>, checkpointCount: number): SeriesPlan[] {
  const series = assertArray(resources.series, 'resources.series') as unknown[]
  const plans: SeriesPlan[] = []
  const indexById = new Map<string, number>()
  // 第一遍：id 唯一与版本自身字段；base 存在性延后到 id 集合完整后判定
  series.forEach((raw, index) => {
    const field = `resources.series[${index}]`
    const version = assertRecord(raw, field)
    const id = assertString(version.id, `${field}.id`)
    if (indexById.has(id)) fail(`${field}.id`, `行情版本id重复（${id}）`)
    indexById.set(id, index)
    const timeframe = assertEnum(version.timeframe, `${field}.timeframe`, TIMEFRAMES)
    const asOf = assertDateOrNull(version.asOf, `${field}.asOf`)
    const firstCheckpoint = assertInteger(version.firstCheckpoint, `${field}.firstCheckpoint`)
    if (firstCheckpoint < 0 || firstCheckpoint >= checkpointCount) {
      fail(`${field}.firstCheckpoint`, `须是检查点数组下标（0..${checkpointCount - 1}，收到 ${firstCheckpoint}）`)
    }
    plans.push({ id, field, timeframe, asOf, firstCheckpoint, baseIndex: null, raw: version })
  })
  // 第二遍：base 存在且下标更早，随后递推链深与 asOf 单调
  const depths = new Array<number>(plans.length).fill(0)
  plans.forEach((plan, index) => {
    if (plan.raw.base === null) return
    const baseId = assertString(plan.raw.base, `${plan.field}.base`)
    const baseIndex = indexById.get(baseId)
    if (baseIndex === undefined) fail(`${plan.field}.base`, `引用的基础版本不存在（${baseId}）`)
    if (baseIndex >= index) fail(`${plan.field}.base`, `基础版本必须先出现（${baseId} 在下标 ${baseIndex}，当前版本在下标 ${index}）`)
    plan.baseIndex = baseIndex
    const base = plans[baseIndex] as SeriesPlan
    if (base.timeframe !== plan.timeframe) {
      fail(`${plan.field}.base`, `基础版本周期必须一致（base ${base.timeframe}，当前 ${plan.timeframe}）`)
    }
    // 派生还原包含基础内容：基础不得比派生更晚可用；无 asOf 条件，恢复/盲态不豁免
    if (base.firstCheckpoint > plan.firstCheckpoint) {
      fail(
        `${plan.field}.firstCheckpoint`,
        `基础版本firstCheckpoint（${base.firstCheckpoint}）不得晚于派生（${plan.firstCheckpoint}），派生还原包含基础内容`,
      )
    }
    depths[index] = depths[baseIndex] + 1
    if (depths[index] > MAX_DELTA_CHAIN) {
      fail(`${plan.field}.base`, `增量链深 ${depths[index]} 超过上限 ${MAX_DELTA_CHAIN} 层，必须改存新全量基础`)
    }
    if (base.asOf !== null && plan.asOf !== null && base.asOf > plan.asOf) {
      fail(`${plan.field}.asOf`, `基础已知asOf不得晚于派生（base ${base.asOf}，当前 ${plan.asOf}）`)
    }
  })
  return plans
}

function buildSeriesBaseState(plan: SeriesPlan, restoreBars: { count: number }): SeriesState {
  const bars = assertArray(plan.raw.bars, `${plan.field}.bars`)
  if (bars.length > MAX_SERIES_BARS) {
    fail(`${plan.field}.bars`, `bar数量 ${bars.length} 超过上限 ${MAX_SERIES_BARS}`)
  }
  const dates: string[] = []
  const posByKey = new Map<string, number>()
  bars.forEach((raw, index) => {
    const date = assertBar(raw, `${plan.field}.bars[${index}]`, plan.timeframe)
    if (index > 0 && date <= (dates[index - 1] as string)) {
      fail(`${plan.field}.bars[${index}].date`, `必须严格按日期递增（前值 ${dates[index - 1]}，收到 ${date}）`)
    }
    posByKey.set((raw as { date: string }).date, index)
    dates.push(date)
  })
  restoreBars.count += dates.length
  return { dates, posByKey }
}

/** 应用增量：按日期键覆写、新键尾插（与codec applyDelta一致），remove 过滤后必须整体严格递增 */
function applySeriesDelta(
  plan: SeriesPlan,
  parent: SeriesState,
  restoreBars: { count: number },
): SeriesState {
  const upsert = assertArray(plan.raw.upsert, `${plan.field}.upsert`)
  if (upsert.length > MAX_SERIES_BARS) {
    fail(`${plan.field}.upsert`, `upsert bar数量 ${upsert.length} 超过上限 ${MAX_SERIES_BARS}`)
  }
  const removes = assertArray(plan.raw.remove, `${plan.field}.remove`)
  const dates = parent.dates.slice()
  const posByKey = new Map(parent.posByKey)
  upsert.forEach((raw, index) => {
    const date = assertBar(raw, `${plan.field}.upsert[${index}]`, plan.timeframe)
    const key = (raw as { date: string }).date
    const at = posByKey.get(key)
    if (at === undefined) {
      posByKey.set(key, dates.length)
      dates.push(date)
    } else {
      dates[at] = date
    }
  })
  if (removes.length > 0) {
    const drop = new Set<string>()
    removes.forEach((key, index) => {
      const text = assertString(key, `${plan.field}.remove[${index}]`)
      if (drop.has(text)) fail(`${plan.field}.remove[${index}]`, `重复的移除键（${text}）`)
      drop.add(text)
    })
    const keptDates: string[] = []
    const keptPos = new Map<string, number>()
    for (const [key, at] of posByKey) {
      if (!drop.has(key)) {
        keptPos.set(key, keptDates.length)
        keptDates.push(dates[at] as string)
      }
    }
    dates.length = 0
    dates.push(...keptDates)
    posByKey.clear()
    for (const [key, at] of keptPos) posByKey.set(key, at)
  }
  // base.bars/upsert 单数组预算不含 remove 抵消：还原后的完整数组同样受限
  if (dates.length > MAX_SERIES_BARS) {
    fail(plan.field, `还原后bar数量 ${dates.length} 超过上限 ${MAX_SERIES_BARS}`)
  }
  restoreBars.count += dates.length + upsert.length + removes.length
  dates.forEach((date, index) => {
    if (index > 0 && date <= (dates[index - 1] as string)) {
      fail(`${plan.field}`, `还原后bar日期必须严格递增（位置 ${index - 1} 为 ${dates[index - 1]}，位置 ${index} 为 ${date}）`)
    }
  })
  return { dates, posByKey }
}

/**
 * 按唯一版本还原一次并缓存摘要：状态只保留仍被后续版本引用的祖先（引用计数释放），
 * checkpoint 阶段只查摘要/asOf/引用，不重复展开。
 */
function resolveSeries(
  plans: SeriesPlan[],
  resourceBars: { count: number },
): { summaries: Map<string, SeriesSummary>; restoreBars: number } {
  const restoreBars = { count: 0 }
  const pendingUses = new Map<number, number>()
  plans.forEach(plan => {
    if (plan.baseIndex !== null) pendingUses.set(plan.baseIndex, (pendingUses.get(plan.baseIndex) ?? 0) + 1)
  })
  const states = new Map<number, SeriesState>()
  const summaries = new Map<string, SeriesSummary>()
  plans.forEach((plan, index) => {
    let state: SeriesState
    if (plan.baseIndex === null) {
      state = buildSeriesBaseState(plan, restoreBars)
      resourceBars.count += (plan.raw.bars as unknown[]).length
    } else {
      const parent = states.get(plan.baseIndex)
      if (!parent) fail(plan.field, '内部错误：基础版本状态缺失')
      state = applySeriesDelta(plan, parent as SeriesState, restoreBars)
      resourceBars.count += (plan.raw.upsert as unknown[]).length
      const used = (pendingUses.get(plan.baseIndex) ?? 1) - 1
      if (used <= 0) {
        pendingUses.delete(plan.baseIndex)
        states.delete(plan.baseIndex)
      } else {
        pendingUses.set(plan.baseIndex, used)
      }
    }
    if (resourceBars.count > MAX_RESOURCE_BARS) {
      fail('resources.series', `全资源Bar条目 ${resourceBars.count} 超过上限 ${MAX_RESOURCE_BARS}`)
    }
    if (restoreBars.count > MAX_RESTORE_BARS) {
      fail('resources.series', `校验期累计还原 ${restoreBars.count} 条Bar超过预算 ${MAX_RESTORE_BARS}（按唯一版本计费）`)
    }
    const asOf = plan.asOf
    if (asOf !== null) {
      state.dates.forEach((date, position) => {
        if (date > asOf) {
          fail(`${plan.field}`, `还原后包含晚于asOf（${asOf}）的bar（位置 ${position} 日期 ${date}），不得回填未来行情`)
        }
      })
    }
    if (pendingUses.has(index)) states.set(index, state)
    summaries.set(plan.id, { timeframe: plan.timeframe, asOf: plan.asOf, firstCheckpoint: plan.firstCheckpoint })
  })
  return { summaries, restoreBars: restoreBars.count }
}

/**
 * 画线版本：id 唯一、base 先出现、链深≤31、items/upsert 图形走旧语义（工具白名单/engine mark排除）、
 * remove 键唯一；还原 id 集合每版本 ≤500（覆盖已有 id 不新增、remove 先扣除）。
 * 还原顺序无语义（Reader 按 id 规范序重放），不做排序约束。
 */
function planDrawings(resources: Record<string, unknown>): Map<string, number> {
  const drawings = assertArray(resources.drawings, 'resources.drawings') as unknown[]
  const indexById = new Map<string, number>()
  const plans: DrawingPlan[] = []
  // 第一遍：id 唯一与版本自身内容；base 存在性延后到 id 集合完整后判定
  drawings.forEach((raw, index) => {
    const field = `resources.drawings[${index}]`
    const version = assertRecord(raw, field)
    const id = assertString(version.id, `${field}.id`)
    if (indexById.has(id)) fail(`${field}.id`, `画线版本id重复（${id}）`)
    indexById.set(id, index)
    let ownIds: Set<string>
    let removes: Set<string>
    if (version.base === null) {
      const items = assertArray(version.items, `${field}.items`)
      if (items.length > MAX_DRAWING_ITEMS) {
        fail(`${field}.items`, `画线数量 ${items.length} 超过上限 ${MAX_DRAWING_ITEMS}`)
      }
      ownIds = new Set<string>()
      items.forEach((item, itemIndex) => assertDrawing(item, `${field}.items[${itemIndex}]`, ownIds))
      removes = new Set<string>()
    } else {
      const upsert = assertArray(version.upsert, `${field}.upsert`)
      if (upsert.length > MAX_DRAWING_ITEMS) {
        fail(`${field}.upsert`, `upsert画线数量 ${upsert.length} 超过上限 ${MAX_DRAWING_ITEMS}`)
      }
      ownIds = new Set<string>()
      upsert.forEach((item, itemIndex) => assertDrawing(item, `${field}.upsert[${itemIndex}]`, ownIds))
      removes = new Set<string>()
      const removeKeys = assertArray(version.remove, `${field}.remove`)
      removeKeys.forEach((key, keyIndex) => {
        const text = assertString(key, `${field}.remove[${keyIndex}]`)
        if (removes.has(text)) fail(`${field}.remove[${keyIndex}]`, `重复的移除键（${text}）`)
        removes.add(text)
      })
    }
    plans.push({ id, field, baseIndex: null, ownIds, removes, raw: version })
  })
  // 第二遍：base 存在且下标更早，链深递推；按还原 id 集合检查每版本 ≤500，
  // 状态仅在仍被后续版本引用时保留（引用计数释放，与 resolveSeries 同策略）
  const depths = new Array<number>(plans.length).fill(0)
  const restoredSets = new Map<number, Set<string>>()
  const pendingUses = new Map<number, number>()
  // baseIndex 在主循环中才解析，预扫按 base id 换算下标；缺失/前向引用交由主循环报错
  plans.forEach(plan => {
    if (typeof plan.raw.base !== 'string') return
    const baseIndex = indexById.get(plan.raw.base)
    if (baseIndex === undefined) return
    pendingUses.set(baseIndex, (pendingUses.get(baseIndex) ?? 0) + 1)
  })
  plans.forEach((plan, index) => {
    let restored: Set<string>
    if (plan.raw.base === null) {
      restored = plan.ownIds
    } else {
      const baseId = assertString(plan.raw.base, `${plan.field}.base`)
      const baseIndex = indexById.get(baseId)
      if (baseIndex === undefined) fail(`${plan.field}.base`, `引用的基础版本不存在（${baseId}）`)
      if (baseIndex >= index) fail(`${plan.field}.base`, `基础版本必须先出现（${baseId} 在下标 ${baseIndex}，当前版本在下标 ${index}）`)
      plan.baseIndex = baseIndex
      depths[index] = depths[baseIndex] + 1
      if (depths[index] > MAX_DELTA_CHAIN) {
        fail(`${plan.field}.base`, `增量链深 ${depths[index]} 超过上限 ${MAX_DELTA_CHAIN} 层，必须改存新全量基础`)
      }
      const parent = restoredSets.get(baseIndex)
      if (!parent) fail(plan.field, '内部错误：基础画线集合缺失')
      restored = new Set(parent)
      plan.removes.forEach(key => restored.delete(key))
      plan.ownIds.forEach(owned => restored.add(owned))
      if (restored.size > MAX_DRAWING_ITEMS) {
        fail(plan.field, `还原后画线数量 ${restored.size} 超过上限 ${MAX_DRAWING_ITEMS}`)
      }
      const used = (pendingUses.get(baseIndex) ?? 1) - 1
      if (used <= 0) {
        pendingUses.delete(baseIndex)
        restoredSets.delete(baseIndex)
      } else {
        pendingUses.set(baseIndex, used)
      }
    }
    if (pendingUses.has(index)) restoredSets.set(index, restored)
  })
  return indexById
}

/**
 * 校验v2紧凑录制文件；失败抛中文可行动错误，通过则原样返回（不重排、不克隆、不修改输入）。
 * 结构/预算/引用按合同逐项检查，还原遍历按唯一行情版本计费。
 */
export function validateCompactRecording(value: unknown): CompactRecordingFile {
  if (!isRecord(value)) fail('顶层', '必须是 JSON 对象')
  assertJson(value, '', 1)

  if (value.format !== 'trainer-session') {
    fail('format', `必须是 'trainer-session'（收到 ${JSON.stringify(value.format)}）`)
  }
  if (value.schemaVersion !== 2) {
    fail('schemaVersion', `必须是 2（收到 ${JSON.stringify(value.schemaVersion)}）`)
  }
  assertString(value.sessionId, 'sessionId')
  assertTimestamp(value.createdAt, 'createdAt')
  assertAppAndEnvironment(value)
  assertStringOrNull(value.trainingKey, 'trainingKey')
  assertBoolean(value.complete, 'complete')

  const { events, refs, segmentIds } = assertEvents(value)
  const checkpointIds = assertCompactCheckpoints(value, events.length, segmentIds)
  assertEventCheckpointRefs(refs, checkpointIds)
  assertGaps(value, events.length)

  const resourcesRaw = assertRecord(value.resources, 'resources')
  const checkpoints = value.checkpoints as unknown[]
  const metaIds = assertValueTable(resourcesRaw.trainingMeta, 'resources.trainingMeta', (meta, field) => {
    assertTrainingMeta(meta, field)
  })
  const accountIds = assertValueTable(resourcesRaw.accounts, 'resources.accounts', (account, field) => {
    assertAccountView(account, field)
  })
  const tradeIds = assertValueTable(resourcesRaw.trades, 'resources.trades', (trade, field) => {
    assertTrade(trade, field)
  })
  const contextIds = assertValueTable(resourcesRaw.contexts, 'resources.contexts', () => {
    // context 为自由 JsonValue（无外部执行/读路径），全树 assertJson 已覆盖
  })
  // 训练截止推导所需的元数据字段（currentDate/blind/startDate）
  const metaCutoffs = new Map<string, MetaCutoff>()
  ;(resourcesRaw.trainingMeta as unknown[]).forEach(entryRaw => {
    const entry = entryRaw as { id: string; value: Record<string, unknown> }
    const meta = entry.value
    metaCutoffs.set(entry.id, {
      currentDate: (meta.currentDate ?? null) as string | null,
      blind: Boolean(meta.blind),
      startDate: meta.startDate as string,
    })
  })

  const seriesPlans = planSeries(resourcesRaw, checkpoints.length)
  const drawingIds = planDrawings(resourcesRaw)
  const resourceBars = { count: 0 }
  const { summaries } = resolveSeries(seriesPlans, resourceBars)

  // 每个检查点只查摘要/asOf/引用：O(1)，不重复还原
  checkpoints.forEach((raw, index) => {
    const checkpoint = raw as Record<string, unknown>
    if (checkpoint.training !== null) {
      const training = checkpoint.training as { metaRef: string; accountRef: string; tradeRefs: string[] }
      if (!metaIds.has(training.metaRef)) {
        fail(`checkpoints[${index}].training.metaRef`, `引用的训练元数据 ${training.metaRef} 不存在`)
      }
      if (!accountIds.has(training.accountRef)) {
        fail(`checkpoints[${index}].training.accountRef`, `引用的账户视图 ${training.accountRef} 不存在`)
      }
      training.tradeRefs.forEach((ref, tradeIndex) => {
        if (!tradeIds.has(ref)) {
          fail(`checkpoints[${index}].training.tradeRefs[${tradeIndex}]`, `引用的成交视图 ${ref} 不存在`)
        }
      })
    }
    if (checkpoint.chart !== null) {
      const chart = checkpoint.chart as { timeframe: unknown; seriesRef: string; drawingsRef: string }
      const summary = summaries.get(chart.seriesRef)
      if (!summary) {
        fail(`checkpoints[${index}].chart.seriesRef`, `引用的行情版本 ${chart.seriesRef} 不存在`)
      } else {
        if (chart.timeframe !== summary.timeframe) {
          fail(
            `checkpoints[${index}].chart.timeframe`,
            `周期须与引用的行情版本一致（chart ${String(chart.timeframe)}，版本 ${summary.timeframe}）`,
          )
        }
        if (index < summary.firstCheckpoint) {
          fail(
            `checkpoints[${index}].chart.seriesRef`,
            `引用的行情版本 firstCheckpoint=${summary.firstCheckpoint} 晚于当前检查点下标 ${index}，不得回填未来步骤`,
          )
        }
        if (checkpoint.training !== null) {
          const training = checkpoint.training as { metaRef: string }
          const meta = metaCutoffs.get(training.metaRef)
          if (meta) {
            const cutoff = deriveCutoff(meta)
            if (cutoff !== null) {
              if (summary.asOf === null) {
                fail(`checkpoints[${index}].chart.seriesRef`, `已知截止（${cutoff}）的检查点不得引用asOf=null的行情版本 ${chart.seriesRef}`)
              } else if (summary.asOf > cutoff) {
                fail(`checkpoints[${index}].chart.seriesRef`, `行情版本asOf（${summary.asOf}）晚于检查点截止（${cutoff}），不得引用未来行情`)
              }
            }
          }
        }
      }
      if (!drawingIds.has(chart.drawingsRef)) {
        fail(`checkpoints[${index}].chart.drawingsRef`, `引用的画线版本 ${chart.drawingsRef} 不存在`)
      }
    }
    if (checkpoint.contextRef !== null) {
      const contextRef = checkpoint.contextRef as string
      if (!contextIds.has(contextRef)) {
        fail(`checkpoints[${index}].contextRef`, `引用的训练context ${contextRef} 不存在`)
      }
    }
  })

  return value as unknown as CompactRecordingFile
}
