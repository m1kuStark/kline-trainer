import type { Timeframe } from './tdx/kline.js'

export interface DifferenceSummary {
  compared: number
  maxAbsoluteError: number
  maxRelativeError: number
  mismatchCount: number
}

export interface TdxExportBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount?: number
}

export interface TdxExportComparison {
  comparedBars: number
  dateMismatchCount: number
  ohlc: DifferenceSummary
  volume: DifferenceSummary
  amount: DifferenceSummary | null
  displayMismatchCount: number
  nonPositiveOhlcCompared: number
  nonPositiveDisplayMismatchCount: number
}

export function formatVerificationNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return 'N/A'
  const fixed = value.toFixed(digits)
  if (!fixed.includes('.')) return fixed
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

export function resolveM1VerificationStatus(
  unverifiedRequiredItems: number,
): 'passed' | 'waiting-user-verification' {
  return unverifiedRequiredItems === 0 ? 'passed' : 'waiting-user-verification'
}

export function detectTdxAmountColumn(header: string): boolean {
  return header.split('\t').some(cell => /成交额|成交金额|amount|amt/i.test(cell.trim()))
}

// 约定：tdx-export 目录下 tdx_qfq_<市场><代码>.txt 是额外样本的通达信前复权高级导出，
// 验证器自动识别并逐值核验（用于补配股等基准样本未覆盖的分支）。基准样本本身不重复处理。
export function extraExportSymbol(fileName: string, baseline: string): string | null {
  if (fileName.toLowerCase() === baseline.toLowerCase()) return null
  const match = /^tdx_qfq_(.+)\.txt$/i.exec(fileName)
  return match?.[1] ?? null
}

// .day 成交额为 float32（约 7 位有效数字），周/月成交额是多日 float32 的累加：
// 双精度累加与通达信内部累加之间的浮点噪声随量级线性增长，绝对容差不再适用。
// 2e-7 相对容差（对 1.7e10 的周成交额约 ±3400 元）覆盖该噪声，而单位换算或字段级错误仍会 FAIL。
export function periodAmountTolerance(amounts: number[]): number {
  const largest = amounts.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  return Math.max(0.01, largest * 2e-7)
}

export function describePeriodAmountVerification(available: boolean): string {
  return available
    ? '周/月成交额已提供原生列，已逐值核验。'
    : '周/月成交额原生列未提供，等待用户核验。'
}

export function summarizeDifferences(
  actual: number[],
  expected: number[],
  absoluteTolerance = 1e-9,
): DifferenceSummary {
  if (actual.length !== expected.length) {
    throw new Error(`Cannot compare ${actual.length} actual values with ${expected.length} expected values`)
  }
  let maxAbsoluteError = 0
  let maxRelativeError = 0
  let mismatchCount = 0
  for (let index = 0; index < actual.length; index += 1) {
    const absoluteError = Math.abs(actual[index] - expected[index])
    const relativeError = Math.abs(expected[index]) > Number.EPSILON
      ? absoluteError / Math.abs(expected[index])
      : absoluteError
    maxAbsoluteError = Math.max(maxAbsoluteError, absoluteError)
    maxRelativeError = Math.max(maxRelativeError, relativeError)
    if (absoluteError > absoluteTolerance) mismatchCount += 1
  }
  return { compared: actual.length, maxAbsoluteError, maxRelativeError, mismatchCount }
}

export function parseTdxExportBars(
  text: string,
  volumeUnit: 'shares' | 'lots',
): TdxExportBar[] {
  const volumeMultiplier = volumeUnit === 'lots' ? 100 : 1
  const bars: TdxExportBar[] = []
  const header = text.split(/\r?\n/)
    .map(line => line.split('\t').map(cell => cell.trim()))
    .find(cells => cells.some(cell => /时间|日期|date/i.test(cell)))
  const amountColumn = header?.findIndex(cell => /成交额|成交金额|amount|amt/i.test(cell)) ?? -1

  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('\t').map(cell => cell.trim())
    const dateMatch = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(cells[0] ?? '')
    if (!dateMatch) continue
    if (cells.length < 6) throw new Error(`Invalid TDX export row: ${line}`)

    const values = cells.slice(1, 6).map(Number)
    if (values.some(value => !Number.isFinite(value))) {
      throw new Error(`Invalid numeric value in TDX export row: ${line}`)
    }
    const [open, high, low, close, volume] = values
    const amountValue = amountColumn >= 0 ? Number(cells[amountColumn]) : undefined
    if (amountColumn >= 0 && !Number.isFinite(amountValue)) {
      throw new Error(`Invalid amount value in TDX export row: ${line}`)
    }
    bars.push({
      date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
      open,
      high,
      low,
      close,
      volume: volume * volumeMultiplier,
      ...(amountValue === undefined ? {} : { amount: amountValue }),
    })
  }

  return bars
}

