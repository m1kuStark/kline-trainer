// REC-VALIDATE：RecordingFile 校验/解析/导出（docs/engineering/recording-contract.md）
// parse 与 export 统一走 validateRecording；本模块只做纯数据校验，不执行输入中的任何代码或 URL。
import { ACTIONS } from './types'
import { DRAW_TOOLS } from '../drawTools'
import type { ChartCapture, RecordingFile } from './types'
import type { TrainingSnapshot } from '../api'

const MAX_BYTES = 25 * 1024 * 1024
export const MAX_EVENTS = 50_000
const MAX_CHECKPOINTS = 2_000
const MAX_DEPTH = 40
export const MAX_DRAWINGS = 500
export const MAX_DRAWING_POINTS = 256

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS)
const DRAWING_NAMES: ReadonlySet<string> = new Set(DRAW_TOOLS.map(tool => tool.name))
const DRAWING_PANES: ReadonlySet<string> = new Set(['candle_pane', 'VOL', 'MACD'])
const PHASES: ReadonlySet<string> = new Set(['started', 'finished'])
const SOURCES: ReadonlySet<string> = new Set(['ui', 'keyboard', 'chart', 'system'])
const OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'rejected', 'failed', 'cancelled', 'interrupted', 'unknown'])
export const TIMEFRAMES: ReadonlySet<string> = new Set(['1D', '1W', '1M'])
const TIERS: ReadonlySet<string> = new Set(['1M', '3M', '6M', '1Y', '2Y'])
const TRAINING_STATUS: ReadonlySet<string> = new Set(['running', 'settled', 'abandoned'])
const ADJUST_MODES: ReadonlySet<string> = new Set(['forward', 'raw'])
const TRADE_SIDES: ReadonlySet<string> = new Set(['buy', 'sell'])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MONTH_PATTERN = /^\d{4}-\d{2}$/
const OHLC_KEYS = ['open', 'high', 'low', 'close', 'volume', 'amount'] as const
const ACCOUNT_KEYS = ['cash', 'shares', 'availableShares', 'marketValue', 'equity'] as const

export function fail(field: string, reason: string): never {
  throw new Error(`录制文件校验失败：${field ? `${field} ` : ''}${reason}`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function joinField(field: string, key: string): string {
  return field ? `${field}.${key}` : key
}

/** 全树 JSON 安全检查：有限数值、无 undefined/函数/非纯对象，嵌套深度受限 */
export function assertJson(value: unknown, field: string, depth: number): void {
  if (depth > MAX_DEPTH) fail(field, `嵌套深度超过 ${MAX_DEPTH} 层`)
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        fail(field, '数值必须有限（NaN/Infinity 无法被 JSON 安全序列化，JSON.stringify 会静默写成 null）')
      }
      return
    case 'object':
      if (value === null) return
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJson(item, `${field}[${index}]`, depth + 1))
        return
      }
      if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) assertJson(item, joinField(field, key), depth + 1)
        return
      }
      fail(field, `仅支持纯 JSON 对象/数组（收到 ${(value as object).constructor?.name ?? '未知对象'}）`)
      return
    case 'undefined':
      fail(field, '含 undefined，无法被 JSON 安全序列化（JSON.stringify 会静默丢弃该值）')
      return
    default:
      fail(field, `类型 ${typeof value} 不能被 JSON 序列化`)
  }
}

export function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(field, '必须是 JSON 对象')
  return value
}

export function assertArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field, '必须是数组')
  return value
}

export function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(field, '必须是非空字符串')
  return value
}

export function assertStringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null
  return assertString(value, field)
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, '必须是布尔值')
  return value
}

export function assertFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, '必须是有限数值')
  return value
}

export function assertNumberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null
  return assertFinite(value, field)
}

export function assertInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, '必须是整数')
  return value
}

export function assertPositive(value: unknown, field: string): number {
  const number = assertFinite(value, field)
  if (number <= 0) fail(field, `必须是正数（收到 ${number}）`)
  return number
}

export function assertEnum(value: unknown, field: string, allowed: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail(field, `必须是 ${[...allowed].join('/')} 之一（收到 ${JSON.stringify(value)}）`)
  }
  return value
}

export function assertDate(value: unknown, field: string): string {
  const text = assertString(value, field)
  if (!DATE_PATTERN.test(text)) fail(field, `日期须为 YYYY-MM-DD 格式（收到 ${JSON.stringify(text)}）`)
  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    fail(field, `不是有效的日历日期（${text}）`)
  }
  return text
}

