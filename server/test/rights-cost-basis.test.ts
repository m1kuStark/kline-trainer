import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from '../src/db.js'
import { applyPositionEvents, buildChartSpace, trainingSnapshot } from '../src/train/engine.js'
import type { AccountState } from '../src/train/account.js'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createDatabase() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  return database
}

function holding(initialCash = 600000) {
  const database = createDatabase()
  migrateDatabase(database)
  database.prepare(`
    INSERT INTO trainings (
      id, tier, code, name, market, start_date, planned_end, status,
      initial_cash, created_at, current_date, current_close
    ) VALUES (1, '1Y', '600000', 'Fixture', 'sh', '2026-04-20', '2027-04-20',
      'running', ?, '2026-04-20T00:00:00Z', '2026-04-22', 10)
  `).run(initialCash)
  database.prepare(`
    INSERT INTO trades (training_id, seq, trade_date, side, price, shares, amount,
      fee, cash_after, shares_after, cost_after)
    VALUES (1, 1, '2026-04-20', 'buy', 10, 10000, 100000, 0, ?, 10000, 100000)
  `).run(initialCash - 100000)
  const row = database.prepare('SELECT * FROM trainings WHERE id = 1').get() as unknown as Parameters<typeof applyPositionEvents>[1]
  const state: AccountState = { cash: initialCash - 100000, shares: 10000, costTotal: 100000 }
  return { database, row, state }
}

function factor(database: DatabaseSync, dividend = 0, bonusShares = 0) {
  const event = { date: '2026-04-22', dividend, rightsPrice: 5, bonusShares, rightsShares: 3 }
  database.prepare(`
    INSERT INTO adj_factors (
      market, code, date, dividend, rights_price, bonus_shares, rights_shares, m, c
    ) VALUES ('sh', '600000', ?, ?, 5, ?, 3, ?, ?)
  `).run(event.date, dividend, bonusShares, 1.3 + bonusShares / 10, (dividend - 15) / 10)
  return event
}

