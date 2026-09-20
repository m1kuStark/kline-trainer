import { describe, expect, it } from 'vitest'
import { parseTdxSymbol } from '../src/tdx/symbol.js'

describe('TDX symbol parsing', () => {
  it('accepts an explicit benchmark-index symbol', () => {
    expect(parseTdxSymbol('sh000300')).toEqual({ market: 'sh', code: '000300', symbol: 'sh000300' })
  })

  it('keeps stock-code market inference for six-digit inputs', () => {
    expect(parseTdxSymbol('600519')).toEqual({ market: 'sh', code: '600519', symbol: 'sh600519' })
    expect(parseTdxSymbol('000001')).toEqual({ market: 'sz', code: '000001', symbol: 'sz000001' })
    expect(parseTdxSymbol('920002')).toEqual({ market: 'bj', code: '920002', symbol: 'bj920002' })
  })

  it('rejects malformed or mismatched symbols', () => {
    expect(() => parseTdxSymbol('000300')).toThrow(/explicit market prefix/i)
    expect(() => parseTdxSymbol('xx000300')).toThrow(/invalid symbol/i)
  })
})
