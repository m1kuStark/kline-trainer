import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
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

describe('SQLite stock catalog cache', () => {
  it('refreshes the first scan, reuses unchanged files, and refreshes one changed mtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-catalog-'))
    const directory = join(root, 'vipdoc', 'sh', 'lday')
    const file = join(directory, 'sh600519.day')
    await mkdir(directory, { recursive: true })
    await writeFile(file, dayRecord(20260901))
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)

    try {
      const first = await refreshStockCatalog(database, root)
      expect(first.stats).toEqual({ refreshed: 1, reused: 0, removed: 0 })
      expect(first.stocks).toEqual([
        expect.objectContaining({ market: 'sh', code: '600519', bars: 1, lastDate: '2026-09-01' }),
      ])

      const second = await refreshStockCatalog(database, root)
      expect(second.stats).toEqual({ refreshed: 0, reused: 1, removed: 0 })

      await writeFile(file, Buffer.concat([dayRecord(20260901), dayRecord(20260902)]))
      const future = new Date(Date.now() + 5_000)
      await utimes(file, future, future)
      const third = await refreshStockCatalog(database, root)
      expect(third.stats).toEqual({ refreshed: 1, reused: 0, removed: 0 })
      expect(third.stocks[0]).toMatchObject({ bars: 2, lastDate: '2026-09-02' })
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes cache rows when the source file disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-catalog-remove-'))
    const directory = join(root, 'vipdoc', 'sz', 'lday')
    const file = join(directory, 'sz000001.day')
    await mkdir(directory, { recursive: true })
    await writeFile(file, dayRecord(20260901))
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)

    try {
      await refreshStockCatalog(database, root)
      await rm(file)
      const refreshed = await refreshStockCatalog(database, root)
      expect(refreshed.stats).toEqual({ refreshed: 0, reused: 0, removed: 1 })
      expect(refreshed.stocks).toEqual([])
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
