import { describe, expect, it } from 'vitest'
import { applyForwardAdjustment, buildForwardAdjustmentSegments, parseGbbqBuffer } from '../src/tdx/gbbq.js'
import type { DayBar } from '../src/tdx/dayfile.js'

describe('TDX gbbq parser', () => {
  it('decrypts and parses a synthetic category-1 record with a fictional dividend', () => {
    const encrypted = Buffer.from('9a7f1ae8eafde7194156de939ea709c237a8c90d0924e4d63f00000000', 'hex')
    const payload = Buffer.alloc(4 + encrypted.length)
    payload.writeUInt32LE(1, 0)
    encrypted.copy(payload, 4)

    expect(parseGbbqBuffer(payload)).toEqual([{
      market: 'sh',
      code: '600519',
      date: '2002-07-25',
      category: 1,
      dividend: 8,
      rightsPrice: 0,
      bonusShares: 1,
      rightsShares: 0,
      m: 1.1,
      c: 0.8,
    }])
  })

  it('rejects a record count that does not match the file length', () => {
    const payload = Buffer.alloc(4 + 29)
    payload.writeUInt32LE(2, 0)
    expect(() => parseGbbqBuffer(payload)).toThrow(/record count/i)
  })
})

describe('forward adjustment', () => {
  const bars: DayBar[] = [
    { date: '2020-01-01', open: 20, high: 22, low: 18, close: 21, amount: 100, volume: 10 },
    { date: '2020-06-01', open: 15, high: 16, low: 14, close: 15.5, amount: 200, volume: 20 },
    { date: '2021-01-01', open: 12, high: 13, low: 11, close: 12.5, amount: 300, volume: 30 },
  ]

  const events = [
    { market: 'sh' as const, code: '600000', date: '2020-03-01', category: 1, dividend: 1, rightsPrice: 0, bonusShares: 1, rightsShares: 0, m: 1.1, c: 0.1 },
    { market: 'sh' as const, code: '600000', date: '2020-09-01', category: 1, dividend: 2, rightsPrice: 5, bonusShares: 0, rightsShares: 2, m: 1.2, c: -0.8 },
  ]

  it('composes later events while keeping the latest segment unchanged', () => {
    const segments = buildForwardAdjustmentSegments(events)
    expect(segments.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: '2020-09-01', to: null },
      { from: '2020-03-01', to: '2020-08-31' },
      { from: null, to: '2020-02-29' },
    ])
    expect(segments[0]).toMatchObject({ a: 1, b: 0 })
    expect(segments[1].a).toBeCloseTo(5 / 6, 12)
    expect(segments[1].b).toBeCloseTo(2 / 3, 12)
    expect(segments[2].a).toBeCloseTo(25 / 33, 12)
    expect(segments[2].b).toBeCloseTo(13 / 22, 12)
  })

  it('adjusts OHLC only and preserves amount and volume', () => {
    const adjusted = applyForwardAdjustment(bars, events)
    expect(adjusted[0]).toEqual({
      date: '2020-01-01',
      open: 20 * (25 / 33) + 13 / 22,
      high: 22 * (25 / 33) + 13 / 22,
      low: 18 * (25 / 33) + 13 / 22,
      close: 21 * (25 / 33) + 13 / 22,
      amount: 100,
      volume: 10,
    })
    expect(adjusted[1]).toMatchObject({ date: '2020-06-01', amount: 200, volume: 20 })
    expect(adjusted[1].open).toBeCloseTo(13.166666666666668, 12)
    expect(adjusted[1].high).toBeCloseTo(14, 12)
    expect(adjusted[1].low).toBeCloseTo(12.333333333333334, 12)
    expect(adjusted[1].close).toBeCloseTo(13.583333333333334, 12)
    expect(adjusted[2]).toEqual(bars[2])
  })

  it('ignores corporate-action events after the latest local data date', () => {
    const futureEvent = {
      ...events[1],
      date: '2022-01-01',
      m: 2,
      c: 5,
    }

    expect(applyForwardAdjustment(bars, [...events, futureEvent], '2021-01-01')).toEqual(
      applyForwardAdjustment(bars, events, '2021-01-01'),
    )
  })
})
