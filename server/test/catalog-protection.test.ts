import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase } from '../src/db.js'
import { refreshStockCatalog } from '../src/tdx/catalog.js'

function dayRecord(date: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeInt32LE(date, 0)
  buffer.writeInt32LE(1000, 4)
  buffer.writeInt32LE(1100, 8)
  buffer.writeInt32LE(900, 12)
  buffer.writeInt32LE(1050, 16)
  return buffer
}

async function writeMarketFile(root: string, market: 'sh' | 'sz', file: string, records: Buffer[]): Promise<void> {
  const directory = join(root, 'vipdoc', market, 'lday')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, file), Buffer.concat(records))
}

describe('catalog read-failure protection', () => {
  it('preserves the cached market and reports a failure when its directory disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-catalog-protect-'))
    await writeMarketFile(root, 'sh', 'sh600519.day', [dayRecord(20260901)])
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)

    try {
      const first = await refreshStockCatalog(database, root)
      expect(first.failures).toEqual([])
      expect(first.absentMarkets).toEqual(['sz', 'bj'])
      expect(first.stocks).toHaveLength(1)

      // 断盘模拟：市场目录整个消失，但缓存中已有该市场记录 → 按"曾存在但暂不可读"处理
      await rm(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true, force: true })
      const failed = await refreshStockCatalog(database, root)
      expect(failed.stats.removed).toBe(0)
      expect(failed.stocks).toEqual(first.stocks)
      const shFailure = failed.failures.find(failure => failure.market === 'sh')
      expect(shFailure?.absent).toBe(false)
      expect(shFailure?.message).toContain('sh')
      expect(shFailure?.message).toContain('保留')
      // 未安装的可选市场（目录不存在且缓存从无记录）与暂不可读市场可区分
      expect(failed.absentMarkets).toEqual(['sz', 'bj'])
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces the cache only after a fully successful rescan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-catalog-protect-replace-'))
    await writeMarketFile(root, 'sh', 'sh600519.day', [dayRecord(20260901)])
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)

    try {
      await refreshStockCatalog(database, root)
      await rm(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true, force: true })
      const failed = await refreshStockCatalog(database, root)
      expect(failed.failures).toHaveLength(1)
      expect(failed.stocks).toHaveLength(1)

      // 目录恢复且内容更新：扫描完整成功 → 缓存正常替换，失败清零
      await writeMarketFile(root, 'sh', 'sh600519.day', [dayRecord(20260901), dayRecord(20260902)])
      const recovered = await refreshStockCatalog(database, root)
      expect(recovered.failures).toEqual([])
      expect(recovered.stats).toEqual({ refreshed: 1, reused: 0, removed: 0 })
      expect(recovered.stocks[0]).toMatchObject({ market: 'sh', code: '600519', bars: 2, lastDate: '2026-09-02' })
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates the healthy market and keeps the failed market cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-catalog-protect-market-'))
    await writeMarketFile(root, 'sh', 'sh600519.day', [dayRecord(20260901)])
    await writeMarketFile(root, 'sz', 'sz000001.day', [dayRecord(20260901)])
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)

    try {
      const first = await refreshStockCatalog(database, root)
      expect(first.stocks).toHaveLength(2)

      // 文件级异常：sh 日线文件损坏（非 32 字节整倍数）→ sh 整市场按失败处理，保留旧缓存
      await writeMarketFile(root, 'sh', 'sh600519.day', [dayRecord(20260901), Buffer.alloc(10)])
      const failed = await refreshStockCatalog(database, root)
      const shFailure = failed.failures.find(failure => failure.market === 'sh')
      expect(shFailure?.absent).toBe(false)
      expect(shFailure?.message).toContain('保留')
      expect(failed.stats.removed).toBe(0)
      expect(failed.stats.reused).toBe(1)
      expect(failed.stocks.find(stock => stock.market === 'sh')).toMatchObject({ code: '600519', lastDate: '2026-09-01' })
      expect(failed.stocks.find(stock => stock.market === 'sz')).toMatchObject({ code: '000001' })

      // 修复后：sh 恢复正常替换，sz不受影响
      await writeMarketFile(root, 'sh', 'sh600519.day', [dayRecord(20260901), dayRecord(20260902)])
      const recovered = await refreshStockCatalog(database, root)
      expect(recovered.failures).toEqual([])
      expect(recovered.stocks.find(stock => stock.market === 'sh')).toMatchObject({ code: '600519', bars: 2, lastDate: '2026-09-02' })
      expect(recovered.stocks.find(stock => stock.market === 'sz')).toMatchObject({ code: '000001' })
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
