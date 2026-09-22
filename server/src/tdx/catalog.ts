import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { readLastDayDate } from './dayfile.js'
import { codeFromDayFile, loadStockNames } from './names.js'
import { isAShareCode, type StockSummary, type TdxMarket } from './stocks.js'

export interface CatalogRefreshStats {
  refreshed: number
  reused: number
  removed: number
}

// 单市场读取失败报告：absent=false 表示该市场曾存在（目录在或缓存有记录）但当前不可读
// （断盘/权限/文件消失/损坏），已保留其上次成功的目录缓存；空 failures 数组表示扫描完整成功。
export interface CatalogMarketFailure {
  market: TdxMarket
  absent: boolean
  message: string
}

export interface CatalogRefreshResult {
  stocks: StockSummary[]
  stats: CatalogRefreshStats
  /** 新增：读取失败、已保留上次缓存的市场；删除缓存只能依据 failures 为空的成功扫描 */
  failures: CatalogMarketFailure[]
  /** 新增：目录不存在且缓存从无记录的市场（未安装的可选市场，维持既有"视为无文件"语义） */
  absentMarkets: TdxMarket[]
}

interface CachedStockRow {
  code: string
  market: TdxMarket
  name: string
  bars: number
  mtime: string
  last_date: string | null
}

// 单个市场的待写入变更：市场扫描完整成功后才允许落库，中途失败即整体丢弃
interface PendingUpsert {
  code: string
  market: TdxMarket
  name: string
  bars: number
  mtime: string
  lastDate: string | null
}

/**
 * 目录刷新的两段式结构：scan 只读（文件系统＋缓存读取，不写库），
 * apply 同步执行全部写入（调用方必须已开启事务）。整批发布（DATA-01）
 * 由协调器把 apply 与权息、快照放在同一事务内一次性提交。
 */
export interface CatalogChanges {
  pending: PendingUpsert[]
  removals: Array<{ code: string; market: TdxMarket }>
  stats: CatalogRefreshStats
  failures: CatalogMarketFailure[]
  absentMarkets: TdxMarket[]
}

