import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase } from '../src/db.js'
import type { AppConfig } from '../src/config.js'
import {
  HttpError, abandonTraining, addMonths, advanceTraining, applyPositionEvents, buildChartSpace, createTraining,
  equityCurveOf, settleTraining, tradeTraining, trainingBars, trainingBarsBefore, trainingSnapshot,
} from '../src/train/engine.js'
import type { AccountState } from '../src/train/account.js'

// Synthetic encrypted record: fictional dividend8 per10 shares, bonus1; full decoder path.
const encryptedGbbqRecord = Buffer.from('9a7f1ae8eafde7194156de939ea709c237a8c90d0924e4d63f00000000', 'hex')

function dayRecord(date: number, open: number, close: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeInt32LE(date, 0)
  buffer.writeInt32LE(Math.round(open * 100), 4)
  buffer.writeInt32LE(Math.round(close * 100) + 10, 8)
  buffer.writeInt32LE(Math.round(close * 100) - 10, 12)
  buffer.writeInt32LE(Math.round(close * 100), 16)
  buffer.writeFloatLE(close * 1_000_000, 20)
  buffer.writeInt32LE(1_000_000, 24)
  return buffer
}

// 生成自 startDate 起的 N 个工作日，收盘价 10 + index×0.1（确定性的手工可算序列）
function weekdayDates(startDate: string, count: number): string[] {
  const dates: string[] = []
  const cursor = new Date(`${startDate}T00:00:00Z`)
  while (dates.length < count) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

async function createFixture(): Promise<{ root: string; dates: string[]; closes: number[] }> {
  const root = await mkdtemp(join(tmpdir(), 'tdx-train-'))
  const directory = join(root, 'vipdoc', 'sh', 'lday')
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
  const dates = weekdayDates('2026-07-01', 32)
  const records = dates.map((date, index) => dayRecord(
    Number(date.replaceAll('-', '')),
    10 + index * 0.1 - 0.05,
    10 + index * 0.1,
  ))
  await writeFile(join(directory, 'sh600000.day'), Buffer.concat(records))
  const gbbq = Buffer.alloc(4 + encryptedGbbqRecord.length)
  gbbq.writeUInt32LE(1, 0)
  encryptedGbbqRecord.copy(gbbq, 4)
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbq)
  return { root, dates, closes: dates.map((_, index) => 10 + index * 0.1) }
}

function createAppConfig(root: string): AppConfig {
  return { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot: root }
}

async function withFixture(run: (context: { database: DatabaseSync; config: AppConfig; dates: string[]; closes: number[] }) => Promise<void>): Promise<void> {
  const { root, dates, closes } = await createFixture()
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  const config = createAppConfig(root)
  try {
    await run({ database, config, dates, closes })
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}

// 自定义数据尾夹具：按给定末日写一只或多只股票的日线（用于构造"数据未更新到位/停牌"等场景）
async function createCustomFixture(stocks: Array<{ file: string; dates: string[] }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tdx-train-tail-'))
  await mkdir(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true })
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
  for (const stock of stocks) {
    const records = stock.dates.map((date, index) => dayRecord(
      Number(date.replaceAll('-', '')),
      10 + index * 0.1 - 0.05,
      10 + index * 0.1,
    ))
    await writeFile(join(root, 'vipdoc', 'sh', 'lday', stock.file), Buffer.concat(records))
  }
  const gbbq = Buffer.alloc(4 + encryptedGbbqRecord.length)
  gbbq.writeUInt32LE(1, 0)
  encryptedGbbqRecord.copy(gbbq, 4)
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbq)
  return root
}

