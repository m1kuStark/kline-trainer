import { describe, expect, it } from 'vitest'
import { nextTimeframe, cycleDirection, MAX_VISIBLE_BARS } from '../../web/src/chartNavigation'
import { TRAINING_LOAD_BARS } from '../src/train/engine'

describe('chart navigation', () => {
  it('cycles both directions through every timeframe and wraps', () => {
    expect(['1D', '1W', '1M'].map(tf => nextTimeframe(tf as '1D' | '1W' | '1M', 1))).toEqual(['1W', '1M', '1D'])
    expect(['1D', '1W', '1M'].map(tf => nextTimeframe(tf as '1D' | '1W' | '1M', -1))).toEqual(['1M', '1D', '1W'])
  })
  it('uses bracket keys while excluding modified shortcuts, repeat and IME', () => {
    expect(cycleDirection({ key: ']', code: 'BracketRight' })).toBe(1)
    expect(cycleDirection({ key: '[', code: 'BracketLeft' })).toBe(-1)
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) {
      expect(cycleDirection({ key: ']', code: 'BracketRight', ...extra })).toBe(0)
    }
    expect(cycleDirection({ key: 'a', code: 'KeyA' })).toBe(0)
  })
  it('supplies 840 visible bars plus 200 warmup bars', () => {
    expect(MAX_VISIBLE_BARS).toBe(840)
    expect(TRAINING_LOAD_BARS).toBe(1040)
  })
})