function readCachedStocks(database: DatabaseSync): StockSummary[] {
  const rows = database.prepare(`
    SELECT code, market, name, bars, mtime, last_date
    FROM stocks ORDER BY code
  `).all() as unknown as CachedStockRow[]
  return rows.map(row => ({
    code: row.code,
    market: row.market,
    name: row.name,
    bars: row.bars,
    mtime: row.mtime,
    lastDate: row.last_date,
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 目录读取失败绝不当空目录：非 ENOENT（EBUSY/占用等瞬时错误）稍候重试一次，仍失败按失败上报
async function readDirectoryWithRetry(directory: string): Promise<{ ok: true; files: string[] } | { ok: false; error: NodeJS.ErrnoException }> {
  try {
    return { ok: true, files: await readdir(directory) }
  } catch (first) {
    const firstError = first as NodeJS.ErrnoException
    if (firstError.code !== 'ENOENT') await sleep(50)
    try {
      return { ok: true, files: await readdir(directory) }
    } catch (second) {
      return { ok: false, error: second as NodeJS.ErrnoException }
    }
  }
}

/** 只读扫描：读取缓存与各市场日线目录，产出待写入变更；绝不写库、绝不删除缓存。 */
export async function scanCatalogChanges(database: DatabaseSync, tdxRoot: string): Promise<CatalogChanges> {
  const cached = new Map(readCachedStocks(database).map(stock => [`${stock.market}:${stock.code}`, stock]))
  const seen = new Set<string>()
  const failedMarkets = new Set<TdxMarket>()
  const absentMarkets: TdxMarket[] = []
  const failures: CatalogMarketFailure[] = []
  const stats: CatalogRefreshStats = { refreshed: 0, reused: 0, removed: 0 }
  const pending: PendingUpsert[] = []

  for (const market of ['sh', 'sz', 'bj'] as TdxMarket[]) {
    const directory = join(tdxRoot, 'vipdoc', market, 'lday')
    const read = await readDirectoryWithRetry(directory)
    if (!read.ok) {
      const cachedCount = [...cached.values()].filter(stock => stock.market === market).length
      if (read.error.code === 'ENOENT' && cachedCount === 0) {
        // 确实不存在的可选市场：维持既有语义（视为无文件），单独记录以便与"曾存在但暂不可读"区分
        absentMarkets.push(market)
      } else {
        // 曾存在但暂不可读（断盘/权限）：必须报告并保留上次成功的目录缓存，绝不清空
        failedMarkets.add(market)
        failures.push({
          market,
          absent: false,
          message: `市场 ${market} 目录读取失败（${read.error.code ?? read.error.message}），已保留上次成功的目录缓存（${cachedCount} 只），本次不删除该市场缓存`,
        })
      }
      continue
    }
    const names = new Map((await loadStockNames(tdxRoot, market)).map(item => [item.code, item.name]))
    const marketPending: PendingUpsert[] = []
    const marketSeen = new Set<string>()
    const marketStats = { refreshed: 0, reused: 0 }
    try {
      for (const file of read.files.filter(item => item.toLowerCase().endsWith('.day'))) {
        const code = codeFromDayFile(file)
        if (!code || !isAShareCode(market, code)) continue
        const key = `${market}:${code}`
        marketSeen.add(key)
        const filePath = join(directory, file)
        const info = await stat(filePath)
        if (info.size % 32 !== 0) {
          throw new Error(`日线文件 ${file} 长度 ${info.size} 字节不是 32 字节记录的整数倍`)
        }
        const mtime = info.mtime.toISOString()
        const existing = cached.get(key)
        const name = names.get(code) ?? existing?.name ?? code
        if (existing?.mtime === mtime && existing.bars === Math.floor(info.size / 32)) {
          marketStats.reused += 1
          if (existing.name !== name) marketPending.push({ code, market, name, bars: existing.bars, mtime, lastDate: existing.lastDate })
          continue
        }
        marketPending.push({ code, market, name, bars: Math.floor(info.size / 32), mtime, lastDate: await readLastDayDate(filePath) })
        marketStats.refreshed += 1
      }
    } catch (error) {
      // 文件级异常（文件消失/占用/损坏）：整个市场按失败处理，本次变更全部丢弃，保留旧缓存
      const message = error instanceof Error ? error.message : String(error)
      failedMarkets.add(market)
      const cachedCount = [...cached.values()].filter(stock => stock.market === market).length
      failures.push({
        market,
        absent: false,
        message: `市场 ${market} 日线文件扫描失败（${message}），已保留上次成功的目录缓存（${cachedCount} 只），本次不应用该市场变更`,
      })
      continue
    }
    for (const key of marketSeen) seen.add(key)
    pending.push(...marketPending)
    stats.refreshed += marketStats.refreshed
    stats.reused += marketStats.reused
  }

  // 只有扫描完整成功的市场才允许用新结果替换缓存；失败/缺席市场一律不删缓存
  const removals: Array<{ code: string; market: TdxMarket }> = []
  for (const stock of cached.values()) {
    if (failedMarkets.has(stock.market)) continue
    if (!seen.has(`${stock.market}:${stock.code}`)) removals.push({ code: stock.code, market: stock.market })
  }
  stats.removed = removals.length

  return { pending, removals, stats, failures, absentMarkets }
}

/** 应用阶段：执行全部目录写入（upsert＋移除）。调用方必须已开启事务；同步执行，异常由调用方回滚。 */
export function applyCatalogChanges(database: DatabaseSync, changes: CatalogChanges): void {
  const upsert = database.prepare(`
    INSERT INTO stocks (code, market, name, type, bars, mtime, last_date)
    VALUES (?, ?, ?, 'A', ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      market = excluded.market, name = excluded.name, type = excluded.type,
      bars = excluded.bars, mtime = excluded.mtime, last_date = excluded.last_date
  `)
  for (const item of changes.pending) {
    upsert.run(item.code, item.market, item.name, item.bars, item.mtime, item.lastDate)
  }
  const remove = database.prepare('DELETE FROM stocks WHERE code = ?')
  for (const item of changes.removals) {
    remove.run(item.code)
  }
}

export async function refreshStockCatalog(database: DatabaseSync, tdxRoot: string): Promise<CatalogRefreshResult> {
  const changes = await scanCatalogChanges(database, tdxRoot)
  database.exec('BEGIN')
  try {
    applyCatalogChanges(database, changes)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { stocks: readCachedStocks(database), stats: changes.stats, failures: changes.failures, absentMarkets: changes.absentMarkets }
}
