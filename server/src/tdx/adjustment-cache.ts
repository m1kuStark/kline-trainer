import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { readGbbqFile, type AdjustmentEvent } from './gbbq.js'
import type { TdxMarket } from './stocks.js'

interface AdjustmentRow {
  market: TdxMarket
  code: string
  date: string
  dividend: number
  rights_price: number
  bonus_shares: number
  rights_shares: number
  m: number
  c: number
}

function rowToEvent(row: AdjustmentRow): AdjustmentEvent {
  return {
    market: row.market,
    code: row.code,
    date: row.date,
    category: 1,
    dividend: row.dividend,
    rightsPrice: row.rights_price,
    bonusShares: row.bonus_shares,
    rightsShares: row.rights_shares,
    m: row.m,
    c: row.c,
  }
}

export function loadAdjustmentEvents(database: DatabaseSync, market: TdxMarket, code: string): AdjustmentEvent[] {
  const rows = database.prepare(`
    SELECT market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
    FROM adj_factors WHERE market = ? AND code = ? ORDER BY date
  `).all(market, code) as unknown as AdjustmentRow[]
  return rows.map(rowToEvent)
}

export async function refreshAdjustmentCache(
  database: DatabaseSync,
  tdxRoot: string,
): Promise<{ refreshed: boolean; events: number }> {
  const filePath = join(tdxRoot, 'T0002', 'hq_cache', 'gbbq')
  const info = await stat(filePath)
  const fingerprint = `${info.size}:${info.mtime.toISOString()}`
  const cached = database.prepare("SELECT value FROM cache_meta WHERE key = 'gbbq_fingerprint'").get() as unknown as { value: string } | undefined
  if (cached?.value === fingerprint) {
    const count = database.prepare('SELECT COUNT(*) AS count FROM adj_factors').get() as unknown as { count: number }
    return { refreshed: false, events: count.count }
  }

  const events = await readGbbqFile(filePath)
  const existingRows = database.prepare(`
    SELECT market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
    FROM adj_factors
  `).all() as unknown as AdjustmentRow[]
  const existing = new Map(existingRows.map(row => [`${row.market}:${row.code}:${row.date}`, row]))
  const incoming = new Map(events.map(event => [`${event.market}:${event.code}:${event.date}`, event]))
  const remove = database.prepare('DELETE FROM adj_factors WHERE market = ? AND code = ? AND date = ?')
  const upsert = database.prepare(`
    INSERT INTO adj_factors (
      market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market, code, date) DO UPDATE SET
      dividend = excluded.dividend,
      rights_price = excluded.rights_price,
      bonus_shares = excluded.bonus_shares,
      rights_shares = excluded.rights_shares,
      m = excluded.m,
      c = excluded.c
  `)
  const changed = (left: AdjustmentRow | undefined, right: AdjustmentEvent): boolean => {
    if (!left) return true
    return left.dividend !== right.dividend
      || left.rights_price !== right.rightsPrice
      || left.bonus_shares !== right.bonusShares
      || left.rights_shares !== right.rightsShares
      || left.m !== right.m
      || left.c !== right.c
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const [key, row] of existing) {
      if (!incoming.has(key)) remove.run(row.market, row.code, row.date)
    }
    for (const [key, event] of incoming) {
      if (!changed(existing.get(key), event)) continue
      upsert.run(
        event.market, event.code, event.date, event.dividend, event.rightsPrice,
        event.bonusShares, event.rightsShares, event.m, event.c,
      )
    }
    database.prepare(`
      INSERT INTO cache_meta (key, value) VALUES ('gbbq_fingerprint', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(fingerprint)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { refreshed: true, events: events.length }
}
