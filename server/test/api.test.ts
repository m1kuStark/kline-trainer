import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApi } from '../src/api.js'
import { migrateDatabase } from '../src/db.js'
import type { AppConfig } from '../src/config.js'

const encryptedGbbqRecord = Buffer.from('9a7f1ae8eafde7194156de939ea709c237a8c90d0924e4d63f00000000', 'hex')

function dayRecord(date: number, open: number, high: number, low: number, close: number, amount: number, volume: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeInt32LE(date, 0)
  buffer.writeInt32LE(Math.round(open * 100), 4)
  buffer.writeInt32LE(Math.round(high * 100), 8)
  buffer.writeInt32LE(Math.round(low * 100), 12)
  buffer.writeInt32LE(Math.round(close * 100), 16)
  buffer.writeFloatLE(amount, 20)
  buffer.writeInt32LE(volume, 24)
  return buffer
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'tdx-api-'))
  await mkdir(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true })
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
  await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day'), Buffer.concat([
    dayRecord(20020724, 20, 22, 18, 21, 100, 10),
    dayRecord(20020725, 19, 21, 18, 20, 200, 20),
  ]))
  await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh000300.day'), Buffer.concat([
    dayRecord(20260831, 4000, 4100, 3950, 4050, 300, 30),
    dayRecord(20260901, 4050, 4120, 4000, 4100, 400, 40),
  ]))
  const gbbq = Buffer.alloc(4 + encryptedGbbqRecord.length)
  gbbq.writeUInt32LE(1, 0)
  encryptedGbbqRecord.copy(gbbq, 4)
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbq)
  return root
}

async function createApp(root: string) {
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  const app = Fastify()
  const config: AppConfig = { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot: root }
  await registerApi(app, config, database)
  return { app, database }
}

