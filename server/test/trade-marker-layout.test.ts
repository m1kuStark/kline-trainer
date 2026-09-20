import { describe, expect, it } from 'vitest'
import type { TradeView } from '../../web/src/api'
import { groupTradeMarkers } from '../../web/src/tradeMarkerLayout'

const day = (date: string) => Date.parse(`${date}T00:00:00Z`)
const trade = (seq: number, date: string, side: TradeView['side'] = 'buy'): TradeView => ({
  seq, date, side, price: 12.34, shares: 100, amount: 1234, fee: 5,
})

describe('trade marker rail layout', () => {
  it('preserves an isolated marker at x=102 on a 1020px chart instead of snapping to a bin', () => {
    const clusters = groupTradeMarkers([trade(1, '2026-09-01')], '1D', () => 102, 1020)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.x).toBe(102)
  })

  it('merges overlapping badges across adjacent bins while retaining an isolated marker position', () => {
    const positions = [100, 103, 170]
    const trades = positions.map((_, index) => trade(index, `2026-09-0${index + 1}`))
    const clusters = groupTradeMarkers(trades, '1D', timestamp => positions[(timestamp - day('2026-09-01')) / 86_400_000]!, 1020)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toMatchObject({ x: 101.5, count: 2, trades: [trades[0], trades[1]] })
    expect(clusters[1]).toMatchObject({ x: 170, count: 1, trades: [trades[2]] })
    expect(clusters[0]!.x + clusters[0]!.width / 2).toBeLessThanOrEqual(clusters[1]!.x - clusters[1]!.width / 2)
  })

  it('keeps 1000 dense trades visible in nonoverlapping same-side clusters', () => {
    const origin = day('2020-01-01')
    const trades = Array.from({ length: 1000 }, (_, index) => trade(
      index, new Date(origin + index * 86_400_000).toISOString().slice(0, 10),
    ))
    const clusters = groupTradeMarkers(trades, '1D', timestamp => (timestamp - origin) / 86_400_000 / 2, 500)

    expect(clusters.length).toBeGreaterThan(1)
    expect(clusters.length).toBeLessThanOrEqual(15)
    expect(clusters.reduce((total, cluster) => total + cluster.count, 0)).toBe(1000)
    expect(clusters.flatMap(cluster => cluster.trades).map(item => item.seq).sort((a, b) => a - b))
      .toEqual(trades.map(item => item.seq))
    for (const [index, cluster] of clusters.entries()) {
      expect(cluster.x - cluster.width / 2).toBeGreaterThanOrEqual(0)
      expect(cluster.x + cluster.width / 2).toBeLessThanOrEqual(500)
      const next = clusters[index + 1]
      if (next) expect(cluster.x + cluster.width / 2).toBeLessThanOrEqual(next.x - next.width / 2)
    }
  })

  it('keeps buy and sell clusters separate at the same chart position', () => {
    const trades = [trade(1, '2026-09-07'), trade(2, '2026-09-07', 'sell'), trade(3, '2026-09-07')]
    const clusters = groupTradeMarkers(trades, '1D', () => 80, 300)
    expect(clusters).toHaveLength(2)
    expect(clusters.find(cluster => cluster.side === 'buy')).toMatchObject({ count: 2, trades: [trades[0], trades[2]] })
    expect(clusters.find(cluster => cluster.side === 'sell')).toMatchObject({ count: 1, trades: [trades[1]] })
  })

  it.each([
    ['1D', ['2026-09-07', '2026-09-11'], ['2026-09-07', '2026-09-11']],
    ['1W', ['2026-09-07', '2026-09-11', '2026-09-13'], ['2026-09-07']],
    ['1M', ['2026-09-01', '2026-09-11', '2026-09-30'], ['2026-09-01']],
  ] as const)('projects %s markers using the matching candle timestamp', (timeframe, dates, projectedDates) => {
    const projected: number[] = []
    const clusters = groupTradeMarkers(dates.map((date, index) => trade(index, date)), timeframe, timestamp => {
      projected.push(timestamp)
      return 100
    }, 400)
    expect([...new Set(projected)]).toEqual(projectedDates.map(day))
    expect(clusters[0]?.count).toBe(dates.length)
  })

  it('excludes invalid and offscreen coordinates without piling them on either edge', () => {
    const positions = [-0.01, 0, 160, 160.01, null, Number.NaN, Number.POSITIVE_INFINITY]
    const trades = positions.map((_, index) => trade(index, `2026-09-${String(index + 1).padStart(2, '0')}`))
    const clusters = groupTradeMarkers(trades, '1D', timestamp => positions[(timestamp - day('2026-09-01')) / 86_400_000]!, 160)
    expect(clusters.flatMap(cluster => cluster.trades).map(item => item.seq)).toEqual([1, 2])
    for (const cluster of clusters) {
      expect(cluster.x - cluster.width / 2).toBeGreaterThanOrEqual(0)
      expect(cluster.x + cluster.width / 2).toBeLessThanOrEqual(160)
    }
  })

  it('reprojects and reclusters after resizing or panning', () => {
    const trades = [trade(1, '2026-09-01'), trade(2, '2026-09-02'), trade(3, '2026-09-03')]
    const index = (timestamp: number) => (timestamp - day('2026-09-01')) / 86_400_000
    expect(groupTradeMarkers(trades, '1D', timestamp => 40 + index(timestamp) * 70, 240)).toHaveLength(3)
    const narrow = groupTradeMarkers(trades, '1D', timestamp => 5 + index(timestamp) * 5, 24)
    expect(narrow).toHaveLength(1)
    expect(narrow[0]?.count).toBe(3)
    expect(narrow[0]!.width).toBeLessThanOrEqual(24)
    expect(groupTradeMarkers(trades, '1D', timestamp => index(timestamp) * 70 - 40, 100)
      .flatMap(cluster => cluster.trades).map(item => item.seq)).toEqual([2, 3])
  })

  it.each([0, -1, 17, Number.NaN, Number.POSITIVE_INFINITY])('renders no markers in an unusable width %s', width => {
    expect(groupTradeMarkers([trade(1, '2026-09-01')], '1D', () => 10, width)).toEqual([])
  })
})
