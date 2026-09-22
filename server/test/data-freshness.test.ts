import { describe, expect, it } from 'vitest'
import { assessFreshness, shanghaiDate } from '../src/data/freshness.js'
import type { FreshnessResult, TradingCalendar } from '../src/data/freshness.js'

// Synthetic closed days only. This table is NOT the official SSE calendar; it
// exists so expectations are fully determined by the fixture.
const CALENDAR: TradingCalendar = {
  id: 'synthetic-test-calendar',
  from: '2026-08-24', // Monday
  through: '2026-10-17', // Saturday
  closedDates: ['2026-09-04', '2026-09-28', '2026-10-01', '2026-10-02'],
}

const at = (iso: string) => new Date(iso)

const CAVEAT = '来源末日不证明所有股票完整'

describe('shanghaiDate', () => {
  it('shifts a UTC instant onto the Shanghai calendar date', () => {
    expect(shanghaiDate(at('2026-09-23T15:59:59Z'))).toBe('2026-09-23')
    expect(shanghaiDate(at('2026-09-23T16:00:00Z'))).toBe('2026-09-24')
  })

  it('keeps working before UTC midnight while Shanghai is still on the prior day', () => {
    expect(shanghaiDate(at('2026-01-01T00:30:00Z'))).toBe('2026-01-01')
    expect(shanghaiDate(at('2026-12-31T16:00:00Z'))).toBe('2027-01-01')
  })

  it('throws on an invalid Date value', () => {
    expect(() => shanghaiDate(new Date('not-a-date'))).toThrow(/valid Date/)
  })

  it('throws on a non-Date value passed from JS', () => {
    expect(() => shanghaiDate('2026-09-23' as unknown as Date)).toThrow(/valid Date/)
  })
})

describe('assessFreshness expected-date computation', () => {
  it('includes the Shanghai day at exactly 15:00 and later', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: '2026-09-23', calendar: CALENDAR })
    expect(result.expectedDate).toBe('2026-09-23')
    expect(result.state).toBe('current')
  })

  it('uses the previous closed trading day strictly before 15:00', () => {
    const result = assessFreshness({ now: at('2026-09-23T06:59:00Z'), sourceMaxDate: '2026-09-22', calendar: CALENDAR })
    expect(result.expectedDate).toBe('2026-09-22')
    expect(result.state).toBe('current')
  })

  it('steps back over weekends regardless of clock time', () => {
    const saturday = assessFreshness({ now: at('2026-09-26T07:00:00Z'), sourceMaxDate: '2026-09-25', calendar: CALENDAR })
    expect(saturday.expectedDate).toBe('2026-09-25')
    expect(saturday.state).toBe('current')
  })

  it('steps back over synthetic closed days and weekends together', () => {
    // Tuesday 2026-09-29 before open: previous closed trading day is Friday
    // 2026-09-25 (Monday 09-28 is closed in the fixture).
    const result = assessFreshness({ now: at('2026-09-29T00:00:00Z'), sourceMaxDate: '2026-09-25', calendar: CALENDAR })
    expect(result.expectedDate).toBe('2026-09-25')
    expect(result.state).toBe('current')
  })

  it('reports stale when the source lags the expected close day', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: '2026-09-22', calendar: CALENDAR })
    expect(result.state).toBe('stale')
    expect(result.expectedDate).toBe('2026-09-23')
  })
})

describe('assessFreshness source-side conservatism', () => {
  it('never claims current when sourceMaxDate is null', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: null, calendar: CALENDAR })
    expect(result.state).toBe('unknown')
    expect(result.expectedDate).toBe('2026-09-23')
  })

  it('treats a malformed sourceMaxDate as unknown', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: '2026/09/23', calendar: CALENDAR })
    expect(result.state).toBe('unknown')
  })

  it('treats a sourceMaxDate after the Shanghai system date as unknown', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: '2026-09-24', calendar: CALENDAR })
    expect(result.state).toBe('unknown')
  })

  it('treats a non-string sourceMaxDate from JS as unknown', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: 20260923 as unknown as string, calendar: CALENDAR })
    expect(result.state).toBe('unknown')
    expect(result.sourceMaxDate).toBeNull()
    const missingCalendar = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: 20260923 as unknown as string })
    expect(missingCalendar).toMatchObject({ state: 'unknown', sourceMaxDate: null, expectedDate: null })
  })

  it('echoes sourceMaxDate and records checkedAt in UTC ISO form', () => {
    const now = at('2026-09-23T07:00:00Z')
    const result = assessFreshness({ now, sourceMaxDate: '2026-09-22', calendar: CALENDAR })
    expect(result.sourceMaxDate).toBe('2026-09-22')
    expect(result.checkedAt).toBe(now.toISOString())
  })
})

