import type { Timeframe, TradeView } from './api'

export interface TradeMarkerCluster {
  side: TradeView['side']
  x: number
  width: number
  count: number
  trades: TradeView[]
}

interface ProjectedTradeGroup {
  side: TradeView['side']
  sumX: number
  trades: TradeView[]
}

export function groupTradeMarkers(
  trades: readonly TradeView[],
  timeframe: Timeframe,
  project: (timestamp: number) => number | null,
  width: number,
): TradeMarkerCluster[] {
  if (!Number.isFinite(width) || width < 18) return []

  const cellCount = Math.max(1, Math.floor(width / 34))
  const cellWidth = width / cellCount
  const groups = new Map<string, ProjectedTradeGroup>()

  for (const trade of trades) {
    const date = new Date(`${trade.date}T00:00:00Z`)
    if (timeframe === '1W') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    if (timeframe === '1M') date.setUTCDate(1)
    const timestamp = date.getTime()
    if (!Number.isFinite(timestamp)) continue
    const x = project(timestamp)
    if (x === null || !Number.isFinite(x) || x < 0 || x > width) continue

    const cell = Math.min(cellCount - 1, Math.floor(x / cellWidth))
    const key = `${trade.side}:${cell}`
    const group = groups.get(key)
    if (group) {
      group.sumX += x
      group.trades.push(trade)
    } else {
      groups.set(key, { side: trade.side, sumX: x, trades: [trade] })
    }
  }

  function toMarker(group: ProjectedTradeGroup): TradeMarkerCluster {
    const count = group.trades.length
    const badgeWidth = Math.min(width, count === 1 ? 18 : count < 10 ? 26 : 32)
    return {
      side: group.side,
      x: Math.max(badgeWidth / 2, Math.min(width - badgeWidth / 2, group.sumX / count)),
      width: badgeWidth,
      count,
      trades: group.trades,
    }
  }

  const ordered = [...groups.values()].sort((a, b) => a.side.localeCompare(b.side) || a.sumX / a.trades.length - b.sumX / b.trades.length)
  const merged: ProjectedTradeGroup[] = []
  for (let current of ordered) {
    // Preserve projected positions; merge collisions instead of snapping to cells.
    while (merged.length) {
      const previous = merged[merged.length - 1]!
      if (previous.side !== current.side) break
      const left = toMarker(previous)
      const right = toMarker(current)
      if (left.x + left.width / 2 <= right.x - right.width / 2) break
      merged.pop()
      previous.sumX += current.sumX
      previous.trades.push(...current.trades)
      current = previous
    }
    merged.push(current)
  }
  return merged.map(toMarker)
}
