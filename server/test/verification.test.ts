import { describe, expect, it } from 'vitest'
import {
  classifyPeriodStatus,
  compareTdxExportBars,
  derivePeriodBars,
  detectTdxAmountColumn,
  extraExportSymbol,
  describePeriodAmountVerification,
  formatVerificationNumber,
  normalizeTdxPeriodDate,
  parseTdxExportBars,
  periodAmountTolerance,
  resolveM1VerificationStatus,
  summarizeDifferences,
} from '../src/verification.js'

describe('M1 verification helpers', () => {
  it('reports maximum absolute and relative errors plus mismatch count', () => {
    const summary = summarizeDifferences(
      [10.005, 19.98, 0.001],
      [10, 20, 0],
      0.01,
    )
    expect(summary.compared).toBe(3)
    expect(summary.maxAbsoluteError).toBeCloseTo(0.02, 12)
    expect(summary.maxRelativeError).toBeCloseTo(0.001, 12)
    expect(summary.mismatchCount).toBe(1)
  })

  it('keeps zero visible when formatting verification metrics', () => {
    expect(formatVerificationNumber(0, 0)).toBe('0')
    expect(formatVerificationNumber(12.34, 4)).toBe('12.34')
  })

  it('detects whether a TDX export exposes a native amount column', () => {
    expect(detectTdxAmountColumn('时间\t开盘\t最高\t最低\t收盘\t成交量')).toBe(false)
    expect(detectTdxAmountColumn('时间\t开盘\t最高\t最低\t收盘\t成交量\t成交额')).toBe(true)
    expect(detectTdxAmountColumn('时间\tOPEN\tHIGH\tLOW\tCLOSE\tAMOUNT')).toBe(true)
  })

  it('recognizes extra full-export samples while skipping the baseline export', () => {
    expect(extraExportSymbol('tdx_qfq_sz300176.txt', 'tdx_qfq_600519.txt')).toBe('sz300176')
    expect(extraExportSymbol('tdx_qfq_600081.TXT', 'tdx_qfq_600519.txt')).toBe('600081')
    expect(extraExportSymbol('tdx_qfq_600519.txt', 'tdx_qfq_600519.txt')).toBeNull()
    expect(extraExportSymbol('tdx_weekly_600519.xls', 'tdx_qfq_600519.txt')).toBeNull()
  })

  it('scales period amount tolerance with float32 accumulation noise', () => {
    expect(periodAmountTolerance([17_185_809_536, 9_879_558_912])).toBeCloseTo(3437.1619072, 6)
    expect(periodAmountTolerance([1050, 990])).toBe(0.01)
    expect(periodAmountTolerance([])).toBe(0.01)
  })

  it('tolerates float32 accumulation noise but rejects unit-scale amount errors', () => {
    const tolerance = periodAmountTolerance([17_185_809_536])
    const base = { date: '2026-08-24', open: 1271, high: 1317, low: 1270.33, close: 1297.4, volume: 13_217_516 }
    const noise = compareTdxExportBars(
      [{ ...base, amount: 17_185_809_536 + 3000 }],
      [{ ...base, amount: 17_185_809_536 }],
      0,
      tolerance,
    )
    expect(noise.amount?.mismatchCount).toBe(0)

    const unitError = compareTdxExportBars(
      [{ ...base, amount: 17_185_809.536 }],
      [{ ...base, amount: 17_185_809_536 }],
      0,
      tolerance,
    )
    expect(unitError.amount?.mismatchCount).toBe(1)
  })

  it('keeps the milestone waiting when required evidence is unverified', () => {
    expect(resolveM1VerificationStatus(0)).toBe('passed')
    expect(resolveM1VerificationStatus(1)).toBe('waiting-user-verification')
  })

  it('describes whether weekly and monthly amount evidence is verified', () => {
    expect(describePeriodAmountVerification(true)).toContain('已逐值核验')
    expect(describePeriodAmountVerification(false)).toContain('等待用户核验')
  })

  it('distinguishes completed and forming weekly and monthly bars', () => {
    expect(classifyPeriodStatus('1W', '2026-08-24', '2026-09-02')).toBe('completed')
    expect(classifyPeriodStatus('1W', '2026-08-31', '2026-09-02')).toBe('forming')
    expect(classifyPeriodStatus('1M', '2026-08', '2026-09-02')).toBe('completed')
    expect(classifyPeriodStatus('1M', '2026-09', '2026-09-02')).toBe('forming')
  })

  it('maps TDX period-end dates to the trainer weekly and monthly keys', () => {
    expect(normalizeTdxPeriodDate('1W', '2026-08-28')).toBe('2026-08-24')
    expect(normalizeTdxPeriodDate('1W', '2026-09-02')).toBe('2026-08-31')
    expect(normalizeTdxPeriodDate('1M', '2026-08-31')).toBe('2026-08')
    expect(normalizeTdxPeriodDate('1M', '2026-09-02')).toBe('2026-09')
  })

  it('derives period bars from a native daily export, including amounts', () => {
    const daily = [
      { date: '2026-08-28', open: 8, high: 9, low: 7, close: 8.5, volume: 8, amount: 80 },
      { date: '2026-08-31', open: 10, high: 12, low: 9, close: 11, volume: 10, amount: 100 },
      { date: '2026-09-01', open: 11, high: 13, low: 10, close: 12, volume: 20, amount: 200 },
      { date: '2026-09-02', open: 12, high: 14, low: 11, close: 13, volume: 30, amount: 300 },
    ]

    expect(derivePeriodBars(daily, '1W')).toEqual([
      { date: '2026-08-24', open: 8, high: 9, low: 7, close: 8.5, volume: 8, amount: 80 },
      { date: '2026-08-31', open: 10, high: 14, low: 9, close: 13, volume: 60, amount: 600 },
    ])
    expect(derivePeriodBars(daily, '1M')).toEqual([
      { date: '2026-08', open: 8, high: 12, low: 7, close: 11, volume: 18, amount: 180 },
      { date: '2026-09', open: 11, high: 14, low: 10, close: 13, volume: 50, amount: 500 },
    ])
  })

  it('omits derived amounts when the daily export has no amount column', () => {
    const daily = [
      { date: '2026-09-01', open: 11, high: 13, low: 10, close: 12, volume: 20 },
      { date: '2026-09-02', open: 12, high: 14, low: 11, close: 13, volume: 30 },
    ]

    expect(derivePeriodBars(daily, '1M')).toEqual([
      { date: '2026-09', open: 11, high: 14, low: 10, close: 13, volume: 50 },
    ])
  })

  it('parses TDX export rows while ignoring headers, indicators, and footer text', () => {
    const bars = parseTdxExportBars([
      '贵州茅台 (600519)',
      '时间\t开盘\t最高\t最低\t收盘\t成交量\t指标.DIF',
      '2026/09/01\t1295.00\t1307.99\t1286.10\t1299.56\t3266402\t-16.68',
      'not-a-date\t1\t2\t3\t4\t5',
      '#数据来源:通达信',
    ].join('\r\n'), 'shares')

    expect(bars).toEqual([{
      date: '2026-09-01',
      open: 1295,
      high: 1307.99,
      low: 1286.1,
      close: 1299.56,
      volume: 3_266_402,
    }])
  })

  it('normalizes leading-space screen exports and converts volume lots to shares', () => {
    const bars = parseTdxExportBars(
      ' 2026/09/02\t 1297.99\t 1307.99\t 1286.00\t 1297.50\t 76220\t 0.00',
      'lots',
    )

    expect(bars).toEqual([{
      date: '2026-09-02',
      open: 1297.99,
      high: 1307.99,
      low: 1286,
      close: 1297.5,
      volume: 7_622_000,
    }])
  })

  it('parses a native amount column by its header position', () => {
    const bars = parseTdxExportBars([
      '贵州茅台 (600519)',
      '日期\t开盘\t最高\t最低\t收盘\t成交量\t成交额\t指标.DIF',
      '2026/09/02\t1297.99\t1307.99\t1286.00\t1297.50\t76220\t9879558912.00\t-1.2',
    ].join('\r\n'), 'lots')

    expect(bars[0]).toMatchObject({
      date: '2026-09-02',
      volume: 7_622_000,
      amount: 9_879_558_912,
    })
  })

  it('compares TDX two-decimal prices and whole-lot volumes at their display precision', () => {
    const summary = compareTdxExportBars(
      [{
        date: '2026-09-02',
        open: 1297.994,
        high: 1307.986,
        low: 1286.004,
        close: 1297.504,
        volume: 7_622_047,
      }],
      [{
        date: '2026-09-02',
        open: 1297.99,
        high: 1307.99,
        low: 1286,
        close: 1297.5,
        volume: 7_622_000,
      }],
      99,
    )

    expect(summary.dateMismatchCount).toBe(0)
    expect(summary.ohlc.mismatchCount).toBe(0)
    expect(summary.volume.mismatchCount).toBe(0)
    expect(summary.ohlc.maxAbsoluteError).toBeCloseTo(0.004, 12)
    expect(summary.volume.maxAbsoluteError).toBe(47)
  })

  it('compares transaction amounts when both exports provide them', () => {
    const summary = compareTdxExportBars(
      [{
        date: '2026-09-02',
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 100,
        amount: 1050.25,
      }],
      [{
        date: '2026-09-02',
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 100,
        amount: 1050,
      }],
    )

    expect(summary.amount).not.toBeNull()
    expect(summary.amount?.maxAbsoluteError).toBeCloseTo(0.25, 12)
    expect(summary.amount?.mismatchCount).toBe(1)
  })

  it('reports but tolerates a one-cent display difference at a negative half-cent boundary', () => {
    const summary = compareTdxExportBars(
      [{
        date: '2002-09-17',
        open: -313.814982,
        high: -313,
        low: -314,
        close: -313.5,
        volume: 100,
      }],
      [{
        date: '2002-09-17',
        open: -313.82,
        high: -313,
        low: -314,
        close: -313.5,
        volume: 100,
      }],
    )

    expect(summary.ohlc.mismatchCount).toBe(0)
    expect(summary.displayMismatchCount).toBe(1)
    expect(summary.nonPositiveOhlcCompared).toBe(4)
    expect(summary.nonPositiveDisplayMismatchCount).toBe(1)
  })
})