export function assertDateOrNull(value: unknown, field: string): string | null {
  if (value === null) return null
  return assertDate(value, field)
}

/** bar 日期：1D/1W 为 YYYY-MM-DD；1M 允许后端月键 YYYY-MM，统一归一月月初便于截止比较 */
export function assertBarDate(value: unknown, field: string, timeframe: string): string {
  if (typeof value === 'string' && timeframe === '1M' && MONTH_PATTERN.test(value)) {
    const month = Number(value.slice(5, 7))
    if (month >= 1 && month <= 12) return `${value}-01`
    fail(field, `不是有效的月份（${value}）`)
  }
  return assertDate(value, field)
}

export function assertTimestamp(value: unknown, field: string): string {
  const text = assertString(value, field)
  if (Number.isNaN(Date.parse(text))) fail(field, `时间须为可解析的日期时间字符串（收到 ${JSON.stringify(text)}）`)
  return text
}

interface CheckedEvent {
  segmentId: string
  checkpointId: string | undefined
  elapsedMs: number
}

export function assertEvent(raw: unknown, field: string, index: number): CheckedEvent {
  const event = assertRecord(raw, field)
  assertInteger(event.seq, `${field}.seq`)
  if (event.seq !== index + 1) {
    fail(`${field}.seq`, `必须从 1 连续递增（位置 ${index} 期望 ${index + 1}，实际 ${JSON.stringify(event.seq)}）`)
  }
  assertString(event.opId, `${field}.opId`)
  const segmentId = assertString(event.segmentId, `${field}.segmentId`)
  const elapsedMs = assertFinite(event.elapsedMs, `${field}.elapsedMs`)
  if (elapsedMs < 0) fail(`${field}.elapsedMs`, '不能为负数')
  const phase = assertEnum(event.phase, `${field}.phase`, PHASES)
  if (typeof event.action !== 'string' || !ACTION_SET.has(event.action)) {
    fail(`${field}.action`, `不在动作白名单内（收到 ${JSON.stringify(event.action)}）`)
  }
  assertEnum(event.source, `${field}.source`, SOURCES)
  if (phase === 'started') {
    if (event.outcome !== undefined) fail(`${field}.outcome`, 'started 事件不得携带 outcome')
  } else if (event.outcome === undefined) {
    fail(`${field}.outcome`, 'finished 事件必须携带 outcome')
  } else {
    assertEnum(event.outcome, `${field}.outcome`, OUTCOMES)
  }
  const checkpointId = event.checkpointId === undefined ? undefined : assertString(event.checkpointId, `${field}.checkpointId`)
  // params/result 为 JsonValue，已由 assertJson 全树校验
  return { segmentId, checkpointId, elapsedMs }
}

interface PairingKey {
  action: unknown
  source: unknown
  segmentId: unknown
}

export function assertEventPairing(events: unknown[], complete: boolean): void {
  const started = new Map<string, PairingKey>()
  const finished = new Set<string>()
  events.forEach((raw, index) => {
    const event = raw as { opId: string; phase: string; action: unknown; source: unknown; segmentId: unknown }
    const field = `events[${index}].opId`
    if (event.phase === 'started') {
      if (started.has(event.opId)) fail(field, `started 重复（opId ${event.opId}）`)
      started.set(event.opId, { action: event.action, source: event.source, segmentId: event.segmentId })
      return
    }
    const opened = started.get(event.opId)
    if (!opened) fail(field, `finished 缺少配对的 started（opId ${event.opId}）`)
    if (finished.has(event.opId)) fail(field, `finished 重复（opId ${event.opId}）`)
    if (opened && (opened.action !== event.action || opened.source !== event.source || opened.segmentId !== event.segmentId)) {
      fail(field, `finished 与 started 的 action/source/segmentId 必须一致（opId ${event.opId}）`)
    }
    finished.add(event.opId)
  })
  const dangling = [...started.keys()].filter(opId => !finished.has(opId))
  if (dangling.length > 0 && complete) {
    fail('complete', `存在未闭合的 started 操作（opId ${dangling.join('、')}），中断尾段未闭合时 complete 不能为 true`)
  }
}

export function assertBar(raw: unknown, field: string, timeframe: string): string {
  const bar = assertRecord(raw, field)
  const date = assertBarDate(bar.date, `${field}.date`, timeframe)
  for (const key of OHLC_KEYS) assertFinite(bar[key], `${field}.${key}`)
  return date
}

