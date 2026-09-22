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

/**
 * 权息缓存刷新的两段式结构：scan 只读（stat＋gbbq 解码＋差异计算，不写库），
 * apply 同步执行全部写入（调用方必须已开启事务）。整批发布（DATA-01）
 * 由协调器把 apply 与目录、快照放在同一事务内一次性提交。
 */
export interface AdjustmentChanges {
  /** false＝gbbq 指纹未变化，无需任何写入 */
  changed: boolean
  fingerprint: string
  deletes: AdjustmentRow[]
  upserts: AdjustmentEvent[]
  /** 来源事件总数（作为 events 计数口径） */
  events: number
}

/** 只读扫描：比对 gbbq 指纹与现有缓存，产出待写入变更；绝不写库。 */
export async function scanAdjustmentChanges(
  database: DatabaseSync,
  tdxRoot: string,
): Promise<AdjustmentChanges> {
  const filePath = join(tdxRoot, 'T0002', 'hq_cache', 'gbbq')
  const info = await stat(filePath)
  const fingerprint = `${info.size}:${info.mtime.toISOString()}`
  const cached = database.prepare("SELECT value FROM cache_meta WHERE key = 'gbbq_fingerprint'").get() as unknown as { value: string } | undefined
  if (cached?.value === fingerprint) {
    const count = database.prepare('SELECT COUNT(*) AS count FROM adj_factors').get() as unknown as { count: number }
    return { changed: false, fingerprint, deletes: [], upserts: [], events: count.count }
  }

  const events = await readGbbqFile(filePath)
  const existingRows = database.prepare(`
    SELECT market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
    FROM adj_factors
  `).all() as unknown as AdjustmentRow[]
  const existing = new Map(existingRows.map(row => [`${row.market}:${row.code}:${row.date}`, row]))
  const incoming = new Map(events.map(event => [`${event.market}:${event.code}:${event.date}`, event]))
  const changed = (left: AdjustmentRow | undefined, right: AdjustmentEvent): boolean => {
    if (!left) return true
    return left.dividend !== right.dividend
      || left.rights_price !== right.rightsPrice
      || left.bonus_shares !== right.bonusShares
      || left.rights_shares !== right.rightsShares
      || left.m !== right.m
      || left.c !== right.c
  }
  const deletes: AdjustmentRow[] = []
  for (const [key, row] of existing) {
    if (!incoming.has(key)) deletes.push(row)
  }
  const upserts: AdjustmentEvent[] = []
  for (const [key, event] of incoming) {
    if (!changed(existing.get(key), event)) continue
    upserts.push(event)
  }
  return { changed: true, fingerprint, deletes, upserts, events: events.length }
}

/** 应用阶段：执行全部权息写入与指纹更新。调用方必须已开启事务；同步执行，异常由调用方回滚。 */
export function applyAdjustmentChanges(database: DatabaseSync, changes: AdjustmentChanges): void {
  if (!changes.changed) return
  const remove = database.prepare('DELETE FROM adj_factors WHERE market = ? AND code = ? AND date = ?')
  for (const row of changes.deletes) {
    remove.run(row.market, row.code, row.date)
  }
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
  for (const event of changes.upserts) {
    upsert.run(
      event.market, event.code, event.date, event.dividend, event.rightsPrice,
      event.bonusShares, event.rightsShares, event.m, event.c,
    )
  }
  database.prepare(`
    INSERT INTO cache_meta (key, value) VALUES ('gbbq_fingerprint', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(changes.fingerprint)
}

export async function refreshAdjustmentCache(
  database: DatabaseSync,
  tdxRoot: string,
): Promise<{ refreshed: boolean; events: number }> {
  const changes = await scanAdjustmentChanges(database, tdxRoot)
  database.exec('BEGIN IMMEDIATE')
  try {
    applyAdjustmentChanges(database, changes)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { refreshed: changes.changed, events: changes.events }
}
