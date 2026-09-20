import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEES, LOT_SIZE, applyTrade, dilutedCostPrice, equityOf, initialAccountState,
  planBuy, planSell, replayAccount,
  type FeeConfig,
} from '../src/train/account.js'

const FEES_ON: FeeConfig = { enabled: true }

describe('training account', () => {
  it('matches a hand-computed buy, hold, and partial sell round trip', () => {
    let state = initialAccountState(1_000_000)
    // 手算：100 万 × 50% = 50 万目标，10.00 元/股 → 50,000 股 = 500,000 元
    const buy = planBuy(state, 10, 50)
    expect(buy).toEqual({ ok: true, plan: { side: 'buy', price: 10, shares: 50_000, amount: 500_000, fee: 0, tax: 0 } })
    if (!buy.ok) throw new Error('unreachable')
    state = applyTrade(state, buy.plan)
    expect(state.cash).toBe(500_000)
    expect(state.shares).toBe(50_000)
    expect(dilutedCostPrice(state)).toBe(10)

    // 次日 11.00 卖出 20,000 股：减仓不改剩余持仓成本
    const sell = planSell(state, 11, { shares: 20_000 }, 50_000)
    if (!sell.ok) throw new Error('unreachable')
    state = applyTrade(state, sell.plan)
    expect(state.cash).toBeCloseTo(500_000 + 220_000, 10)
    expect(state.shares).toBe(30_000)
    expect(state.costTotal).toBeCloseTo(300_000, 10)
    expect(dilutedCostPrice(state)).toBeCloseTo(10, 10)
    expect(equityOf(state, 11)).toBeCloseTo(720_000 + 330_000, 10)
  })

  it('rounds buy lots down to the board lot and shrinks when fees exceed cash', () => {
    const state = initialAccountState(1_000_000)
    // 手算：100 万 × 30% = 30 万；33.33 元/股 → 9000.9 股 → 9,000 股 = 299,970 元
    const buy = planBuy(state, 33.33, 30)
    expect(buy.ok).toBe(true)
    if (buy.ok) expect(buy.plan.shares).toBe(9_000)

    // 可用资金只够 999 股的金额：缩到 900 股（一手整数倍）
    const tight = initialAccountState(10_000)
    const shrunk = planBuy(tight, 10, 100)
    if (!shrunk.ok) throw new Error('unreachable')
    expect(shrunk.plan.amount + shrunk.plan.fee).toBeLessThanOrEqual(10_000)
    expect(shrunk.plan.shares % LOT_SIZE).toBe(0)
  })

  it('rejects buys that cannot reach one board lot', () => {
    const state = initialAccountState(1_000)
    expect(planBuy(state, 500, 50).ok).toBe(false)
    expect(planBuy(state, 10, 0).ok).toBe(false)
    expect(planBuy(state, 10, 120).ok).toBe(false)
  })

  it('computes commission and stamp tax exactly when fees are enabled', () => {
    const state = initialAccountState(1_000_000)
    // 手算：10,000 股 × 9.95 = 99,500；佣金 max(5, 99500×0.00025)=24.875
    const buy = planBuy(state, 9.95, 10, FEES_ON)
    if (!buy.ok) throw new Error('unreachable')
    expect(buy.plan.amount).toBe(99_500)
    expect(buy.plan.fee).toBeCloseTo(24.875, 10)
    const afterBuy = applyTrade(state, buy.plan)
    expect(afterBuy.cash).toBeCloseTo(1_000_000 - 99_500 - 24.875, 10)
    expect(afterBuy.costTotal).toBeCloseTo(99_500 + 24.875, 10)

    // 手算：卖出 5,000 股 × 10.00 = 50,000；佣金 12.5 ＋ 印花税 25 = 37.5
    const sell = planSell(afterBuy, 10, { shares: 5_000 }, 10_000, FEES_ON)
    if (!sell.ok) throw new Error('unreachable')
    expect(sell.plan.fee).toBeCloseTo(37.5, 10)
    const afterSell = applyTrade(afterBuy, sell.plan)
    expect(afterSell.cash).toBeCloseTo(afterBuy.cash + 50_000 - 37.5, 10)
  })

  it('enforces board-lot and availability rules on sells with odd-lot clearance', () => {
    const state = { cash: 0, shares: 2_500, costTotal: 25_000 }
    expect(planSell(state, 10, { shares: 250 }, 2_500).ok).toBe(false)
    expect(planSell(state, 10, { shares: 300 }, 2_500).ok).toBe(true)
    expect(planSell(state, 10, { shares: 2_500 }, 2_500).ok).toBe(true)
    expect(planSell(state, 10, { shares: 3_000 }, 2_500).ok).toBe(false)
    expect(planSell(state, 10, { weightPct: 40 }, 2_500).ok).toBe(true)
    const small = { cash: 0, shares: 250, costTotal: 2_500 }
    // 250 股 × 20% = 50 股：不足一手 → 拒绝；40% = 100 股恰为一手 → 允许
    expect(planSell(small, 10, { weightPct: 20 }, 250).ok).toBe(false)
    expect(planSell(small, 10, { weightPct: 40 }, 250).ok).toBe(true)
    expect(planSell(small, 10, { weightPct: 100 }, 250).ok).toBe(true)
    // T+1：可卖数量由引擎按当日买入扣减后传入
    expect(planSell(state, 10, { shares: 2_500 }, 1_000).ok).toBe(false)
    expect(planSell(state, 10, { shares: 1_000 }, 1_000).ok).toBe(true)
  })

  it('replays a trade list to the same account state as step-by-step application', () => {
    const plans = [
      { side: 'buy' as const, shares: 50_000, amount: 500_000, fee: 0 },
      { side: 'sell' as const, shares: 20_000, amount: 220_000, fee: 0 },
      { side: 'buy' as const, shares: 10_000, amount: 110_000, fee: 27.5 },
    ]
    const replayed = replayAccount(1_000_000, plans)
    let stepped = initialAccountState(1_000_000)
    for (const plan of plans) stepped = applyTrade(stepped, { ...plan, price: 0, tax: 0 })
    expect(replayed).toEqual(stepped)
    expect(replayed.shares).toBe(40_000)
  })

  it('keeps default fees disabled', () => {
    expect(DEFAULT_FEES.enabled).toBe(false)
    const buy = planBuy(initialAccountState(1_000_000), 10, 10)
    if (buy.ok) expect(buy.plan.fee).toBe(0)
  })
})
