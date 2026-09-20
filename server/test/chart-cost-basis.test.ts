import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from '../src/db.js'
import { buildChartSpace, trainingSnapshot } from '../src/train/engine.js'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function ledger(adjustMode: 'forward' | 'raw' = 'forward') {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  migrateDatabase(database)
  database.prepare(`
    INSERT INTO trainings (
      id, tier, code, name, market, start_date, planned_end, status,
      adjust_mode, initial_cash, created_at, current_date, current_close
    ) VALUES (1, '2Y', '300857', 'Fixture', 'sz', '2025-05-08', '2027-05-08',
      'running', ?, 1000000, '2025-05-08T00:00:00Z', '2025-05-08', 100)
  `).run(adjustMode)
  let tradeSeq = 0
  let eventSeq = 0
  const cursor = (date: string, price: number) => {
    database.prepare('UPDATE trainings SET current_date = ?, current_close = ? WHERE id = 1').run(date, price)
  }
  return {
    database,
    cursor,
    trade(date: string, side: 'buy' | 'sell', price: number, shares: number, fee = 0) {
      cursor(date, price)
      database.prepare(`
        INSERT INTO trades (
          training_id, seq, trade_date, side, price, shares, amount, fee,
          cash_after, shares_after, cost_after
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
      `).run(++tradeSeq, date, side, price, shares, price * shares, fee)
    },
    event(date: string, bonusPerTen: number, dividendPerTen: number, sharesDelta: number, cashDelta: number) {
      database.prepare(`
        INSERT INTO adj_factors (
          market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
        ) VALUES ('sz', '300857', ?, ?, 0, ?, 0, ?, ?)
      `).run(date, dividendPerTen, bonusPerTen, 1 + bonusPerTen / 10, dividendPerTen / 10)
      database.prepare(`
        INSERT INTO position_events (training_id, seq, date, kind, shares_delta, cash_delta)
        VALUES (1, ?, ?, 'corporate_action', ?, ?)
      `).run(++eventSeq, date, sharesDelta, cashDelta)
      cursor(date, 100)
    },
    read() {
      const snapshot = trainingSnapshot(database, 1)
      return { snapshot, chart: buildChartSpace(database, 1, snapshot.trades) }
    },
  }
}

describe('current position cost on adjusted charts', () => {
  it('clears a bonus-expanded position and starts the next holding at its own cost including fees', () => {
    const account = ledger()
    account.trade('2025-05-09', 'buy', 100, 9500, 237.5)
    account.event('2025-05-12', 4, 2.93, 3800, 2783.5)
    account.trade('2025-05-13', 'sell', 90, 13300, 897.75)
    const cleared = account.read()
    expect(cleared.snapshot.account.shares).toBe(0)
    expect(cleared.snapshot.account.costPrice).toBeNull()
    expect(cleared.chart.costPrice).toBeNull()

    account.trade('2025-05-14', 'buy', 80, 5800, 116)
    account.cursor('2025-05-15', 100)
    const reopened = account.read()
    expect(reopened.snapshot.account.shares).toBe(5800)
    expect(reopened.snapshot.account.cash).toBeCloseTo(784532.25, 8)
    expect(reopened.snapshot.account.costPrice).toBeCloseTo(80.02, 10)
    expect(reopened.chart.costPrice).toBeCloseTo(80.02, 10)
    expect(reopened.chart.costPrice).toBeLessThan(100)
    expect(reopened.chart.trades[0].chartPrice).toBeCloseTo((100 - 0.293) / 1.4, 10)
    expect(reopened.chart.trades.at(-1)?.chartPrice).toBe(80)
  })

  it('retains the remaining booked basis through partial sales, rebuying and two bonuses', () => {
    const account = ledger()
    account.trade('2025-05-09', 'buy', 10, 1000)
    account.event('2025-05-12', 5, 0, 500, 0)
    account.trade('2025-05-13', 'sell', 9, 900)
    // 10000 * (600 / 1500) = 4000 remains; rebuy adds 400 * 8 = 3200.
    account.trade('2025-05-14', 'buy', 8, 400)
    expect(account.read().chart.costPrice).toBeCloseTo(7.2, 10)

    account.event('2026-04-22', 2, 1, 200, 100)
    const afterBonus = account.read()
    expect(afterBonus.snapshot.account.cash).toBe(995000)
    expect(afterBonus.snapshot.account.shares).toBe(1200)
    expect(afterBonus.chart.costPrice).toBeCloseTo(6, 10)
    account.trade('2026-04-23', 'sell', 15, 300, 7.25)
    expect(account.read().chart.costPrice).toBeCloseTo(6, 10)

    // A sale retains 900 * 6 = 5400; the new lot adds 1200 + 5 in fees.
    account.trade('2026-04-24', 'buy', 12, 100, 5)
    const rebought = account.read()
    expect(rebought.snapshot.account.shares).toBe(1000)
    expect(rebought.snapshot.account.costPrice).toBeCloseTo(6.605, 10)
    expect(rebought.chart.costPrice).toBeCloseTo(6.605, 10)
    expect(rebought.chart.trades[0].chartPrice).toBeCloseTo((10 / 1.5 - 0.1) / 1.2, 10)
  })

  it('books a cash dividend to cash and preserves acquisition cost including buy commission', () => {
    const account = ledger()
    account.trade('2025-05-09', 'buy', 10, 1000, 5)
    account.event('2025-05-12', 0, 20, 0, 2000)
    const result = account.read()
    expect(result.snapshot.account.cash).toBe(991995)
    expect(result.snapshot.account.costPrice).toBeCloseTo(10.005, 10)
    expect(result.chart.costPrice).toBeCloseTo(10.005, 10)
    expect(result.chart.trades[0].chartPrice).toBe(8)
  })

  it('keeps the raw-mode fallback contract while its account includes bonus shares', () => {
    const account = ledger('raw')
    account.trade('2025-05-09', 'buy', 10, 1000)
    account.event('2025-05-12', 5, 0, 500, 0)
    const result = account.read()
    expect(result.chart.costPrice).toBeNull()
    expect(result.chart.trades[0].chartPrice).toBeUndefined()
    expect(result.snapshot.account.costPrice).toBeCloseTo(10 / 1.5, 10)
  })

  it('keeps the account-cost fallback until the first effective adjustment event', () => {
    const account = ledger()
    account.trade('2025-05-09', 'buy', 10, 1000, 5)
    account.database.prepare(`
      INSERT INTO adj_factors (
        market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
      ) VALUES ('sz', '300857', '2026-04-22', 1, 0, 2, 0, 1.2, 0.1)
    `).run()
    const result = account.read()
    expect(result.chart.costPrice).toBeNull()
    expect(result.chart.trades[0].chartPrice).toBeUndefined()
    expect(result.snapshot.account.costPrice).toBeCloseTo(10.005, 10)
  })
})
