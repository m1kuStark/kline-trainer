import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerApi } from '../src/api.js'
import { migrateDatabase } from '../src/db.js'
import type { AppConfig } from '../src/config.js'
import { drawingPriceBasis } from '../src/train/drawing-price-basis.js'

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  return database
}

function insertTraining(
  database: DatabaseSync,
  options: { adjustMode?: 'forward' | 'raw'; startDate?: string; currentDate?: string | null; blind?: boolean; code?: string } = {},
): number {
  return Number(database.prepare(`
    INSERT INTO trainings (tier, code, name, market, start_date, planned_end, status, blind, adjust_mode, initial_cash, created_at, current_date, current_close)
    VALUES ('6M', ?, ?, 'sh', ?, '2025-12-31', 'running', ?, ?, 100000, '2025-06-01T00:00:00Z', ?, 4.81)
  `).run(
    options.code ?? '603980',
    options.code ?? '603980',
    options.startDate ?? '2025-06-01',
    options.blind ? 1 : 0,
    options.adjustMode ?? 'forward',
    options.currentDate === undefined ? '2025-06-20' : options.currentDate,
  ).lastInsertRowid)
}

// 权息事件直接写入缓存表（与 refreshAdjustmentCache 相同的 m/c 口径），参数绑定，不走二进制 gbbq。
function insertEvent(database: DatabaseSync, date: string, m: number, c: number, code = '603980'): void {
  database.prepare(`
    INSERT INTO adj_factors (market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c)
    VALUES ('sh', ?, ?, 0, 0, 0, 0, ?, ?)
  `).run(code, date, m, c)
}

describe('training drawing price basis', () => {
  it('maps the 603980 dividend basis so historic 4.81 reprojects to 4.74 after the advance', () => {
    const database = openDatabase()
    try {
      insertEvent(database, '2025-06-17', 1, 0.07)
      const after = insertTraining(database, { currentDate: '2025-06-20' })
      expect(drawingPriceBasis(database, after)).toEqual({ scale: 1, offset: -0.07 })
      // 固定合同变换：(value - old.offset) / old.scale * new.scale + new.offset，画线随K线从 4.81 移到 4.74。
      const projected = (4.81 - 0) / 1 * drawingPriceBasis(database, after).scale + drawingPriceBasis(database, after).offset
      expect(projected).toBeCloseTo(4.74, 12)
      const before = insertTraining(database, { currentDate: '2025-06-10' })
      expect(drawingPriceBasis(database, before)).toEqual({ scale: 1, offset: 0 })
    } finally {
      database.close()
    }
  })

  it('combines dividend, bonus and rights into one affine transform instead of a pure ratio', () => {
    const database = openDatabase()
    try {
      // 10送5配2配股价6派3：m=(10+5+2)/10=1.7，c=(3-6*2)/10=-0.9；累计段 scale=1/1.7，offset=+0.9/1.7。
      insertEvent(database, '2025-06-17', 1.7, -0.9)
      const id = insertTraining(database)
      const basis = drawingPriceBasis(database, id)
      expect(basis.scale).toBeCloseTo(1 / 1.7, 15)
      expect(basis.offset).toBeCloseTo(0.9 / 1.7, 15)
      const projected = (4.81 - 0) / 1 * basis.scale + basis.offset
      expect(projected).toBeCloseTo((4.81 + 0.9) / 1.7, 12)
      expect(Math.abs(projected - 4.81 / 1.7)).toBeGreaterThan(0.5)
    } finally {
      database.close()
    }
  })

  it('accumulates multiple occurred events and never includes future ones', () => {
    const database = openDatabase()
    try {
      insertEvent(database, '2025-03-10', 2, 0.1)
      insertEvent(database, '2025-06-17', 1, 0.07)
      insertEvent(database, '2026-01-05', 1.2, 0.3)
      const advanced = insertTraining(database, { currentDate: '2025-06-20' })
      // 最老累计段：e2(06-17) 后 a=1,b=-0.07；再过 e1(03-10) a=1/2,b=-0.07-0.05=-0.12；2026 事件未发生。
      const basis2025 = drawingPriceBasis(database, advanced)
      expect(basis2025.scale).toBeCloseTo(0.5, 15)
      expect(basis2025.offset).toBeCloseTo(-0.12, 15)
      const early = insertTraining(database, { currentDate: '2025-03-05' })
      expect(drawingPriceBasis(database, early)).toEqual({ scale: 1, offset: 0 })
      const all = insertTraining(database, { currentDate: '2026-06-20' })
      const basis = drawingPriceBasis(database, all)
      expect(basis.scale).toBeCloseTo(1 / 2.4, 15)
      expect(basis.offset).toBeCloseTo(-0.35, 15)
    } finally {
      database.close()
    }
  })

  it('keeps raw mode and eventless trainings at identity', () => {
    const database = openDatabase()
    try {
      insertEvent(database, '2025-06-17', 1, 0.07)
      const raw = insertTraining(database, { adjustMode: 'raw' })
      expect(drawingPriceBasis(database, raw)).toEqual({ scale: 1, offset: 0 })
      // 独立 code 无任何权息事件：forward 模式同样保持恒等基准。
      const clean = insertTraining(database, { code: '600000' })
      expect(drawingPriceBasis(database, clean)).toEqual({ scale: 1, offset: 0 })
    } finally {
      database.close()
    }
  })

  it('rejects invalid and missing training ids', () => {
    const database = openDatabase()
    try {
      const id = insertTraining(database)
      expect(() => drawingPriceBasis(database, 0)).toThrow()
      expect(() => drawingPriceBasis(database, 1.5)).toThrow()
      expect(() => drawingPriceBasis(database, 9876)).toThrow(/Training not found/)
      expect(drawingPriceBasis(database, id)).toEqual({ scale: 1, offset: 0 })
    } finally {
      database.close()
    }
  })
})