describe('market-data API', () => {
  it('returns forward-adjusted bars by default and raw bars on request', async () => {
    const root = await createFixture()
    const { app, database } = await createApp(root)
    try {
      const adjusted = await app.inject({ method: 'GET', url: '/api/kline/600519?from=2002-07-24&to=2002-07-25' })
      expect(adjusted.statusCode).toBe(200)
      const adjustedBody = adjusted.json()
      expect(adjustedBody.adjustmentMode).toBe('forward')
      expect(adjustedBody.bars[0].open).toBeCloseTo((20 - 0.8) / 1.1, 12)
      expect(adjustedBody.bars[1].open).toBe(19)

      const raw = await app.inject({ method: 'GET', url: '/api/kline/600519?adjust=raw' })
      expect(raw.statusCode).toBe(200)
      expect(raw.json()).toMatchObject({
        symbol: 'sh600519',
        adjustmentMode: 'raw',
        bars: [{ date: '2002-07-24', open: 20 }, { date: '2002-07-25', open: 19 }],
      })
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a benchmark index using its explicit market symbol', async () => {
    const root = await createFixture()
    const { app, database } = await createApp(root)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/kline/sh000300?tf=1W' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        symbol: 'sh000300',
        timeframe: '1W',
        bars: [{ date: '2026-08-31', open: 4000, high: 4120, low: 3950, close: 4100, amount: 700, volume: 70 }],
      })
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed and reversed date ranges with 400 instead of an internal error', async () => {
    const root = await createFixture()
    const { app, database } = await createApp(root)
    try {
      const malformed = await app.inject({ method: 'GET', url: '/api/kline/600519?from=2024-13-99' })
      expect(malformed.statusCode).toBe(400)
      expect(malformed.json().error).toContain('YYYY-MM-DD')

      const reversed = await app.inject({ method: 'GET', url: '/api/kline/600519?from=2024-02-01&to=2024-01-01' })
      expect(reversed.statusCode).toBe(400)
      expect(reversed.json().error).toContain('must not be after')
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports cached catalog and adjustment capabilities in the environment endpoint', async () => {
    const root = await createFixture()
    const { app, database } = await createApp(root)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/env' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        stockCount: 1,
        dataCutoff: '2002-07-25',
        capabilities: { day: true, forwardAdjust: true, benchmark: true, catalogCache: true, training: true },
      })
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refreshes the in-memory catalog after a source day file changes', async () => {
    const root = await createFixture()
    const { app, database } = await createApp(root)
    const file = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
    try {
      const before = await app.inject({ method: 'GET', url: '/api/env' })
      expect(before.json()).toMatchObject({ dataCutoff: '2002-07-25' })

      const original = await import('node:fs/promises').then(({ readFile }) => readFile(file))
      await writeFile(file, Buffer.concat([original, dayRecord(20020726, 21, 23, 20, 22, 250, 25)]))
      const future = new Date(Date.now() + 5_000)
      await utimes(file, future, future)

      const after = await app.inject({ method: 'GET', url: '/api/env' })
      expect(after.json()).toMatchObject({ dataCutoff: '2002-07-26' })
      const stocks = await app.inject({ method: 'GET', url: '/api/stocks?q=600519' })
      expect(stocks.json()).toMatchObject({ items: [{ code: '600519', bars: 3 }] })
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never serves future bars and closes raw kline while a training is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-api-training-'))
    const directory = join(root, 'vipdoc', 'sh', 'lday')
    await mkdir(directory, { recursive: true })
    await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
    // 25 个工作日：2026-07-01 起，收盘 100 + index
    const dates: string[] = []
    const cursor = new Date('2026-07-01T00:00:00Z')
    while (dates.length < 25) {
      const weekday = cursor.getUTCDay()
      if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    await writeFile(join(directory, 'sh600519.day'), Buffer.concat(dates.map((date, index) =>
      dayRecord(Number(date.replaceAll('-', '')), 100 + index, 100 + index, 100 + index, 100 + index, 1_000_000, 100_000),
    )))
    const gbbq = Buffer.alloc(4 + encryptedGbbqRecord.length)
    gbbq.writeUInt32LE(1, 0)
    encryptedGbbqRecord.copy(gbbq, 4)
    await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbq)

    const { app, database } = await createApp(root)
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/trainings',
        payload: { tier: '1M', code: '600519', start_date: '2026-07-01', initial_cash: 1_000_000 },
      })
      expect(created.statusCode).toBe(201)
      const training = created.json().training
      expect(training.currentDate).toBe('2026-07-01')
      expect(training.plannedEnd).toBe('2026-08-01')

      const conflict = await app.inject({
        method: 'POST', url: '/api/trainings',
        payload: { tier: '1M', code: '600519', start_date: '2026-07-01' },
      })
      expect(conflict.statusCode).toBe(409)
      // 业务错误必须保留中文信息，不能被 Fastify 默认错误吞成 "Bad Request"
      expect(conflict.json().error).toBe('已有进行中的训练，请先结算或放弃')

      const badCash = await app.inject({
        method: 'POST', url: '/api/trainings',
        payload: { tier: '1M', code: '600519', start_date: '2026-07-01', initial_cash: 'abc' },
      })
      expect(badCash.statusCode).toBe(400)
      expect(badCash.json().error).toBe('初始资金必须是正数')

      const bought = await app.inject({
        method: 'POST', url: `/api/trainings/${training.id}/trade`,
        payload: { side: 'buy', weightPct: 50 },
      })
      expect(bought.statusCode).toBe(200)
      expect(bought.json().plan).toMatchObject({ side: 'buy', shares: 5_000, amount: 500_000 })

      for (let index = 0; index < 3; index += 1) {
        const advanced = await app.inject({ method: 'POST', url: `/api/trainings/${training.id}/next` })
        expect(advanced.statusCode).toBe(200)
      }
      const current = dates[3]
      const snapshot = await app.inject({ method: 'GET', url: '/api/trainings/active' })
      expect(snapshot.json().training.currentDate).toBe(current)

      for (const tf of ['1D', '1W', '1M']) {
        const bars = await app.inject({ method: 'GET', url: `/api/trainings/${training.id}/bars?tf=${tf}` })
        expect(bars.statusCode).toBe(200)
        const payload = bars.json()
        for (const bar of payload.bars) {
          expect(bar.date <= current).toBe(true)
        }
        expect(payload.bars.at(-1).date <= current).toBe(true)
      }

      // 训练进行中：原始行情接口关闭，前端拿不到任何全量数据
      const blocked = await app.inject({ method: 'GET', url: '/api/kline/600519?adjust=raw' })
      expect(blocked.statusCode).toBe(409)

      const settled = await app.inject({ method: 'POST', url: `/api/trainings/${training.id}/settle` })
      expect(settled.statusCode).toBe(200)
      expect(settled.json().training).toMatchObject({ status: 'settled', earlySettle: true, settleDate: current })

      // 结算后原始行情恢复（复盘数据在 M4 的 replay 接口收口）
      const reopened = await app.inject({ method: 'GET', url: '/api/kline/600519?adjust=raw' })
      expect(reopened.statusCode).toBe(200)

      const tradeAfterSettle = await app.inject({
        method: 'POST', url: `/api/trainings/${training.id}/trade`,
        payload: { side: 'buy', weightPct: 10 },
      })
      expect(tradeAfterSettle.statusCode).toBe(409)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