export function assertDrawing(raw: unknown, field: string, drawingIds: Set<string>): void {
  const drawing = assertRecord(raw, field)
  const id = assertString(drawing.id, `${field}.id`)
  if (drawingIds.has(id)) fail(`${field}.id`, `画线 id 重复（${id}）`)
  drawingIds.add(id)
  const name = assertString(drawing.name, `${field}.name`)
  if (!DRAWING_NAMES.has(name)) {
    fail(`${field}.name`, `不在 drawTools 注册集合内（收到 ${name}，引擎内置 bsMark/costLine 不得进入录制）`)
  }
  const paneId = assertString(drawing.paneId, `${field}.paneId`)
  if (!DRAWING_PANES.has(paneId)) {
    fail(`${field}.paneId`, `仅允许 candle_pane/VOL/MACD（收到 ${paneId}）`)
  }
  const points = assertArray(drawing.points, `${field}.points`)
  if (points.length > MAX_DRAWING_POINTS) {
    fail(`${field}.points`, `单条画线点数 ${points.length} 超过上限 ${MAX_DRAWING_POINTS}`)
  }
  points.forEach((point, index) => {
    const item = assertRecord(point, `${field}.points[${index}]`)
    assertFinite(item.timestamp, `${field}.points[${index}].timestamp`)
    assertFinite(item.value, `${field}.points[${index}].value`)
  })
  if (drawing.styles !== undefined && !isRecord(drawing.styles)) {
    fail(`${field}.styles`, '必须是 JSON 对象')
  }
  // extendData 为任意 JsonValue，已由 assertJson 全树校验
}

/** 图表视口：field 传入 chart.view 字段的路径（REC-V2-VALIDATION 复用，错误文案不变） */
export function assertChartView(view: unknown, field: string): void {
  const record = assertRecord(view, field)
  assertNumberOrNull(record.fromTimestamp, `${field}.fromTimestamp`)
  assertNumberOrNull(record.toTimestamp, `${field}.toTimestamp`)
  assertPositive(record.barSpace, `${field}.barSpace`)
  const paneHeights = assertRecord(record.paneHeights, `${field}.paneHeights`)
  for (const [key, height] of Object.entries(paneHeights)) {
    assertPositive(height, `${field}.paneHeights.${key}`)
  }
}

/** 返回归一化（月键归月初）的 bar 日期，供严格递增与截止比较 */
function assertChartCapture(raw: unknown, field: string): string[] {
  const chart = assertRecord(raw, field)
  const timeframe = assertEnum(chart.timeframe, `${field}.timeframe`, TIMEFRAMES)
  const barDates = assertArray(chart.bars, `${field}.bars`).map((bar, index) =>
    assertBar(bar, `${field}.bars[${index}]`, timeframe),
  )
  barDates.forEach((date, index) => {
    if (index > 0 && date <= barDates[index - 1]) {
      fail(`${field}.bars[${index}].date`, `必须严格按日期递增（前值 ${barDates[index - 1]}，收到 ${date}）`)
    }
  })
  const drawings = assertArray(chart.drawings, `${field}.drawings`)
  if (drawings.length > MAX_DRAWINGS) {
    fail(`${field}.drawings`, `画线数量 ${drawings.length} 超过上限 ${MAX_DRAWINGS}`)
  }
  const drawingIds = new Set<string>()
  drawings.forEach((drawing, index) => {
    assertDrawing(drawing, `${field}.drawings[${index}]`, drawingIds)
  })
  assertChartView(chart.view, `${field}.view`)
  assertNumberOrNull(chart.costPrice, `${field}.costPrice`)
  return barDates
}

export function assertTrade(raw: unknown, field: string): void {
  const trade = assertRecord(raw, field)
  assertInteger(trade.seq, `${field}.seq`)
  assertDate(trade.date, `${field}.date`)
  assertEnum(trade.side, `${field}.side`, TRADE_SIDES)
  assertFinite(trade.price, `${field}.price`)
  assertFinite(trade.shares, `${field}.shares`)
  assertFinite(trade.amount, `${field}.amount`)
  assertFinite(trade.fee, `${field}.fee`)
  if (trade.chartPrice !== undefined) assertFinite(trade.chartPrice, `${field}.chartPrice`)
  if (trade.blindIndex !== undefined) assertInteger(trade.blindIndex, `${field}.blindIndex`)
  if (trade.blindLabel !== undefined) assertString(trade.blindLabel, `${field}.blindLabel`)
}