function dayRecord(date: number, open: number, close: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeInt32LE(date, 0)
  buffer.writeInt32LE(Math.round(open * 100), 4)
  buffer.writeInt32LE(Math.round(close * 100), 8)
  buffer.writeInt32LE(Math.round(close * 100), 12)
  buffer.writeInt32LE(Math.round(close * 100), 16)
  buffer.writeFloatLE(1000, 20)
  buffer.writeInt32LE(100, 24)
  return buffer
}

async function createBarsFixture(): Promise<{ root: string; id: number; database: DatabaseSync; app: ReturnType<typeof Fastify>; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'tdx-drawing-basis-'))
  await mkdir(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true })
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
  await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh603980.day'), Buffer.concat([
    dayRecord(20250616, 4.8, 4.81),
    dayRecord(20250617, 4.74, 4.74),
    dayRecord(20250618, 4.75, 4.76),
    dayRecord(20250619, 4.76, 4.77),
    dayRecord(20250620, 4.77, 4.78),
  ]))
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), Buffer.alloc(4))
  const database = openDatabase()
  const app = Fastify()
  const config: AppConfig = { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot: root }
  await registerApi(app, config, database)
  // 预置缓存指纹＝gbbq 文件当前状态：/bars 的 ensureAdjustmentCache 命中后不再按 0 事件文件清空直插的权息行。
  const gbbqInfo = await stat(join(root, 'T0002', 'hq_cache', 'gbbq'))
  database.prepare("INSERT INTO cache_meta (key, value) VALUES ('gbbq_fingerprint', ?)")
    .run(`${gbbqInfo.size}:${gbbqInfo.mtime.toISOString()}`)
  const id = insertTraining(database, { startDate: '2025-06-16', currentDate: '2025-06-20', blind: true })
  insertEvent(database, '2025-06-17', 1, 0.07)
  return {
    root, id, database, app,
    close: async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }) },
  }
}

describe('bars payload drawing price basis', () => {
  it('returns the drawing basis with bars and keeps the blind advance date masked', async () => {
    const context = await createBarsFixture()
    try {
      const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${context.id}/bars` })
      expect(response.statusCode).toBe(200)
      const payload = response.json()
      expect(payload.drawingPriceBasis).toEqual({ scale: 1, offset: -0.07 })
      // 双盲进行中不暴露推进日期，但权息累计基准仍随 bars 可用。
      expect(payload.training.currentDate).toBeNull()
      expect(payload.bars.at(-1).close).toBeCloseTo(4.78, 12)
      expect(payload.bars[0].close).toBeCloseTo(4.74, 12)
    } finally {
      await context.close()
    }
  })

  it('returns the same drawing basis for earlier-history chunk requests', async () => {
    const context = await createBarsFixture()
    try {
      const chunk = await context.app.inject({ method: 'GET', url: `/api/trainings/${context.id}/bars?before=2025-06-18&count=10` })
      expect(chunk.statusCode).toBe(200)
      expect(chunk.json().drawingPriceBasis).toEqual({ scale: 1, offset: -0.07 })
    } finally {
      await context.close()
    }
  })
})