describe('assessFreshness calendar conservatism', () => {
  it('is unknown without a calendar and does not invent an expected day', () => {
    const result = assessFreshness({ now: at('2026-09-23T07:00:00Z'), sourceMaxDate: '2026-09-23' })
    expect(result.state).toBe('unknown')
    expect(result.expectedDate).toBeNull()
  })

  it('treats a null calendar from JS like a missing one', () => {
    const result = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: null as unknown as TradingCalendar,
    })
    expect(result.state).toBe('unknown')
    expect(result.expectedDate).toBeNull()
  })

  it('is unknown when a boundary date is not a valid civil date', () => {
    const badFrom = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: { ...CALENDAR, from: '2026-9-1' },
    })
    const impossibleClosed = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: { ...CALENDAR, closedDates: ['2026-02-30'] },
    })
    expect(badFrom.state).toBe('unknown')
    expect(badFrom.expectedDate).toBeNull()
    expect(impossibleClosed.state).toBe('unknown')
  })

  it('is unknown when closedDates are not sorted ascending and unique', () => {
    const result = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: { ...CALENDAR, closedDates: ['2026-10-01', '2026-09-04'] },
    })
    expect(result.state).toBe('unknown')
    expect(result.expectedDate).toBeNull()
  })

  it('is unknown when a closed date falls outside the declared range', () => {
    const result = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: { ...CALENDAR, closedDates: ['2026-11-02'] },
    })
    expect(result.state).toBe('unknown')
  })

  it('is unknown when from is after through', () => {
    const result = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: { ...CALENDAR, from: '2026-10-01', through: '2026-09-01' },
    })
    expect(result.state).toBe('unknown')
  })

  it('is unknown when the calendar does not cover the Shanghai system date', () => {
    const result = assessFreshness({
      now: at('2026-09-23T07:00:00Z'),
      sourceMaxDate: '2026-09-23',
      calendar: { ...CALENDAR, through: '2026-09-20' },
    })
    expect(result.state).toBe('unknown')
    expect(result.expectedDate).toBeNull()
  })

  it('is unknown when the calendar lacks enough history before the expected day', () => {
    const result = assessFreshness({
      now: at('2026-09-23T06:59:00Z'),
      sourceMaxDate: '2026-09-22',
      calendar: { ...CALENDAR, from: '2026-09-23' },
    })
    expect(result.state).toBe('unknown')
    expect(result.expectedDate).toBeNull()
  })
})

describe('assessFreshness input validation', () => {
  it('throws on an invalid now Date', () => {
    expect(() => assessFreshness({ now: new Date('nope'), sourceMaxDate: null, calendar: CALENDAR })).toThrow(/valid Date/)
  })

  it('throws on a non-object input from JS', () => {
    expect(() => assessFreshness(null as unknown as Parameters<typeof assessFreshness>[0])).toThrow(TypeError)
    expect(() => assessFreshness({ sourceMaxDate: '2026-09-23' } as unknown as Parameters<typeof assessFreshness>[0])).toThrow(/valid Date/)
  })
})

describe('assessFreshness reason contract', () => {
  it('states in every reason that the source max date proves no per-stock completeness', () => {
    const now = at('2026-09-23T07:00:00Z')
    const results: FreshnessResult[] = [
      assessFreshness({ now, sourceMaxDate: '2026-09-23', calendar: CALENDAR }),
      assessFreshness({ now, sourceMaxDate: '2026-09-22', calendar: CALENDAR }),
      assessFreshness({ now, sourceMaxDate: null, calendar: CALENDAR }),
      assessFreshness({ now, sourceMaxDate: '2026-09-23' }),
      assessFreshness({ now, sourceMaxDate: '2026-09-24', calendar: CALENDAR }),
    ]
    for (const result of results) {
      expect(result.reason).toContain(CAVEAT)
    }
  })

  it('names the expected day and source day in current and stale reasons', () => {
    const now = at('2026-09-23T07:00:00Z')
    const current = assessFreshness({ now, sourceMaxDate: '2026-09-23', calendar: CALENDAR })
    const stale = assessFreshness({ now, sourceMaxDate: '2026-09-21', calendar: CALENDAR })
    expect(current.reason).toContain('2026-09-23')
    expect(stale.reason).toContain('2026-09-21')
    expect(stale.reason).toContain('2026-09-23')
  })
})
