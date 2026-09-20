import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { codeFromDayFile, loadStockNames, type StockName } from './names.js'
import { readLastDayDate } from './dayfile.js'

export type TdxMarket = 'sh' | 'sz' | 'bj'

export interface StockSummary extends StockName {
  bars: number
  mtime: string
  lastDate: string | null
}

export function isAShareCode(market: TdxMarket, code: string): boolean {
  if (market === 'sh') return /^(600|601|603|605|688|689)\d{3}$/.test(code)
  if (market === 'sz') return /^(000|001|002|003|300|301)\d{3}$/.test(code)
  return /^(4|8|92)\d{4}$/.test(code)
}

export async function scanStocks(tdxRoot: string): Promise<StockSummary[]> {
  const all: StockSummary[] = []
  for (const market of ['sh', 'sz', 'bj'] as TdxMarket[]) {
    const directory = join(tdxRoot, 'vipdoc', market, 'lday')
    const names = new Map((await loadStockNames(tdxRoot, market)).map(item => [item.code, item]))
    const files = await readdir(directory).catch(() => [])
    const summaries = await Promise.all(files.filter(item => item.toLowerCase().endsWith('.day')).map(async file => {
      const code = codeFromDayFile(file)
      if (!code || !isAShareCode(market, code)) return null
      const filePath = join(directory, file)
      const info = await stat(filePath)
      return {
        ...(names.get(code) ?? { code, market, name: code }),
        bars: Math.floor(info.size / 32),
        mtime: info.mtime.toISOString(),
        lastDate: await readLastDayDate(filePath),
      } satisfies StockSummary
    }))
    all.push(...summaries.filter((summary): summary is StockSummary => summary !== null))
  }
  return all.sort((left, right) => left.code.localeCompare(right.code))
}
