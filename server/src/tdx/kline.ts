import type { DayBar } from './dayfile.js'

export type Timeframe = '1D' | '1W' | '1M'

export interface KlineBar extends DayBar {
  date: string
}

function monthKey(date: string): string {
  return date.slice(0, 7)
}

function mondayKey(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  const offset = (day.getUTCDay() + 6) % 7
  day.setUTCDate(day.getUTCDate() - offset)
  return day.toISOString().slice(0, 10)
}

export function aggregateBars(bars: DayBar[], timeframe: Timeframe): KlineBar[] {
  if (timeframe === '1D') return bars.map(bar => ({ ...bar }))

  const groups = new Map<string, DayBar[]>()
  for (const bar of bars) {
    const key = timeframe === '1M' ? monthKey(bar.date) : mondayKey(bar.date)
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
    amount: group.reduce((sum, bar) => sum + bar.amount, 0),
    volume: group.reduce((sum, bar) => sum + bar.volume, 0),
  }))
}

export function movingAverage(bars: KlineBar[], period: number): Array<number | null> {
  const result: Array<number | null> = []
  let sum = 0
  for (let index = 0; index < bars.length; index += 1) {
    sum += bars[index].close
    if (index >= period) sum -= bars[index - period].close
    result.push(index + 1 >= period ? sum / period : null)
  }
  return result
}
