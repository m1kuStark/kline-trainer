import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(filePath: string): DatabaseSync {
  return new DatabaseSync(filePath)
}

export function migrateDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stocks (
      code TEXT PRIMARY KEY, market TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'A', bars INTEGER NOT NULL DEFAULT 0,
      mtime TEXT NOT NULL, last_date TEXT
    );
    CREATE TABLE IF NOT EXISTS adj_factors (
      market TEXT NOT NULL, code TEXT NOT NULL, date TEXT NOT NULL,
      dividend REAL NOT NULL, rights_price REAL NOT NULL,
      bonus_shares REAL NOT NULL, rights_shares REAL NOT NULL,
      m REAL NOT NULL, c REAL NOT NULL,
      PRIMARY KEY (market, code, date)
    );
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trainings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tier TEXT NOT NULL, code TEXT NOT NULL,
      name TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'sh', start_date TEXT NOT NULL,
      planned_end TEXT NOT NULL, status TEXT NOT NULL, blind INTEGER NOT NULL DEFAULT 0,
      adjust_mode TEXT NOT NULL DEFAULT 'forward', initial_cash REAL NOT NULL,
      created_at TEXT NOT NULL, current_date TEXT, current_close REAL,
      settle_date TEXT, early_settle INTEGER NOT NULL DEFAULT 0, note TEXT
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, training_id INTEGER NOT NULL,
      seq INTEGER NOT NULL, trade_date TEXT NOT NULL, side TEXT NOT NULL,
      price REAL NOT NULL, shares INTEGER NOT NULL, amount REAL NOT NULL,
      fee REAL NOT NULL, cash_after REAL NOT NULL, shares_after INTEGER NOT NULL,
      cost_after REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS equity_curve (
      training_id INTEGER NOT NULL, date TEXT NOT NULL, equity REAL NOT NULL,
      PRIMARY KEY (training_id, date)
    );
    CREATE TABLE IF NOT EXISTS position_events (
      training_id INTEGER NOT NULL, seq INTEGER NOT NULL, date TEXT NOT NULL,
      kind TEXT NOT NULL, shares_delta REAL NOT NULL, cash_delta REAL NOT NULL, cost_delta REAL,
      PRIMARY KEY (training_id, seq)
    );
    CREATE TABLE IF NOT EXISTS drawings (
      training_id INTEGER PRIMARY KEY REFERENCES trainings(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_file_state (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
      max_date TEXT, rows INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS data_refresh_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, finished_at TEXT NOT NULL, outcome TEXT NOT NULL,
      added INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, revised INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT NOT NULL, source_max_date TEXT, message TEXT NOT NULL DEFAULT ''
    );
  `)
  addColumnIfMissing(database, 'trainings', 'market', "TEXT NOT NULL DEFAULT 'sh'")
  addColumnIfMissing(database, 'trainings', 'current_date', 'TEXT')
  addColumnIfMissing(database, 'trainings', 'current_close', 'REAL')
  addColumnIfMissing(database, 'trainings', 'settle_date', 'TEXT')
  addColumnIfMissing(database, 'trainings', 'early_settle', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(database, 'trainings', 'note', 'TEXT')
  // NULL distinguishes legacy events from an explicitly booked zero acquisition cost.
  addColumnIfMissing(database, 'position_events', 'cost_delta', 'REAL')
  // Early drawing tables have no save timestamp; keep it unknown until the next write.
  addColumnIfMissing(database, 'drawings', 'updated_at', "TEXT NOT NULL DEFAULT ''")
}

function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (columns.some(entry => entry.name === column)) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export async function ensureDatabaseDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}
