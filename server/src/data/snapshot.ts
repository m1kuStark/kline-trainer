// 快照持久化：data_file_state（上次成功扫描的文件状态基线）与 data_refresh_log（追加式刷新日志）。
// 只在扫描与权息全部成功后由协调器在整批事务内一次性提交（含批次标识）；失败路径仅追加失败日志，
// 绝不清空旧快照。整批语义见 docs/publication.md 与 DATA-01。

import type { DatabaseSync } from 'node:sqlite'
import type { ScanBaseline, ScanOutcome } from './source.js'

export type RefreshOutcome = 'unchanged' | 'updated' | 'failed'

export interface RefreshLogEntry {
  finishedAt: string
  outcome: RefreshOutcome
  added: number
  removed: number
  revised: number
  sourceKind: string
  sourceMaxDate: string | null
  message: string
}

interface LogRowRaw {
  finished_at: string
  outcome: string
  added: number
  removed: number
  revised: number
  source_kind: string
  source_max_date: string | null
  message: string
}

function rowToEntry(row: LogRowRaw): RefreshLogEntry {
  return {
    finishedAt: row.finished_at,
    outcome: row.outcome as RefreshOutcome,
    added: row.added,
    removed: row.removed,
    revised: row.revised,
    sourceKind: row.source_kind,
    sourceMaxDate: row.source_max_date,
    message: row.message,
  }
}

export function loadScanBaseline(database: DatabaseSync): ScanBaseline {
  const rows = database.prepare('SELECT path, size, mtime_ms, max_date, "rows" FROM data_file_state').all() as unknown as
    Array<{ path: string; size: number; mtime_ms: number; max_date: string | null; rows: number }>
  const baseline: ScanBaseline = new Map()
  for (const row of rows) {
    baseline.set(row.path, { path: row.path, size: row.size, mtimeMs: row.mtime_ms, maxDate: row.max_date, rows: row.rows })
  }
  return baseline
}

/**
 * 整批发布版本标识（DATA-01）：目录、权息、文件状态三个域指向同一批次。
 * 只允许在整批事务内调用；三键同事务写入，读取方据"三键存在且相等"判定最后一批完整生效。
 */
export function publishBatchVersion(database: DatabaseSync, batchId: string): void {
  const upsert = database.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const key of ['catalog_batch', 'adjustment_batch', 'snapshot_batch']) {
    upsert.run(key, batchId)
  }
}

/**
 * 成功路径的应用阶段（无事务边界）：全量替换文件快照 + 追加成功日志 + 保留最近 50 条。
 * 调用方必须已开启事务；同步执行，异常由调用方回滚。
 */
export function applyScanResult(database: DatabaseSync, outcome: ScanOutcome, entry: RefreshLogEntry): void {
  database.exec('DELETE FROM data_file_state')
  const insert = database.prepare('INSERT INTO data_file_state (path, size, mtime_ms, max_date, "rows") VALUES (?, ?, ?, ?, ?)')
  for (const file of outcome.files) {
    insert.run(file.path, file.size, file.mtimeMs, file.maxDate, file.rows)
  }
  insertLogEntry(database, entry)
  database.exec('DELETE FROM data_refresh_log WHERE id NOT IN (SELECT id FROM data_refresh_log ORDER BY id DESC LIMIT 50)')
}

/** 失败路径：只追加失败日志，不动快照（旧缓存与基线原样保留）。 */
export function appendFailureLog(database: DatabaseSync, entry: RefreshLogEntry): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    insertLogEntry(database, entry)
    database.exec('DELETE FROM data_refresh_log WHERE id NOT IN (SELECT id FROM data_refresh_log ORDER BY id DESC LIMIT 50)')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function insertLogEntry(database: DatabaseSync, entry: RefreshLogEntry): void {
  database.prepare(`
    INSERT INTO data_refresh_log (finished_at, outcome, added, removed, revised, source_kind, source_max_date, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.finishedAt, entry.outcome, entry.added, entry.removed, entry.revised, entry.sourceKind, entry.sourceMaxDate, entry.message)
}

/** 最近一次尝试（含失败）与最近一次成功（用于 sourceMaxDate / revisionWarning 口径）。 */
export function loadRefreshLog(database: DatabaseSync): { last: RefreshLogEntry | null; lastSuccess: RefreshLogEntry | null } {
  const last = database.prepare(`
    SELECT finished_at, outcome, added, removed, revised, source_kind, source_max_date, message
    FROM data_refresh_log ORDER BY id DESC LIMIT 1
  `).all() as unknown as LogRowRaw[]
  const lastSuccess = database.prepare(`
    SELECT finished_at, outcome, added, removed, revised, source_kind, source_max_date, message
    FROM data_refresh_log WHERE outcome != 'failed' ORDER BY id DESC LIMIT 1
  `).all() as unknown as LogRowRaw[]
  return {
    last: last[0] ? rowToEntry(last[0]) : null,
    lastSuccess: lastSuccess[0] ? rowToEntry(lastSuccess[0]) : null,
  }
}
