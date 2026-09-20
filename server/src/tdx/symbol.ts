import type { TdxMarket } from './stocks.js'

export interface TdxSymbol {
  market: TdxMarket
  code: string
  symbol: string
}

export function parseTdxSymbol(value: string): TdxSymbol {
  const normalized = value.trim().toLowerCase()
  const explicit = normalized.match(/^(sh|sz|bj)(\d{6})$/)
  if (explicit) {
    const market = explicit[1] as TdxMarket
    const code = explicit[2]
    return { market, code, symbol: `${market}${code}` }
  }
  if (!/^\d{6}$/.test(normalized)) throw new Error(`Invalid symbol: ${value}`)
  if (normalized.startsWith('0003')) {
    throw new Error(`Benchmark index ${normalized} requires an explicit market prefix such as sh${normalized}`)
  }
  const market: TdxMarket = normalized.startsWith('6')
    ? 'sh'
    : /^(4|8|92)/.test(normalized) ? 'bj' : 'sz'
  return { market, code: normalized, symbol: `${market}${normalized}` }
}