async function withCustomFixture(
  stocks: Array<{ file: string; dates: string[] }>,
  run: (context: { database: DatabaseSync; config: AppConfig }) => Promise<void>,
): Promise<void> {
  const root = await createCustomFixture(stocks)
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  const config = createAppConfig(root)
  try {
    await run({ database, config })
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('training engine', () => {
  it('clamps month ends when computing planned_end', () => {
    expect(addMonths('2026-07-06', 1)).toBe('2026-08-06')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 24)).toBe('2026-01-31')
    expect(addMonths('2026-07-06', 6)).toBe('2027-01-06')
  })

  it('creates one training at a time and anchors the start on a trading day', async () => {
    await withFixture(async ({ database, config, dates }) => {
      // 2026-07-04 是周六：起始日应锚定到 2026-07-03（上一个交易日）
      const training = await createTraining(database, config, {
        tier: '3M', code: '600000', start_date: '2026-07-04', initial_cash: 1_000_000,
      })
      expect(training.status).toBe('running')
      expect(training.startDate).toBe(dates[2])
      expect(training.currentDate).toBe(dates[2])
      expect(training.plannedEnd).toBe(addMonths(dates[2], 3))
      expect(training.code).toBe('600000')

      await expect(createTraining(database, config, {
        tier: '1M', code: '600000', start_date: '2026-07-06',
      })).rejects.toThrow(new HttpError(409, '已有进行中的训练，请先结算或放弃'))

      await expect(createTraining(database, config, {
        tier: '2W', code: '600000', start_date: '2026-07-06',
      })).rejects.toThrow(new HttpError(400, '训练周期必须是 1M / 3M / 6M / 1Y / 2Y 之一'))
    })
  })

  it('hides code and name for blind trainings', async () => {
    await withFixture(async ({ database, config }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: '2026-07-01', blind: true,
      })
      expect(training.blind).toBe(true)
      expect(training.code).toBeNull()
      expect(training.name).toBeNull()
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.code).toBeNull()
      expect(snapshot.training.name).toBeNull()
    })
  })

  it('matches the hand-computed buy, advance, and equity curve', async () => {
    await withFixture(async ({ database, config, dates, closes }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0], initial_cash: 1_000_000,
      })
      // 手算：day0 收盘 10.0，买 50% → 50,000 股 × 10.0 = 500,000，余现金 500,000
      const bought = await tradeTraining(database, training.id, { side: 'buy', weightPct: 50 })
      expect(bought.plan.shares).toBe(50_000)
      expect(bought.snapshot.account.cash).toBeCloseTo(500_000, 10)
      expect(bought.snapshot.account.costPrice).toBeCloseTo(10, 10)

      // T+1：当日买入不可卖（可卖数量为 0）
      await expect(tradeTraining(database, training.id, { side: 'sell', weightPct: 100 }))
        .rejects.toThrow(/没有可卖持仓/)

      const advanced = await advanceTraining(database, config, training.id)
      expect(advanced.settled).toBe(false)
      expect(advanced.snapshot.training.currentDate).toBe(dates[1])
      // 手算：day1 收盘 10.1 → 权益 = 500,000 + 50,000×10.1 = 1,005,000
      expect(advanced.snapshot.account.equity).toBeCloseTo(1_005_000, 10)
      const curve = equityCurveOf(database, training.id)
      expect(curve.map(point => point.date)).toEqual(dates.slice(0, 2))
      expect(curve[1].equity).toBeCloseTo(1_005_000, 10)

      // T+1 解锁后可卖；手算：day1 清仓 50,000×10.1=505,000 → 现金 1,005,000
      const sold = await tradeTraining(database, training.id, { side: 'sell', weightPct: 100 })
      expect(sold.plan.amount).toBeCloseTo(505_000, 10)
      expect(sold.snapshot.account.cash).toBeCloseTo(1_005_000, 10)
      expect(sold.snapshot.account.shares).toBe(0)
      expect(closes[1]).toBeCloseTo(10.1, 10)
    })
  })

  it('rejects selling more than available and requires lot sizes', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      await tradeTraining(database, training.id, { side: 'buy', weightPct: 50 })
      await advanceTraining(database, config, training.id)
      // 手算可卖 50,000 股：卖 60% → 30,000 ✓；卖 60,000 股 ✗；卖 30,050 股（非手数且非清仓）✗
      expect((await tradeTraining(database, training.id, { side: 'sell', weightPct: 60 })).plan.shares).toBe(30_000)
      await expect(tradeTraining(database, training.id, { side: 'sell', shares: 60_000 }))
        .rejects.toThrow(/可卖数量不足/)
      const remaining = trainingSnapshot(database, training.id).account.availableShares
      await expect(tradeTraining(database, training.id, { side: 'sell', shares: remaining - 50 }))
        .rejects.toThrow(/一手/)
    })
  })

  it('credits dividends and bonus shares when advancing across an ex-date', async () => {
    await withFixture(async ({ database, config }) => {
      const state: AccountState = { cash: 500_000, shares: 50_000, costTotal: 500_000 }
      // gbbq 字段为"每10股"口径：10派30（每股3元）＋10送5 → 手算现金 +150,000、股份 +25,000
      const events = [
        { date: '2026-07-08', dividend: 30, rightsPrice: 0, bonusShares: 5, rightsShares: 0 },
        { date: '2026-07-01', dividend: 0, rightsPrice: 0, bonusShares: 0, rightsShares: 0 },
      ]
      const after = applyPositionEvents(database, { id: 1 } as never, state, '2026-07-08', events)
      expect(after.cash).toBeCloseTo(650_000, 10)
      expect(after.shares).toBe(75_000)
      expect(after.costTotal).toBe(500_000)
      const rows = database.prepare('SELECT date, shares_delta, cash_delta FROM position_events WHERE training_id = 1').all() as unknown as Array<{ date: string; shares_delta: number; cash_delta: number }>
      expect(rows).toEqual([{ date: '2026-07-08', shares_delta: 25_000, cash_delta: 150_000 }])

      // 10配3 @5 元、持仓 10,000 股：手算配股 3,000 股需缴款 15,000，现金充足则自动认购
      const rights = applyPositionEvents(database, { id: 2 } as never, { cash: 500_000, shares: 10_000, costTotal: 100_000 }, '2026-07-08', [
        { date: '2026-07-08', dividend: 0, rightsPrice: 5, bonusShares: 0, rightsShares: 3 },
      ])
      expect(rights.shares).toBe(13_000)
      expect(rights.cash).toBeCloseTo(485_000, 10)

      // 现金不足时放弃配股，只保留送转（10送1 → +1,000 股）
      const noCash = applyPositionEvents(database, { id: 3 } as never, { cash: 1_000, shares: 10_000, costTotal: 100_000 }, '2026-07-08', [
        { date: '2026-07-08', dividend: 0, rightsPrice: 5, bonusShares: 1, rightsShares: 3 },
      ])
      expect(noCash.shares).toBe(11_000)
      expect(noCash.cash).toBe(1_000)
    })
  })

  it('settles at maturity without future bars and blocks further actions', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      let settled = false
      let guard = 0
      while (!settled && guard < 40) {
        settled = (await advanceTraining(database, config, training.id)).settled
        guard += 1
      }
      expect(settled).toBe(true)
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('settled')
      expect(snapshot.training.earlySettle).toBe(false)
      // planned_end = 2026-08-01（周六）：结算日取该日前最后交易日 2026-07-31
      expect(snapshot.training.plannedEnd).toBe('2026-08-01')
      expect(snapshot.training.settleDate).toBe(dates.filter(date => date <= '2026-08-01').at(-1))
      expect(snapshot.training.currentDate <= snapshot.training.plannedEnd).toBe(true)
      await expect(advanceTraining(database, config, training.id)).rejects.toThrow(new HttpError(409, '训练已结束，无法推进'))
      await expect(tradeTraining(database, training.id, { side: 'buy', weightPct: 10 }))
        .rejects.toThrow(new HttpError(409, '训练已结束，无法交易'))

      // 结算后互斥解除，可创建新训练；提前结算带标记
      const next = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[5],
      })
      const early = settleTraining(database, next.id)
      expect(early.status).toBe('settled')
      expect(early.earlySettle).toBe(true)
      expect(early.settleDate).toBe(dates[5])
    })
  })

  it('never returns bars after the advanced date on any timeframe', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '2Y', code: '600000', start_date: dates[0],
      })
      for (let index = 0; index < 5; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      const current = trainingSnapshot(database, training.id).training.currentDate
      expect(current).toBe(dates[5])
      for (const timeframe of ['1D', '1W', '1M'] as const) {
        const bars = await trainingBars(database, config, training.id, timeframe)
        expect(bars.length).toBeGreaterThan(0)
        for (const bar of bars) {
          expect(bar.date <= current).toBe(true)
        }
        // 末根覆盖当前推进日：日线=当日；周线=本周一；月线=本月
        const cursor = new Date(`${current}T00:00:00Z`)
        cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7))
        const mondayKey = cursor.toISOString().slice(0, 10)
        if (timeframe === '1D') expect(bars.at(-1)?.date).toBe(current)
        if (timeframe === '1W') expect(bars.at(-1)?.date).toBe(mondayKey)
        if (timeframe === '1M') expect(bars.at(-1)?.date).toBe(current.slice(0, 7))
      }
    })
  })

  it('loads earlier history in chunks strictly before a date for dynamic view loading', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      for (let index = 0; index < 20; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      const all = await trainingBars(database, config, training.id, '1D')
      expect(all.length).toBe(21)
      const before = all[15].date
      const chunk = await trainingBarsBefore(database, config, training.id, '1D', before, 5)
      expect(chunk.bars.length).toBe(5)
      expect(chunk.bars.at(-1)?.date).toBe(all[14].date)
      expect(chunk.bars[0]?.date).toBe(all[10].date)
      expect(chunk.hasMore).toBe(true)
      const smallest = await trainingBarsBefore(database, config, training.id, '1D', all[0].date, 5)
      expect(smallest.bars).toEqual([])
      expect(smallest.hasMore).toBe(false)
      const remainder = await trainingBarsBefore(database, config, training.id, '1D', before, 100)
      expect(remainder.bars.length).toBe(15)
      expect(remainder.hasMore).toBe(false)
      // 周线同样按聚合后序列分批
      const weekly = await trainingBarsBefore(database, config, training.id, '1W', all[15].date, 2)
      expect(weekly.bars.length).toBeGreaterThan(0)
      expect(weekly.bars.every(bar => bar.date < before)).toBe(true)
    })
  })

  it('masks blind identity and dates while running and restores them after settle', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0], blind: true,
      })
      await tradeTraining(database, training.id, { side: 'buy', weightPct: 50 })
      const running = trainingSnapshot(database, training.id)
      expect(running.training.blind).toBe(true)
      expect(running.training.code).toBeNull()
      expect(running.training.name).toBeNull()
      expect(running.training.currentDate).toBeNull()
      expect(running.trades[0].date).toBe(dates[0])
      expect(running.trades[0].blindIndex).toBe(0)
      expect(running.trades[0].blindLabel).toBe('今日')

      settleTraining(database, training.id)
      const settled = trainingSnapshot(database, training.id)
      expect(settled.training.status).toBe('settled')
      expect(settled.training.code).toBe('600000')
      expect(settled.training.currentDate).toBe(dates[0])
      expect(settled.trades[0].blindLabel).toBeUndefined()
      expect(settled.trades[0].blindIndex).toBeUndefined()
    })
  })

  it('releases the single-training mutex on abandon and keeps the record', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      const abandoned = abandonTraining(database, training.id)
      expect(abandoned.status).toBe('abandoned')
      expect(abandoned.settleDate).toBe(dates[0])
      const reopened = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[10],
      })
      expect(reopened.status).toBe('running')
    })
  })

  it('adjusts historical trade markers while retaining current acquisition cost across a dividend', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      // 手工造权息：2026-07-10 每10股派20元（每股 2 元 → m=1、c=2），除权前价格整体 −2
      database.prepare(`
        INSERT INTO adj_factors (market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c)
        VALUES ('sh', '600000', '2026-07-10', 20, 0, 0, 0, 1, 2)
      `).run()
      const insertTrade = database.prepare(`
        INSERT INTO trades (training_id, seq, trade_date, side, price, shares, amount, fee, cash_after, shares_after, cost_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      // 手算：除权前买入 1000 股@10.0 → 图表价 10−2=8；除权后卖出 500 股@11 → 原价 11
      let guard = 0
      while (trainingSnapshot(database, training.id).training.currentDate < '2026-07-06' && guard < 10) {
        await advanceTraining(database, config, training.id)
        guard += 1
      }
      expect(trainingSnapshot(database, training.id).training.currentDate).toBe('2026-07-06')
      insertTrade.run(training.id, 1, '2026-07-06', 'buy', 10, 1000, 10000, 0, 990_000, 1000, 10_000)
      while (trainingSnapshot(database, training.id).training.currentDate < '2026-07-13' && guard < 10) {
        await advanceTraining(database, config, training.id)
        guard += 1
      }
      expect(trainingSnapshot(database, training.id).training.currentDate).toBe('2026-07-13')
      insertTrade.run(training.id, 2, '2026-07-13', 'sell', 11, 500, 5500, 0, 997_500, 500, 5000)
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.trades[0].price).toBe(10)
      expect(snapshot.account.cash).toBe(997_500)
      expect(snapshot.account.shares).toBe(500)
      expect(snapshot.account.costPrice).toBe(10)
      const chart = buildChartSpace(database, training.id, snapshot.trades)
      expect(chart.trades[0].chartPrice).toBeCloseTo(8, 10)
      expect(chart.trades[1].chartPrice).toBeCloseTo(11, 10)
      // 分红进入现金；剩余持仓保留取得成本，不能用历史复权买价替代。
      expect(chart.costPrice).toBe(10)
    })
  })

  // ── R0 数据尾守卫：找不到下一根时区分"真到期"与"数据未更新到位" ──

  it('keeps running and reports waiting-for-data when the local tail is before planned_end', async () => {
    await withFixture(async ({ database, config, dates }) => {
      // 数据末日 = dates[31] = 2026-08-13，1M 计划结束 = 2026-08-20：来源未覆盖计划结束
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[13],
      })
      expect(training.plannedEnd).toBe('2026-08-20')
      for (let index = 0; index < 18; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      expect(trainingSnapshot(database, training.id).training.currentDate).toBe('2026-08-13')
      const curveBefore = equityCurveOf(database, training.id)
      let waited: HttpError | null = null
      try {
        await advanceTraining(database, config, training.id)
      } catch (error) {
        waited = error as HttpError
      }
      expect(waited).toBeInstanceOf(HttpError)
      expect(waited?.statusCode).toBe(409)
      expect(waited?.message).toContain('等待日线数据')
      expect(waited?.message).toContain('2026-08-13')
      expect(waited?.message).toContain('2026-08-20')
      // 保守等待：状态仍 running，当前日与权益曲线原样保留
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('running')
      expect(snapshot.training.currentDate).toBe('2026-08-13')
      expect(equityCurveOf(database, training.id)).toEqual(curveBefore)
    })
  })

  it('still allows early settlement after waiting for daily data', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[13],
      })
      for (let index = 0; index < 18; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      await expect(advanceTraining(database, config, training.id)).rejects.toThrow(/等待日线数据/)
      // 用户主动提前结算仍然可用，结算日保留在当前推进日
      const settled = settleTraining(database, training.id)
      expect(settled.status).toBe('settled')
      expect(settled.earlySettle).toBe(true)
      expect(settled.settleDate).toBe('2026-08-13')
    })
  })

  it('settles at maturity when the local tail covers planned_end (regression)', async () => {
    await withFixture(async ({ database, config, dates }) => {
      // 数据末日 2026-08-13 >= 计划结束 2026-08-01：正常到期结算，不触发等待
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      let settled = false
      let guard = 0
      while (!settled && guard < 40) {
        settled = (await advanceTraining(database, config, training.id)).settled
        guard += 1
      }
      expect(settled).toBe(true)
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('settled')
      expect(snapshot.training.earlySettle).toBe(false)
      expect(snapshot.training.settleDate).toBe(dates[22])
    })
  })

  it('settles when planned_end falls on a weekend with the last weekday bar present (regression)', async () => {
    // 本地日线恰好停在 2026-07-31（周五），计划结束 2026-08-01（周六）：缺口只含周末，正常到期结算
    await withCustomFixture([{ file: 'sh600000.day', dates: weekdayDates('2026-07-01', 23) }], async ({ database, config }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: '2026-07-01',
      })
      expect(training.plannedEnd).toBe('2026-08-01')
      let settled = false
      let guard = 0
      while (!settled && guard < 40) {
        settled = (await advanceTraining(database, config, training.id)).settled
        guard += 1
      }
      expect(settled).toBe(true)
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('settled')
      expect(snapshot.training.earlySettle).toBe(false)
      expect(snapshot.training.settleDate).toBe('2026-07-31')
      expect(snapshot.training.currentDate).toBe('2026-07-31')
    })
  })

  it('keeps running when another stock trades past planned_end but the target stops at its own tail', async () => {
    // 旧实现用"全市场数据尾越过计划结束"推断个股停牌并自动到期；
    // 他股更新不能证明目标个股区间完整：600000 停在 7-31，600001 交易到 8-05，
    // 计划结束 8-03（周一）时必须保守等待，而不是按停牌自动结算。
    await withCustomFixture([
      { file: 'sh600000.day', dates: weekdayDates('2026-07-01', 23) },
      { file: 'sh600001.day', dates: weekdayDates('2026-07-01', 26) },
    ], async ({ database, config }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: '2026-07-03',
      })
      expect(training.plannedEnd).toBe('2026-08-03')
      for (let index = 0; index < 20; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      expect(trainingSnapshot(database, training.id).training.currentDate).toBe('2026-07-31')
      const curveBefore = equityCurveOf(database, training.id)
      let waited: HttpError | null = null
      try {
        await advanceTraining(database, config, training.id)
      } catch (error) {
        waited = error as HttpError
      }
      expect(waited).toBeInstanceOf(HttpError)
      expect(waited?.statusCode).toBe(409)
      expect(waited?.message).toContain('等待日线数据')
      expect(waited?.message).toContain('2026-07-31')
      expect(waited?.message).toContain('2026-08-03')
      // 保守等待：仍 running、当前日与权益曲线原样保留；提前结算仍然可用
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('running')
      expect(snapshot.training.currentDate).toBe('2026-07-31')
      expect(equityCurveOf(database, training.id)).toEqual(curveBefore)
      const settled = settleTraining(database, training.id)
      expect(settled.status).toBe('settled')
      expect(settled.earlySettle).toBe(true)
      expect(settled.settleDate).toBe('2026-07-31')
    })
  })

  it('keeps waiting when bars resume after planned_end but the interval has an unconfirmed gap', async () => {
    // 结束日之后有记录不能单独证明区间无漏数：600000 交易 7-01..7-10 后中断，
    // 8-10 起恢复（计划结束 8-01）。中间缺口可能是停牌也可能是数据缺失，不得按"尾日已覆盖"自动结算。
    await withCustomFixture([
      { file: 'sh600000.day', dates: [...weekdayDates('2026-07-01', 8), ...weekdayDates('2026-08-10', 5)] },
    ], async ({ database, config }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: '2026-07-01',
      })
      expect(training.plannedEnd).toBe('2026-08-01')
      for (let index = 0; index < 7; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      expect(trainingSnapshot(database, training.id).training.currentDate).toBe('2026-07-10')
      let waited: HttpError | null = null
      try {
        await advanceTraining(database, config, training.id)
      } catch (error) {
        waited = error as HttpError
      }
      expect(waited).toBeInstanceOf(HttpError)
      expect(waited?.statusCode).toBe(409)
      expect(waited?.message).toContain('等待日线数据')
      expect(waited?.message).toContain('2026-07-10')
      expect(waited?.message).toContain('2026-08-01')
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('running')
      expect(snapshot.training.currentDate).toBe('2026-07-10')
      // 防未来不因等待失效：可见日线仍不含推进日之后的数据
      const bars = await trainingBars(database, config, training.id, '1D')
      expect(bars.at(-1)?.date).toBe('2026-07-10')
    })
  })

  it('advances across a suspended stretch inside the interval and settles at the weekend bridge', async () => {
    // 区间内停牌且复牌：7-13..7-17 无线，7-20 复牌——推进静默跳过停牌日，不算缺失、不等待；
    // 之后数据完整走到 7-31，计划结束 8-01（周六）只含周末，正常到期结算。
    await withCustomFixture([
      { file: 'sh600000.day', dates: [...weekdayDates('2026-07-01', 8), ...weekdayDates('2026-07-20', 10)] },
    ], async ({ database, config }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: '2026-07-01',
      })
      expect(training.plannedEnd).toBe('2026-08-01')
      let settled = false
      let guard = 0
      while (!settled && guard < 40) {
        settled = (await advanceTraining(database, config, training.id)).settled
        guard += 1
      }
      expect(settled).toBe(true)
      const snapshot = trainingSnapshot(database, training.id)
      expect(snapshot.training.status).toBe('settled')
      expect(snapshot.training.earlySettle).toBe(false)
      expect(snapshot.training.settleDate).toBe('2026-07-31')
      // 权益曲线跳过停牌周：7-10 之后直接是 7-20，停牌日不产生权益点
      const curve = equityCurveOf(database, training.id).map(point => point.date)
      expect(curve).toEqual([...weekdayDates('2026-07-01', 8), ...weekdayDates('2026-07-20', 10)])
    })
  })

  it('leaves settled trainings untouched on further advance attempts (regression)', async () => {
    await withFixture(async ({ database, config, dates }) => {
      const training = await createTraining(database, config, {
        tier: '1M', code: '600000', start_date: dates[0],
      })
      for (let index = 0; index < 3; index += 1) {
        await advanceTraining(database, config, training.id)
      }
      const settled = settleTraining(database, training.id)
      expect(settled.settleDate).toBe(dates[3])
      const curve = equityCurveOf(database, training.id)
      await expect(advanceTraining(database, config, training.id)).rejects.toThrow(new HttpError(409, '训练已结束，无法推进'))
      // 重放不变：状态、终点、权益曲线均保持结算时原样
      const replay = trainingSnapshot(database, training.id)
      expect(replay.training.status).toBe('settled')
      expect(replay.training.settleDate).toBe(dates[3])
      expect(replay.training.currentDate).toBe(dates[3])
      expect(equityCurveOf(database, training.id)).toEqual(curve)
      await expect(tradeTraining(database, training.id, { side: 'buy', weightPct: 10 }))
        .rejects.toThrow(new HttpError(409, '训练已结束，无法交易'))
    })
  })
})