/** 训练元数据：field 传入训练快照内 training 字段的路径（REC-V2-VALIDATION 复用，错误文案不变） */
export function assertTrainingMeta(raw: unknown, field: string): void {
  const meta = assertRecord(raw, field)
  assertInteger(meta.id, `${field}.id`)
  assertEnum(meta.tier, `${field}.tier`, TIERS)
  assertStringOrNull(meta.code, `${field}.code`)
  assertStringOrNull(meta.name, `${field}.name`)
  assertString(meta.market, `${field}.market`)
  assertDate(meta.startDate, `${field}.startDate`)
  assertDate(meta.plannedEnd, `${field}.plannedEnd`)
  assertDateOrNull(meta.currentDate, `${field}.currentDate`)
  assertEnum(meta.status, `${field}.status`, TRAINING_STATUS)
  assertDateOrNull(meta.settleDate, `${field}.settleDate`)
  assertBoolean(meta.earlySettle, `${field}.earlySettle`)
  assertBoolean(meta.blind, `${field}.blind`)
  assertEnum(meta.adjustMode, `${field}.adjustMode`, ADJUST_MODES)
  assertFinite(meta.initialCash, `${field}.initialCash`)
  assertTimestamp(meta.createdAt, `${field}.createdAt`)
}

/** 账户视图：field 传入训练快照内 account 字段的路径 */
export function assertAccountView(raw: unknown, field: string): void {
  const account = assertRecord(raw, field)
  for (const key of ACCOUNT_KEYS) assertFinite(account[key], `${field}.${key}`)
  assertNumberOrNull(account.costPrice, `${field}.costPrice`)
}

function assertTrainingSnapshot(raw: unknown, field: string): void {
  const snapshot = assertRecord(raw, field)
  assertTrainingMeta(snapshot.training, `${field}.training`)
  assertAccountView(snapshot.account, `${field}.account`)
  assertArray(snapshot.trades, `${field}.trades`).forEach((trade, index) => {
    assertTrade(trade, `${field}.trades[${index}]`)
  })
}

interface CheckedCheckpoint {
  afterSeq: number
  training: TrainingSnapshot | null
  chart: ChartCapture | null
  barDates: string[]
}

function assertCheckpoint(
  raw: unknown,
  field: string,
  eventCount: number,
  segmentIds: ReadonlySet<string>,
  checkpointIds: Map<string, number>,
): CheckedCheckpoint {
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
  const training = checkpoint.training === null
    ? null
    : (assertTrainingSnapshot(checkpoint.training, `${field}.training`), checkpoint.training as TrainingSnapshot)
  let chart: ChartCapture | null = null
  let barDates: string[] = []
  if (checkpoint.chart !== null) {
    barDates = assertChartCapture(checkpoint.chart, `${field}.chart`)
    chart = checkpoint.chart as ChartCapture
  }
  const ui = assertRecord(checkpoint.ui, `${field}.ui`)
  assertString(ui.theme, `${field}.ui.theme`)
  assertStringOrNull(ui.tool, `${field}.ui.tool`)
  assertString(ui.magnet, `${field}.ui.magnet`)
  assertBoolean(ui.multiSelect, `${field}.ui.multiSelect`)
  // context 为 JsonValue | null，已由 assertJson 全树校验
  return { afterSeq, training, chart, barDates }
}

/** v1 大文件迁移预算：仅由调用方传入，绝不从导入文件内容读取；缺省保持旧 2000 */
export interface ValidateRecordingOptions {
  maxCheckpoints?: number
}

