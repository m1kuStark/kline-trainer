import { describe, expect, it } from 'vitest'
import { aggregateBars } from '../src/tdx/kline.js'
import type { DayBar } from '../src/tdx/dayfile.js'

const bars: DayBar[] = [
  { date: '2026-08-31', open: 10, high: 12, low: 9, close: 11, amount: 100, volume: 10 },
  { date: '2026-09-01', open: 11, high: 13, low: 10, close: 12, amount: 200, volume: 20 },
  { date: '2026-09-02', open: 12, high: 14, low: 11, close: 13, amount: 300, volume: 30 },
]

describe('K-line aggregation', () => {
  it('aggregates daily bars into month bars', () => {
    expect(aggregateBars(bars, '1M')).toEqual([
      { date: '2026-08', open: 10, high: 12, low: 9, close: 11, amount: 100, volume: 10 },
      { date: '2026-09', open: 11, high: 14, low: 10, close: 13, amount: 500, volume: 50 },
    ])
  })

  it('aggregates daily bars into ISO-week bars starting on Monday', () => {
    expect(aggregateBars(bars, '1W')).toEqual([
      { date: '2026-08-31', open: 10, high: 14, low: 9, close: 13, amount: 600, volume: 60 },
    ])
  })

  it('keeps the completed week separate from the forming week', () => {
    const boundaryBars: DayBar[] = [
      { date: '2026-08-28', open: 8, high: 9, low: 7, close: 8.5, amount: 80, volume: 8 },
      { date: '2026-08-31', open: 10, high: 12, low: 9, close: 11, amount: 100, volume: 10 },
      { date: '2026-09-01', open: 11, high: 13, low: 10, close: 12, amount: 200, volume: 20 },
    ]

    expect(aggregateBars(boundaryBars, '1W')).toEqual([
      { date: '2026-08-24', open: 8, high: 9, low: 7, close: 8.5, amount: 80, volume: 8 },
      { date: '2026-08-31', open: 10, high: 13, low: 9, close: 12, amount: 300, volume: 30 },
    ])
  })
})