export function compareTdxExportBars(
  actual: TdxExportBar[],
  tdx: TdxExportBar[],
  volumeTolerance = 0,
  amountTolerance = 0.0051,
): TdxExportComparison {
  if (actual.length !== tdx.length) {
    throw new Error(`Cannot compare ${actual.length} actual bars with ${tdx.length} TDX bars`)
  }

  const actualOhlc = actual.flatMap(bar => [bar.open, bar.high, bar.low, bar.close])
  const tdxOhlc = tdx.flatMap(bar => [bar.open, bar.high, bar.low, bar.close])
  const displayMismatches = actualOhlc.map(
    (value, index) => Number(value.toFixed(2)) !== tdxOhlc[index],
  )
  return {
    comparedBars: actual.length,
    dateMismatchCount: actual.reduce(
      (count, bar, index) => count + Number(bar.date !== tdx[index].date),
      0,
    ),
    ohlc: summarizeDifferences(actualOhlc, tdxOhlc, 0.0051),
    volume: summarizeDifferences(
      actual.map(bar => bar.volume),
      tdx.map(bar => bar.volume),
      volumeTolerance,
    ),
    amount: actual.every(bar => bar.amount !== undefined)
      && tdx.every(bar => bar.amount !== undefined)
      ? summarizeDifferences(
        actual.map(bar => bar.amount as number),
        tdx.map(bar => bar.amount as number),
        amountTolerance,
      )
      : null,
    displayMismatchCount: displayMismatches.filter(Boolean).length,
    nonPositiveOhlcCompared: actualOhlc.filter(value => value <= 0).length,
    nonPositiveDisplayMismatchCount: displayMismatches.filter(
      (mismatch, index) => mismatch && actualOhlc[index] <= 0,
    ).length,
  }
}

function mondayKey(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  const offset = (parsed.getUTCDay() + 6) % 7
  parsed.setUTCDate(parsed.getUTCDate() - offset)
  return parsed.toISOString().slice(0, 10)
}

// 把通达信日线原生导出按周/月归组，派生周期 K 线，作为聚合逻辑的独立对照基准。
// 日线导出的成交额/成交量与前复权无关（已逐值核验为原值），派生和只依赖分组边界正确性。
export function derivePeriodBars(
  daily: TdxExportBar[],
  timeframe: Extract<Timeframe, '1W' | '1M'>,
): TdxExportBar[] {
  const groups = new Map<string, TdxExportBar[]>()
  for (const bar of daily) {
    const key = normalizeTdxPeriodDate(timeframe, bar.date)
    const group = groups.get(key) ?? []
    group.push(bar)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([date, group]) => ({
    date,
    open: group[0].open,
    high: Math.max(...group.map(bar => bar.high)),
    low: Math.min(...group.map(bar => bar.low)),
    close: group[group.length - 1].close,
    volume: group.reduce((sum, bar) => sum + bar.volume, 0),
    ...(group.every(bar => bar.amount !== undefined)
      ? { amount: group.reduce((sum, bar) => sum + (bar.amount as number), 0) }
      : {}),
  }))
}

export function normalizeTdxPeriodDate(
  timeframe: Extract<Timeframe, '1W' | '1M'>,
  date: string,
): string {
  return timeframe === '1W' ? mondayKey(date) : date.slice(0, 7)
}

export function classifyPeriodStatus(
  timeframe: Extract<Timeframe, '1W' | '1M'>,
  periodDate: string,
  dataCutoff: string,
): 'completed' | 'forming' {
  const currentPeriod = timeframe === '1W' ? mondayKey(dataCutoff) : dataCutoff.slice(0, 7)
  return periodDate === currentPeriod ? 'forming' : 'completed'
}
