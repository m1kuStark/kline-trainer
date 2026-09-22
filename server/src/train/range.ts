// 训练范围规划（v0.3.2 合同 docs/engineering/release-032-contracts.md「RANGE-01：训练范围」）。
// 纯日期元信息规划：不导入引擎、不读取价格/文件/环境；dates 由上层保证剔除盘中未完整日线。
// 缺口一律保守处理：内部缺口不断言停牌或完整，尾段未证实工作日不得充当请求终点。

export type TrainingRangeRequest =
  | { mode: 'preset'; startDate: string; months: 1 | 3 | 6 | 12 | 24; endDate?: string }
  | { mode: 'latest'; startDate: string }
  | { mode: 'bars'; startDate: string; count: number }

export interface TrainingRangeInput {
  request: TrainingRangeRequest
  dates: readonly string[]
  today: string
  knownClosedDates?: readonly string[]
}

export type TrainingRangeResult =
  | {
      ok: true
      mode: TrainingRangeRequest['mode']
      requestedStart: string
      requestedEnd: string | null
      startDate: string
      endDate: string
      barCount: number
      notes: string[]
    }
  | {
      ok: false
      code: 'INVALID_INPUT' | 'NO_DATA' | 'BEFORE_HISTORY' | 'AFTER_DATA' | 'INSUFFICIENT_DATA' | 'UNCONFIRMED_COVERAGE'
      message: string
    }

const PRESET_MONTHS: readonly number[] = [1, 3, 6, 12, 24]
const NOTE_ONLY_KNOWN_BARS = '仅按现有日线计算；内部缺口不推断为停牌或数据完整'
const MS_PER_DAY = 86400000

function display(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// 自然月加减并对目标月末裁剪：2026-03-31 - 1月 = 2026-02-28，2024-01-31 + 1月 = 2024-02-29。
function addMonths(date: string, months: number): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const total = year * 12 + (month - 1) + months
  const targetYear = Math.floor(total / 12)
  const targetMonth = ((total % 12) + 12) % 12 + 1
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth))
  return formatDate(targetYear, targetMonth, targetDay)
}

function nextDay(date: string): string {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + MS_PER_DAY
  const day = new Date(ms)
  return formatDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())
}

// 仅按公历判断周末；上海时区不参与，ISO 日期在 UTC 下取星期无歧义。
function isWeekend(date: string): boolean {
  const weekday = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay()
  return weekday === 0 || weekday === 6
}

function fail(code: Extract<TrainingRangeResult, { ok: false }>['code'], message: string): TrainingRangeResult {
  return { ok: false, code, message }
}

// 合同里的"自然月"夹具：today 减 N 个月、裁目标月末，终点固定为 today 本身。
export function presetDates(today: string, months: 1 | 3 | 6 | 12 | 24): { startDate: string; endDate: string } {
  if (!isValidDate(today)) throw new Error(`today 必须是 YYYY-MM-DD 日历日期，收到 ${display(today)}`)
  if (typeof months !== 'number' || !PRESET_MONTHS.includes(months)) {
    throw new Error(`months 必须是 ${PRESET_MONTHS.join('/')} 之一，收到 ${display(months)}`)
  }
  return { startDate: addMonths(today, -months), endDate: today }
}

