// 上海收盘日与数据新鲜度纯计算：不读取文件、网络或环境，主机时区不参与结果。
// 合同见 docs/engineering/release-032-contracts.md（FRESH-01）。

export interface TradingCalendar {
  id: string
  from: string
  through: string
  closedDates: readonly string[]
}

export interface FreshnessInput {
  now: Date
  sourceMaxDate: string | null
  calendar?: TradingCalendar
}

export interface FreshnessResult {
  state: 'current' | 'stale' | 'unknown'
  expectedDate: string | null
  sourceMaxDate: string | null
  checkedAt: string
  reason: string
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
// 15:00 收盘：上海时刻达到 15:00 即包含当日，否则查前一已收盘交易日。
const CLOSED_AFTER_MINUTES = 15 * 60
const COMPLETENESS_NOTE = '来源末日不证明所有股票完整'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    case 2:
      return isLeapYear(year) ? 29 : 28
    default:
      return 31
  }
}

// YYYY-MM-DD 与天序号（1970-01-01 = 0）互转，全部走纯算术，避免任何本地时区解析。
function daysFromCivil(value: unknown): number | null {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civilFromDays(days: number): string {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = month <= 2 ? y + 1 : y
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// 1970-01-01 是周四：(天序号 + 4) % 7，0 = 周日。
function isWeekday(days: number): boolean {
  const weekday = (((days + 4) % 7) + 7) % 7
  return weekday >= 1 && weekday <= 5
}

function assertValidNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('now must be a valid Date')
  }
  return value
}

interface ShanghaiMoment {
  date: string
  days: number | null
  minutes: number
}

function shanghaiMoment(now: Date): ShanghaiMoment {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const date = `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
  return {
    date,
    days: daysFromCivil(date),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

export function shanghaiDate(now: Date): string {
  assertValidNow(now)
  return shanghaiMoment(now).date
}

type CalendarCheck = { ok: true; closedDays: ReadonlySet<number> } | { ok: false; detail: string }

function validateCalendar(calendar: TradingCalendar): CalendarCheck {
  if (typeof calendar?.id !== 'string' || calendar.id.trim() === '') {
    return { ok: false, detail: '日历 id 缺失或为空' }
  }
  const fromDays = daysFromCivil(calendar.from)
  const throughDays = daysFromCivil(calendar.through)
  if (fromDays === null) return { ok: false, detail: `日历 from 不是有效日期：${String(calendar.from)}` }
  if (throughDays === null) return { ok: false, detail: `日历 through 不是有效日期：${String(calendar.through)}` }
  if (fromDays > throughDays) return { ok: false, detail: `日历 from 晚于 through：${calendar.from} > ${calendar.through}` }
  if (!Array.isArray(calendar.closedDates)) return { ok: false, detail: '日历 closedDates 缺失或不是数组' }
  const closedDays = new Set<number>()
  let previous = Number.NEGATIVE_INFINITY
  for (const closed of calendar.closedDates) {
    const closedValue = daysFromCivil(closed)
    if (closedValue === null) return { ok: false, detail: `closedDates 含无效日期：${String(closed)}` }
    if (closedValue < fromDays || closedValue > throughDays) {
      return { ok: false, detail: `closedDates 日期超出日历范围：${String(closed)}` }
    }
    if (closedValue <= previous) return { ok: false, detail: `closedDates 未按升序唯一排列：${String(closed)}` }
    closedDays.add(closedValue)
    previous = closedValue
  }
  return { ok: true, closedDays }
}

function reason(detail: string): string {
  return `${detail}。${COMPLETENESS_NOTE}。`
}

function unknown(detail: string, expectedDate: string | null, input: FreshnessInput, checkedAt: string): FreshnessResult {
  const sourceMaxDate = typeof input.sourceMaxDate === 'string' ? input.sourceMaxDate : null
  return { state: 'unknown', expectedDate, sourceMaxDate, checkedAt, reason: reason(detail) }
}

export function assessFreshness(input: FreshnessInput): FreshnessResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be an object with now, sourceMaxDate')
  }
  const now = assertValidNow(input.now)
  const checkedAt = now.toISOString()
  const moment = shanghaiMoment(now)
  const todayDays = moment.days

  if (input.calendar === undefined || input.calendar === null) {
    return unknown('缺少可信交易日历，无法推算应收收盘日', null, input, checkedAt)
  }
  const calendarCheck = validateCalendar(input.calendar)
  if (!calendarCheck.ok) {
    return unknown(`交易日历无效（${calendarCheck.detail}），保守按未知处理`, null, input, checkedAt)
  }
  if (todayDays === null) {
    return unknown(`上海系统日无法解析：${moment.date}`, null, input, checkedAt)
  }
  const { from, through } = input.calendar
  const fromDays = daysFromCivil(from) as number
  const throughDays = daysFromCivil(through) as number
  if (todayDays < fromDays || todayDays > throughDays) {
    return unknown(`交易日历未覆盖上海系统日 ${moment.date}（范围 ${from}..${through}）`, null, input, checkedAt)
  }

  const closedDays = calendarCheck.closedDays
  const isTradingDay = (days: number): boolean => isWeekday(days) && !closedDays.has(days)

  let expectedDays: number | null = null
  if (moment.minutes >= CLOSED_AFTER_MINUTES && isTradingDay(todayDays)) {
    expectedDays = todayDays
  } else {
    for (let days = todayDays - 1; days >= fromDays; days -= 1) {
      if (isTradingDay(days)) {
        expectedDays = days
        break
      }
    }
  }
  if (expectedDays === null) {
    return unknown(`交易日历在 ${from} 之前覆盖不足，无法确认前一已收盘交易日`, null, input, checkedAt)
  }
  const expectedDate = civilFromDays(expectedDays)

  const sourceMaxDate = input.sourceMaxDate
  if (sourceMaxDate === null || sourceMaxDate === undefined) {
    return unknown(`应收收盘日为 ${expectedDate}，但来源最大日期未知，无法确认数据新鲜度`, expectedDate, input, checkedAt)
  }
  if (typeof sourceMaxDate !== 'string') {
    return unknown(`来源最大日期类型无效：${String(sourceMaxDate)}`, expectedDate, input, checkedAt)
  }
  const sourceDays = daysFromCivil(sourceMaxDate)
  if (sourceDays === null) {
    return unknown(`来源最大日期不是有效日期：${sourceMaxDate}`, expectedDate, input, checkedAt)
  }
  if (sourceDays > todayDays) {
    return unknown(`来源最大日期 ${sourceMaxDate} 晚于上海系统日 ${moment.date}，数据可疑`, expectedDate, input, checkedAt)
  }
  if (sourceDays >= expectedDays) {
    return {
      state: 'current',
      expectedDate,
      sourceMaxDate,
      checkedAt,
      reason: reason(`来源最大日期 ${sourceMaxDate} 已达到应收收盘日 ${expectedDate}`),
    }
  }
  return {
    state: 'stale',
    expectedDate,
    sourceMaxDate,
    checkedAt,
    reason: reason(`来源最大日期 ${sourceMaxDate} 落后应收收盘日 ${expectedDate}`),
  }
}