/** 校验录制文件；失败抛中文可行动错误，通过则原样返回（不重排 checkpoints） */
export function validateRecording(value: unknown, options?: ValidateRecordingOptions): RecordingFile {
  const maxCheckpoints = options?.maxCheckpoints ?? MAX_CHECKPOINTS
  if (!isRecord(value)) fail('顶层', '必须是 JSON 对象')
  assertJson(value, '', 1)

  if (value.format !== 'trainer-session') {
    fail('format', `必须是 'trainer-session'（收到 ${JSON.stringify(value.format)}）`)
  }
  if (value.schemaVersion !== 1) {
    fail('schemaVersion', `必须是 1（收到 ${JSON.stringify(value.schemaVersion)}）`)
  }
  assertString(value.sessionId, 'sessionId')
  assertTimestamp(value.createdAt, 'createdAt')

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

  assertStringOrNull(value.trainingKey, 'trainingKey')
  assertBoolean(value.complete, 'complete')

  const events = assertArray(value.events, 'events')
  if (events.length > MAX_EVENTS) fail('events', `事件数量 ${events.length} 超过上限 ${MAX_EVENTS}`)
  const checkpoints = assertArray(value.checkpoints, 'checkpoints')
  if (checkpoints.length > maxCheckpoints) {
    fail('checkpoints', `检查点数量 ${checkpoints.length} 超过上限 ${maxCheckpoints}`)
  }
  const gaps = assertArray(value.gaps, 'gaps')

  const segmentIds = new Set<string>()
  const checkpointRefs: Array<{ checkpointId: string | undefined; seq: number }> = []
  let lastElapsedMs = Number.NEGATIVE_INFINITY
  events.forEach((raw, index) => {
    const checked = assertEvent(raw, `events[${index}]`, index)
    if (checked.elapsedMs < lastElapsedMs) {
      fail(`events[${index}].elapsedMs`, `须全局单调不减（前一事件 ${lastElapsedMs}，本事件 ${checked.elapsedMs}）`)
    }
    lastElapsedMs = checked.elapsedMs
    segmentIds.add(checked.segmentId)
    checkpointRefs.push({ checkpointId: checked.checkpointId, seq: index + 1 })
  })
  assertEventPairing(events, value.complete as boolean)

  const checkpointIds = new Map<string, number>()
  const checkedCheckpoints: CheckedCheckpoint[] = []
  let previousCheckpointAfterSeq = 0
  checkpoints.forEach((raw, index) => {
    const checked = assertCheckpoint(raw, `checkpoints[${index}]`, events.length, segmentIds, checkpointIds)
    if (checked.afterSeq < previousCheckpointAfterSeq) {
      fail(`checkpoints[${index}].afterSeq`, `须按 afterSeq 非递减（前值 ${previousCheckpointAfterSeq}，收到 ${checked.afterSeq}），同 seq 允许多个更完整状态`)
    }
    previousCheckpointAfterSeq = checked.afterSeq
    checkedCheckpoints.push(checked)
  })

  checkpointRefs.forEach(({ checkpointId, seq }, index) => {
    if (checkpointId === undefined) return
    const afterSeq = checkpointIds.get(checkpointId)
    if (afterSeq === undefined) {
      fail(`events[${index}].checkpointId`, `引用了不存在的检查点 id（${checkpointId}）`)
    }
    if (afterSeq > seq) {
      fail(`events[${index}].checkpointId`, `指向未来快照（检查点 afterSeq=${afterSeq} 晚于事件 seq=${seq}）`)
    }
  })

  // bars 截止不晚于推进日；currentDate 为 null（双盲）时回退 startDate，不得借 null 导出未来；
  // 周/月 bar 为周期起点，月键归一月月初后同样不得越过边界
  checkedCheckpoints.forEach((checked, index) => {
    const cutoff = checked.training === null
      ? null
      : checked.training.training.currentDate ?? checked.training.training.startDate
    if (cutoff === null || checked.chart === null) return
    checked.barDates.forEach((date, barIndex) => {
      if (date > cutoff) {
        fail(`checkpoints[${index}].chart.bars[${barIndex}].date`, `晚于行情截止（截止 ${cutoff}，currentDate 为 null 时按 startDate 比较），不得包含未来数据`)
      }
    })
  })

  let previousGapAfterSeq = -1
  let hasOpenGap = false
  gaps.forEach((raw, index) => {
    const gap = assertRecord(raw, `gaps[${index}]`)
    const field = `gaps[${index}]`
    const afterSeq = assertInteger(gap.afterSeq, `${field}.afterSeq`)
    if (afterSeq < 0 || afterSeq > events.length) {
      fail(`${field}.afterSeq`, `须在 0..${events.length} 范围内（0 表示自开始未录制，收到 ${afterSeq}）`)
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
      if (resumedAtSeq > events.length) {
        fail(`${field}.resumedAtSeq`, `超出事件范围（最大 ${events.length}，收到 ${resumedAtSeq}）`)
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

  return value as unknown as RecordingFile
}

/** 解析录制 JSON 文本：字节大小 ≤ 25MiB → JSON.parse → validateRecording */
export function parseRecording(text: string): RecordingFile {
  if (typeof text !== 'string') fail('parseRecording', '输入必须是字符串')
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BYTES) fail('文件大小', `${bytes} 字节超过上限 ${MAX_BYTES} 字节（25MiB）`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail('JSON 解析', '不是合法的 JSON 文本')
  }
  return validateRecording(value)
}

/** 导出录制文件：先校验（拦截 NaN/undefined 等静默序列化损失），再 JSON.stringify */
export function exportRecording(file: RecordingFile): string {
  validateRecording(file)
  const text = JSON.stringify(file)
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BYTES) fail('导出大小', `${bytes} 字节超过上限 ${MAX_BYTES} 字节（25MiB）`)
  return text
}
