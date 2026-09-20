import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function weekdayDates(startDate: string, count: number): string[] {
  const dates: string[] = []
  const cursor = new Date(`${startDate}T00:00:00Z`)
  while (dates.length < count) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

async function createFixture(): Promise<{ root: string; dates: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'tdx-full-acceptance-'))
  const directory = join(root, 'vipdoc', 'sh', 'lday')
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
  const dates = weekdayDates('2026-07-01', 45)
  await writeFile(join(directory, 'sh600000.day'), Buffer.concat(dates.map((date, index) => dayRecord(
    Number(date.replaceAll('-', '')),
    10 + index * 0.1 - 0.05,
    10 + index * 0.1 + 0.1,
    10 + index * 0.1 - 0.1,
    10 + index * 0.1,
    (10 + index * 0.1) * 1_000_000,
    1_000_000,
  ))))
  const gbbq = Buffer.alloc(4 + encryptedGbbqRecord.length)
  gbbq.writeUInt32LE(1, 0)
  encryptedGbbqRecord.copy(gbbq, 4)
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbq)
  return { root, dates }
}

async function withApp(run: (context: { app: Fastify.FastifyInstance; database: DatabaseSync; config: AppConfig; dates: string[] }) => Promise<void>): Promise<void> {
  const { root, dates } = await createFixture()
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  const app = Fastify()
  const config: AppConfig = { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot: root }
  await registerApi(app, config, database)
  try {
    await run({ app, database, config, dates })
  } finally {
    await app.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('full acceptance matrix', () => {
  it('M1 exposes the data contract: catalog, raw/forward bars, periods, benchmark, and validation errors', async () => {
    await withApp(async ({ app }) => {
      const env = await app.inject({ method: 'GET', url: '/api/env' })
      expect(env.statusCode).toBe(200)
      expect(env.json()).toMatchObject({
        status: 'ok',
        stockCount: 1,
        capabilities: { day: true, forwardAdjust: true, benchmark: true, training: true },
      })

      const stocks = await app.inject({ method: 'GET', url: '/api/stocks?q=600000' })
      expect(stocks.statusCode).toBe(200)
      expect(stocks.json().items).toHaveLength(1)

      const raw = await app.inject({ method: 'GET', url: '/api/kline/600000?adjust=raw&from=2026-07-01&to=2026-07-03' })
      expect(raw.statusCode).toBe(200)
      expect(raw.json()).toMatchObject({ adjustmentMode: 'raw', timeframe: '1D' })
      expect(raw.json().bars[0]).toMatchObject({ date: '2026-07-01', close: 10 })

      const weekly = await app.inject({ method: 'GET', url: '/api/kline/600000?adjust=raw&tf=1W' })
      expect(weekly.statusCode).toBe(200)
      expect(weekly.json().bars.length).toBeGreaterThan(0)
      expect(weekly.json().bars[0]).toHaveProperty('amount')

      const malformed = await app.inject({ method: 'GET', url: '/api/kline/600000?from=2026-99-99' })
      expect(malformed.statusCode).toBe(400)
      expect(malformed.json().error).toContain('YYYY-MM-DD')

      const benchmark = await app.inject({ method: 'GET', url: '/api/kline/sh000300?adjust=raw' })
      expect(benchmark.statusCode).toBe(404)
    })
  })

  it('M2 completes a user training loop with blind masking, trade rules, no-future bars, and both endings', async () => {
    await withApp(async ({ app, dates }) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/trainings',
        payload: { tier: '1M', code: '600000', start_date: '2026-07-04', initial_cash: 1_000_000, blind: true },
      })
      expect(created.statusCode).toBe(201)
      const id = created.json().training.id
      expect(created.json().training).toMatchObject({ blind: true, code: null, name: null, currentDate: null })
      const runningSnapshot = await app.inject({ method: 'GET', url: `/api/trainings/${id}` })
      expect(runningSnapshot.statusCode).toBe(200)
      expect(runningSnapshot.json().training).toMatchObject({ id, status: 'running', blind: true, code: null, name: null, currentDate: null })
      expect(runningSnapshot.json().account.equity).toBe(1_000_000)
      expect(runningSnapshot.json().bars).toBeUndefined()
      for (const invalidId of ['bad', '1.5', '0', '-1', '9007199254740992']) {
        expect((await app.inject({ method: 'GET', url: `/api/trainings/${invalidId}` })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'GET', url: '/api/trainings/9876' })).statusCode).toBe(404)

      const conflict = await app.inject({
        method: 'POST', url: '/api/trainings',
        payload: { tier: '1M', code: '600000', start_date: dates[0] },
      })
      expect(conflict.statusCode).toBe(409)

      const buy = await app.inject({ method: 'POST', url: `/api/trainings/${id}/trade`, payload: { side: 'buy', weightPct: 50 } })
      expect(buy.statusCode).toBe(200)
      expect(buy.json().plan.shares).toBe(Math.floor(500_000 / 10.2 / 100) * 100)
      expect(buy.json().snapshot.trades[0]).toMatchObject({ blindIndex: 0, blindLabel: '今日' })

      const sameDaySell = await app.inject({ method: 'POST', url: `/api/trainings/${id}/trade`, payload: { side: 'sell', weightPct: 100 } })
      expect(sameDaySell.statusCode).toBe(400)
      expect(sameDaySell.json().error).toContain('没有可卖持仓')

      const advanced = await app.inject({ method: 'POST', url: `/api/trainings/${id}/next` })
      expect(advanced.statusCode).toBe(200)
      expect(advanced.json().snapshot.training.currentDate).toBeNull()
      const bars = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=1D` })
      expect(bars.statusCode).toBe(200)
      expect(bars.json().bars.at(-1).date).toBe(dates[3])

      const sell = await app.inject({ method: 'POST', url: `/api/trainings/${id}/trade`, payload: { side: 'sell', shares: 25_000 } })
      expect(sell.statusCode).toBe(200)
      expect(sell.json().snapshot.account.shares).toBe(buy.json().plan.shares - 25_000)
      expect(sell.json().snapshot.account.costPrice).toBeCloseTo(10.2, 8)

      for (const timeframe of ['1D', '1W', '1M']) {
        const response = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=${timeframe}` })
        expect(response.statusCode).toBe(200)
        expect(response.json().bars.every((bar: { date: string }) => bar.date <= dates[3])).toBe(true)
      }

      const drawings = [{
        id: 'acceptance-line', name: 'segment', paneId: 'candle_pane',
        points: [{ timestamp: Date.parse(`${dates[2]}T00:00:00Z`), value: 10.2 }, { timestamp: Date.parse(`${dates[3]}T00:00:00Z`), value: 10.3 }],
        styles: { line: { color: '#facc15', size: 1, style: 'dashed', dashedValue: [4, 4] } },
      }]
      const drawingsPut = await app.inject({ method: 'PUT', url: `/api/trainings/${id}/drawings`, payload: drawings })
      expect(drawingsPut.statusCode).toBe(200)
      expect(drawingsPut.json()).toEqual({ drawings })
      const drawingsGet = await app.inject({ method: 'GET', url: `/api/trainings/${id}/drawings` })
      expect(drawingsGet.statusCode).toBe(200)
      expect(drawingsGet.json()).toEqual({ drawings })
      expect(bars.json().drawings).toBeUndefined()

      // 动态历史加载：before/count 分批取更早历史 + 参数校验
      const earliest = bars.json().bars[0].date
      const chunk = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=1D&before=${earliest}&count=5` })
      expect(chunk.statusCode).toBe(200)
      expect(chunk.json().bars).toEqual([])
      expect(chunk.json().hasMore).toBe(false)
      const last = bars.json().bars.at(-1).date
      const chunk2 = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=1D&before=${last}&count=5` })
      expect(chunk2.statusCode).toBe(200)
      expect(chunk2.json().bars.length).toBeGreaterThan(0)
      expect(chunk2.json().bars.every((bar: { date: string }) => bar.date < last)).toBe(true)
      const badCount = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=1D&before=${last}&count=0` })
      expect(badCount.statusCode).toBe(400)
      const badBefore = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=1D&before=bad-date` })
      expect(badBefore.statusCode).toBe(400)

      const rawDuringTraining = await app.inject({ method: 'GET', url: '/api/kline/600000?adjust=raw' })
      expect(rawDuringTraining.statusCode).toBe(409)

      const settled = await app.inject({ method: 'POST', url: `/api/trainings/${id}/settle` })
      expect(settled.statusCode).toBe(200)
      expect(settled.json().training).toMatchObject({ status: 'settled', earlySettle: true, code: '600000', name: '600000' })
      expect(settled.json().trades[0].blindLabel).toBeUndefined()
      expect((await app.inject({ method: 'GET', url: `/api/trainings/${id}/drawings` })).json()).toEqual({ drawings })
      const settledSnapshot = await app.inject({ method: 'GET', url: `/api/trainings/${id}` })
      expect(settledSnapshot.statusCode).toBe(200)
      expect(settledSnapshot.json().training).toEqual(settled.json().training)
      expect(settledSnapshot.json().account).toEqual(settled.json().account)
      const settledBars = await app.inject({ method: 'GET', url: `/api/trainings/${id}/bars?tf=1D` })
      expect(settledBars.json().bars.at(-1).date).toBe(dates[3])
      expect((await app.inject({ method: 'GET', url: '/api/trainings/active' })).json()).toEqual({ training: null })

      const reopened = await app.inject({ method: 'GET', url: '/api/kline/600000?adjust=raw' })
      expect(reopened.statusCode).toBe(200)

      const second = await app.inject({ method: 'POST', url: '/api/trainings', payload: { tier: '1M', code: '600000', start_date: dates[5] } })
      expect(second.statusCode).toBe(201)
      expect((await app.inject({ method: 'GET', url: `/api/trainings/${id}` })).json().training.id).toBe(id)
      expect((await app.inject({ method: 'GET', url: '/api/trainings/active' })).json().training.id).toBe(second.json().training.id)
      const abandoned = await app.inject({ method: 'POST', url: `/api/trainings/${second.json().training.id}/abandon` })
      expect(abandoned.statusCode).toBe(200)
      expect(abandoned.json().training.status).toBe('abandoned')
    })
  })

  it('M4 and M5 are explicitly not open yet instead of silently pretending to be complete', async () => {
    await withApp(async ({ app }) => {
      expect((await app.inject({ method: 'GET', url: '/api/rankings?tier=1M' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(404)
    })
  })
})
