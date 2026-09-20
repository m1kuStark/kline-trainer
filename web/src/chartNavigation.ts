import type { Timeframe } from './api'

export const MAX_VISIBLE_BARS = 840
const TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M']

export function nextTimeframe(timeframe: Timeframe, direction: 1 | -1): Timeframe {
  return TIMEFRAMES[(TIMEFRAMES.indexOf(timeframe) + direction + TIMEFRAMES.length) % TIMEFRAMES.length]
}

export function cycleDirection(event: Pick<KeyboardEvent, 'key' | 'code'> & Partial<KeyboardEvent>): -1 | 0 | 1 {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return 0
  if (event.code === 'BracketRight' || event.key === ']') return 1
  if (event.code === 'BracketLeft' || event.key === '[') return -1
  return 0
}