describe('rights subscription cost', () => {
  it('migrates legacy position events with an unknown cost delta and preserves their ledger values', () => {
    const database = createDatabase()
    database.exec(`
      CREATE TABLE position_events (
        training_id INTEGER NOT NULL, seq INTEGER NOT NULL, date TEXT NOT NULL,
        kind TEXT NOT NULL, shares_delta REAL NOT NULL, cash_delta REAL NOT NULL,
        PRIMARY KEY (training_id, seq)
      );
      INSERT INTO position_events VALUES (1, 1, '2026-04-22', 'corporate_action', 3000, -15000);
    `)
    for (let index = 0; index < 2; index += 1) {
      migrateDatabase(database)
      expect(database.prepare('SELECT * FROM position_events').all()).toEqual([{
        training_id: 1, seq: 1, date: '2026-04-22', kind: 'corporate_action',
        shares_delta: 3000, cash_delta: -15000, cost_delta: null,
      }])
    }
  })

  it('books funded subscription cash as acquisition cost and reconstructs it independently of the factor cache', () => {
    const { database, row, state } = holding()
    const event = factor(database)
    const after = applyPositionEvents(database, row, state, event.date, [event])
    expect(after).toEqual({ cash: 485000, shares: 13000, costTotal: 115000 })
    expect(database.prepare('SELECT cost_delta FROM position_events').get()).toEqual({ cost_delta: 15000 })
    const snapshot = trainingSnapshot(database, row.id)
    expect(snapshot.account.costPrice).toBeCloseTo(115000 / 13000, 10)
    expect(buildChartSpace(database, row.id, snapshot.trades).costPrice).toBeCloseTo(115000 / 13000, 10)
    database.prepare('DELETE FROM adj_factors').run()
    expect(trainingSnapshot(database, row.id).account.costPrice).toBeCloseTo(115000 / 13000, 10)
  })

  it('records zero added cost when cash cannot fund rights and only bonus shares are credited', () => {
    const { database, row, state } = holding(101000)
    const event = factor(database, 0, 1)
    const after = applyPositionEvents(database, row, state, event.date, [event])
    expect(after).toEqual({ cash: 1000, shares: 11000, costTotal: 100000 })
    expect(database.prepare('SELECT cost_delta FROM position_events').get()).toEqual({ cost_delta: 0 })
    expect(trainingSnapshot(database, row.id).account.costPrice).toBeCloseTo(100000 / 11000, 10)
  })

  it('adds gross subscription cost when a simultaneous dividend makes net event cash positive', () => {
    const { database, row, state } = holding(101000)
    const event = factor(database, 20, 1)
    const after = applyPositionEvents(database, row, state, event.date, [event])
    expect(after).toEqual({ cash: 6000, shares: 14000, costTotal: 115000 })
    expect(database.prepare('SELECT cash_delta, cost_delta FROM position_events').get()).toEqual({
      cash_delta: 5000, cost_delta: 15000,
    })
    expect(trainingSnapshot(database, row.id).account.costPrice).toBeCloseTo(115000 / 14000, 10)
  })

  it('retains subscription basis through same-day partial sales and subsequent purchases in trade sequence', () => {
    const { database, row, state } = holding()
    const event = factor(database)
    applyPositionEvents(database, row, state, event.date, [event])
    database.exec(`
      INSERT INTO trades (training_id, seq, trade_date, side, price, shares, amount,
        fee, cash_after, shares_after, cost_after)
      VALUES (1, 2, '2026-04-22', 'sell', 10, 3000, 30000, 0, 0, 0, 0),
        (1, 3, '2026-04-22', 'buy', 20, 1000, 20000, 0, 0, 0, 0);
    `)
    const snapshot = trainingSnapshot(database, row.id)
    expect(snapshot.account.cash).toBe(495000)
    expect(snapshot.account.shares).toBe(11000)
    expect(snapshot.account.costPrice).toBeCloseTo((115000 * 10000 / 13000 + 20000) / 11000, 10)
  })

  it.each([
    { dividend: 0, bonus: 0, sharesDelta: 3000, cashDelta: -15000, shares: 13000 },
    { dividend: 20, bonus: 1, sharesDelta: 4000, cashDelta: 5000, shares: 14000 },
  ])('reconstructs legacy subscribed rights with dividend $dividend without rewriting old rows', ({ dividend, bonus, sharesDelta, cashDelta, shares }) => {
    const { database, row } = holding()
    factor(database, dividend, bonus)
    database.prepare(`
      INSERT INTO position_events (training_id, seq, date, kind, shares_delta, cash_delta)
      VALUES (1, 1, '2026-04-22', 'corporate_action', ?, ?)
    `).run(sharesDelta, cashDelta)
    const before = database.prepare('SELECT * FROM position_events').all()
    for (let index = 0; index < 2; index += 1) {
      const snapshot = trainingSnapshot(database, row.id)
      expect(snapshot.account.cash).toBe(500000 + cashDelta)
      expect(snapshot.account.shares).toBe(shares)
      expect(snapshot.account.costPrice).toBeCloseTo(115000 / shares, 10)
      expect(buildChartSpace(database, row.id, snapshot.trades).costPrice).toBeCloseTo(115000 / shares, 10)
    }
    expect(database.prepare('SELECT * FROM position_events').all()).toEqual(before)
  })

  it.each([
    { sharesDelta: 1000, cashDelta: 0, cache: true },
    { sharesDelta: 4000, cashDelta: -14000, cache: true },
    { sharesDelta: 3000, cashDelta: -15000, cache: true },
    { sharesDelta: 4000, cashDelta: -15000, cache: false },
  ])('does not infer legacy subscription cost from unsupported ledger values $sharesDelta/$cashDelta/$cache', ({ sharesDelta, cashDelta, cache }) => {
    const { database, row } = holding()
    if (cache) factor(database, 0, 1)
    database.prepare(`
      INSERT INTO position_events (training_id, seq, date, kind, shares_delta, cash_delta)
      VALUES (1, 1, '2026-04-22', 'corporate_action', ?, ?)
    `).run(sharesDelta, cashDelta)
    expect(trainingSnapshot(database, row.id).account.costPrice).toBeCloseTo(100000 / (10000 + sharesDelta), 10)
  })

  it('uses an explicit zero cost delta even when refreshed factors resemble a paid subscription', () => {
    const { database, row } = holding()
    factor(database)
    database.exec(`
      INSERT INTO position_events (training_id, seq, date, kind, shares_delta, cash_delta, cost_delta)
      VALUES (1, 1, '2026-04-22', 'corporate_action', 3000, -15000, 0);
    `)
    expect(trainingSnapshot(database, row.id).account.costPrice).toBeCloseTo(100000 / 13000, 10)
  })
})