// 显式 endDate 的语义（合同"系统日期回推"）：终点锚定调用方给定的训练系统日，起点仍为请求
// startDate，窗口即 [startDate, endDate]；未给 endDate 才从 startDate 加月推终点。终点一旦
// 确定，首根对齐后不重新加月；显式 endDate > today 属请求畸形（合同"禁止"），走 INVALID_INPUT，
// 与自然月推算终点 > today 的数据不足（INSUFFICIENT_DATA）区分。
export function planTrainingRange(input: TrainingRangeInput): TrainingRangeResult {
  if (input === null || typeof input !== 'object') {
    return fail('INVALID_INPUT', 'input 必须是包含 request/dates/today 的对象')
  }
  const { request, dates, today, knownClosedDates } = input

  if (!isValidDate(today)) return fail('INVALID_INPUT', `today 必须是 YYYY-MM-DD 日历日期，收到 ${display(today)}`)

  if (!Array.isArray(dates)) return fail('INVALID_INPUT', 'dates 必须是升序 YYYY-MM-DD 日期数组')
  for (let i = 0; i < dates.length; i++) {
    const value = dates[i]
    if (!isValidDate(value)) return fail('INVALID_INPUT', `dates[${i}] 不是有效日历日期：${display(value)}`)
    if (value > today) {
      return fail('INVALID_INPUT', `dates[${i}] = ${value} 晚于 today ${today}：上层必须先剔除未完整日线`)
    }
    if (i > 0 && value <= dates[i - 1]) {
      return fail('INVALID_INPUT', `dates 必须严格升序且唯一：dates[${i}] = ${value} 不大于 ${dates[i - 1]}`)
    }
  }

  if (knownClosedDates !== undefined) {
    if (!Array.isArray(knownClosedDates)) return fail('INVALID_INPUT', 'knownClosedDates 必须是 YYYY-MM-DD 日期数组')
    for (let i = 0; i < knownClosedDates.length; i++) {
      if (!isValidDate(knownClosedDates[i])) {
        return fail('INVALID_INPUT', `knownClosedDates[${i}] 不是有效日历日期：${display(knownClosedDates[i])}`)
      }
    }
  }
  const closed = new Set(knownClosedDates ?? [])

  if (request === null || typeof request !== 'object') return fail('INVALID_INPUT', 'request 必须是 preset/latest/bars 之一')
  if (!isValidDate(request.startDate)) {
    return fail('INVALID_INPUT', `startDate 必须是 YYYY-MM-DD 日历日期，收到 ${display(request.startDate)}`)
  }

  let requestedEnd: string | null = null
  if (request.mode === 'preset') {
    if (typeof request.months !== 'number' || !PRESET_MONTHS.includes(request.months)) {
      return fail('INVALID_INPUT', `preset months 必须是 ${PRESET_MONTHS.join('/')} 之一，收到 ${display(request.months)}`)
    }
    if (request.endDate !== undefined) {
      if (!isValidDate(request.endDate)) return fail('INVALID_INPUT', `endDate 不是有效日历日期：${display(request.endDate)}`)
      if (request.endDate < request.startDate) {
        return fail('INVALID_INPUT', `endDate ${request.endDate} 早于 startDate ${request.startDate}`)
      }
      if (request.endDate > today) {
        return fail('INVALID_INPUT', `endDate ${request.endDate} 晚于 today ${today}：未来终点不被接受，等数据落地后重试`)
      }
      requestedEnd = request.endDate
    } else {
      requestedEnd = addMonths(request.startDate, request.months)
    }
  } else if (request.mode === 'bars') {
    if (typeof request.count !== 'number' || !Number.isSafeInteger(request.count) || request.count < 1) {
      return fail('INVALID_INPUT', `bars count 必须是正安全整数，收到 ${display(request.count)}`)
    }
  } else {
    // TS 类型层只剩 latest；JS 直调仍可能传入任意 mode，必须留运行时守卫。
    const mode: string = request.mode
    if (mode !== 'latest') {
      return fail('INVALID_INPUT', `request.mode 必须是 preset/latest/bars，收到 ${display(mode)}`)
    }
  }

  if (dates.length === 0) return fail('NO_DATA', 'dates 为空：本地没有任何日线，无法规划训练范围')

  const requestedStart = request.startDate
  const lastDate = dates[dates.length - 1]
  if (requestedStart < dates[0]) {
    return fail('BEFORE_HISTORY', `请求起点 ${requestedStart} 早于本地首根日线 ${dates[0]}：本地历史未覆盖请求起点（不代表早于上市）`)
  }
  if (requestedStart > lastDate) {
    return fail('AFTER_DATA', `请求起点 ${requestedStart} 晚于本地最后一根日线 ${lastDate}：现有数据不覆盖请求起点`)
  }

  const alignedIndex = dates.findIndex(date => date >= requestedStart)
  const selected: string[] = []
  if (request.mode === 'bars') {
    const available = dates.length - alignedIndex
    if (request.count > available) {
      return fail('INSUFFICIENT_DATA', `对齐首根后可用日线仅 ${available} 根，请求 ${request.count} 根；不截短，请缩小 count 或前移起点`)
    }
    selected.push(...dates.slice(alignedIndex, alignedIndex + request.count))
  } else if (request.mode === 'latest') {
    selected.push(...dates.slice(alignedIndex))
  } else {
    const end = requestedEnd as string
    if (end > today) {
      return fail('INSUFFICIENT_DATA', `请求终点 ${end} 晚于 today ${today}：未来日线不存在，请求范围不完整，不截短`)
    }
    let lastIndex = dates.length - 1
    while (lastIndex >= alignedIndex && dates[lastIndex] > end) lastIndex--
    if (lastIndex < alignedIndex) {
      return fail('INSUFFICIENT_DATA', `请求窗口 [${requestedStart}, ${end}] 内没有任何日线`)
    }
    // 尾段欠缺：只有 (末根, 终点] 全为周末或已知休市才允许取末根；出现未证实工作日即保守失败。
    let cursor = nextDay(dates[lastIndex])
    let unconfirmed: string | null = null
    while (cursor <= end) {
      if (!closed.has(cursor) && !isWeekend(cursor)) {
        unconfirmed = cursor
        break
      }
      cursor = nextDay(cursor)
    }
    if (unconfirmed !== null) {
      return fail(
        'UNCONFIRMED_COVERAGE',
        `尾段缺口含未证实工作日 ${unconfirmed}（不在 knownClosedDates）：无法把末根 ${dates[lastIndex]} 当作请求终点 ${end}`,
      )
    }
    selected.push(...dates.slice(alignedIndex, lastIndex + 1))
  }

  const startDate = selected[0]
  const endDate = selected[selected.length - 1]
  const notes = [NOTE_ONLY_KNOWN_BARS]
  if (startDate > requestedStart) {
    notes.push(`首根日线 ${startDate} 晚于请求起点 ${requestedStart}，已对齐首根且不重新推终点`)
  }
  if (request.mode === 'latest') {
    notes.push(`latest 终点钉定本地末根 ${endDate}`)
  }
  if (request.mode === 'preset' && requestedEnd !== null && endDate < requestedEnd) {
    notes.push(`尾段缺口均为周末或已知休市，末根 ${endDate} 为请求终点 ${requestedEnd} 前最后可用日线`)
  }
  return {
    ok: true,
    mode: request.mode,
    requestedStart,
    requestedEnd,
    startDate,
    endDate,
    barCount: selected.length,
    notes,
  }
}
