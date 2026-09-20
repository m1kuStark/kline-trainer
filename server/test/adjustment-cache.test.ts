import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase } from '../src/db.js'
import { loadAdjustmentEvents, refreshAdjustmentCache } from '../src/tdx/adjustment-cache.js'

const encryptedRecord = Buffer.from('9a7f1ae8eafde7194156de939ea709c237a8c90d0924e4d63f00000000', 'hex')

function gbbqFile(): Buffer {
  const payload = Buffer.alloc(4 + encryptedRecord.length)
  payload.writeUInt32LE(1, 0)
  encryptedRecord.copy(payload, 4)
  return payload
}

describe('SQLite adjustment-factor cache', () => {
  it('loads changed gbbq data once and reuses it while the source mtime is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-adjustment-'))
    const directory = join(root, 'T0002', 'hq_cache')
    const file = join(directory, 'gbbq')
    await mkdir(directory, { recursive: true })
    await writeFile(file, gbbqFile())
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)

    try {
      const first = await refreshAdjustmentCache(database, root)
      expect(first).toEqual({ refreshed: true, events: 1 })
      expect(loadAdjustmentEvents(database, 'sh', '600519')).toEqual([
        expect.objectContaining({ date: '2002-07-25', m: 1.1, c: 0.8 }),
      ])

      const second = await refreshAdjustmentCache(database, root)
      expect(second).toEqual({ refreshed: false, events: 1 })

      database.exec('CREATE TABLE audit (action TEXT NOT NULL)')
      database.exec("CREATE TRIGGER audit_adj_delete AFTER DELETE ON adj_factors BEGIN INSERT INTO audit VALUES ('delete'); END")
      database.exec("CREATE TRIGGER audit_adj_insert AFTER INSERT ON adj_factors BEGIN INSERT INTO audit VALUES ('insert'); END")
      const future = new Date(Date.now() + 5_000)
      await utimes(file, future, future)
      const third = await refreshAdjustmentCache(database, root)
      expect(third).toEqual({ refreshed: true, events: 1 })
      expect(database.prepare('SELECT action FROM audit').all()).toEqual([])
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
