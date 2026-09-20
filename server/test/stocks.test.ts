import { describe, expect, it } from 'vitest'
import { isAShareCode } from '../src/tdx/stocks.js'

describe('A-share catalog filter', () => {
  it('keeps Shanghai, Shenzhen and Beijing A shares', () => {
    expect(isAShareCode('sh', '600519')).toBe(true)
    expect(isAShareCode('sh', '688001')).toBe(true)
    expect(isAShareCode('sz', '000001')).toBe(true)
    expect(isAShareCode('sz', '300750')).toBe(true)
    expect(isAShareCode('bj', '920002')).toBe(true)
  })

  it('excludes indices, B shares and funds', () => {
    expect(isAShareCode('sh', '000001')).toBe(false)
    expect(isAShareCode('sh', '510300')).toBe(false)
    expect(isAShareCode('sz', '200001')).toBe(false)
    expect(isAShareCode('sz', '159919')).toBe(false)
  })
})
