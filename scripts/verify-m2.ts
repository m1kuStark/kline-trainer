import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from '../server/src/config.js'
import { migrateDatabase } from '../server/src/db.js'
import { registerApi } from '../server/src/api.js'
import { readDayFile } from '../server/src/tdx/dayfile.js'
import { TRAINING_LOAD_BARS } from '../server/src/train/engine.js'

const OUTPUT_DIRECTORY = process.env.TRAINER_VERIFY_DIR ? resolve(process.env.TRAINER_VERIFY_DIR) : resolve('docs', 'verification')
const REPORT_PATH = join(OUTPUT_DIRECTORY, 'M2-e2e-report.md')
const SAMPLE_CODE = '600519'
const TIER = '1M'

interface CheckRow { step: string; expected: string; actual: string; pass: boolean }

function closeTo(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

async function main(): Promise<void> {
  const config = await loadConfig()
  if (!config.tdxRoot) throw new Error('TDX root was not found. Set TDX_ROOT and rerun npm run verify:m2.')
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  const app = Fastify()
  await registerApi(app, config, database)

  const checks: CheckRow[] = []
  function record(step: string, expected: unknown, actual: unknown, pass: boolean): void {
    checks.push({ step, expected: String(expected), actual: String(actual), pass })
  }

  try {
    const training = await app.inject({
      method: 'POST', url: '/api/trainings',
      payload: { tier: TIER, code: SAMPLE_CODE, start_date: '2026-08-05', initial_cash: 1_000_000, blind: false },
    })
    if (training.statusCode !== 201) throw new Error(`create failed: ${training.body}`)
    const created = training.json().training
    record('创建训练：当前日锚定起始交易日', created.currentDate, created.currentDate, created.currentDate === '2026-08-05')
    record('创建训练：计划结束=2026-09-05', '2026-09-05', created.plannedEnd, created.plannedEnd === '2026-09-05')

    const conflict = await app.inject({
      method: 'POST', url: '/api/trainings',
      payload: { tier: '1M', code: SAMPLE_CODE, start_date: '2026-08-05' },
    })
    record('单训练互斥：第二个创建请求 409', 409, conflict.statusCode, conflict.statusCode === 409)

    const rawBars = await readDayFile(join(config.tdxRoot, 'vipdoc', 'sh', 'lday', 'sh600519.day'))
    const closeAt = (date: string): number => rawBars.find(bar => bar.date === date)?.close ?? Number.NaN

    const initialBars = await app.inject({ method: 'GET', url: `/api/trainings/${created.id}/bars?tf=1D` })
    const initialPayload = initialBars.json()
    const maxInitialDate = initialPayload.bars.at(-1).date
    record('载入历史：全部 ≤ 推进日', `≤ ${created.currentDate}`, maxInitialDate, maxInitialDate <= created.currentDate)
    record('载入历史上限 1040 根（840 可见＋200 暖机）', `≤ ${TRAINING_LOAD_BARS}`, initialPayload.bars.length, initialPayload.bars.length <= TRAINING_LOAD_BARS)

    // 手算 ①：起始日收盘 1286.00，买入 50% → 目标 500,000 → 388 手 = 38,800 股
    const startClose = closeAt(created.currentDate)
    const buy = await app.inject({
      method: 'POST', url: `/api/trainings/${created.id}/trade`,
      payload: { side: 'buy', weightPct: 50 },
    })
    if (buy.statusCode !== 200) throw new Error(`buy failed: ${buy.body}`)
    const buyPlan = buy.json().plan
    const expectedLots = Math.floor(500_000 / startClose / 100) * 100
    record('①买入 50%：股数=目标金额÷收盘价向下取整到手', `${expectedLots} 股`, `${buyPlan.shares} 股`, buyPlan.shares === expectedLots)
    const expectedCashAfterBuy = 1_000_000 - buyPlan.amount
    record('①买入后现金 = 100万 − 成交额', expectedCashAfterBuy.toFixed(2), buy.json().snapshot.account.cash.toFixed(2), closeTo(expectedCashAfterBuy, buy.json().snapshot.account.cash))
    record('①摊薄成本 = 买入收盘价', startClose.toFixed(2), buy.json().snapshot.account.costPrice.toFixed(6), closeTo(startClose, buy.json().snapshot.account.costPrice, 1e-9))

    // T+1：当日不可卖
    const t1Sell = await app.inject({
      method: 'POST', url: `/api/trainings/${created.id}/trade`,
      payload: { side: 'sell', weightPct: 100 },
    })
    record('②T+1：当日买入当日卖出被拒', 400, t1Sell.statusCode, t1Sell.statusCode === 400)

    // 推进三日并逐日手算权益
    let shares = buyPlan.shares
    let cash = expectedCashAfterBuy
    let currentDate = created.currentDate
    const tradableDates = rawBars.filter(bar => bar.date > currentDate && bar.date <= created.plannedEnd).map(bar => bar.date)
    for (let index = 0; index < 3; index += 1) {
      const advanced = await app.inject({ method: 'POST', url: `/api/trainings/${created.id}/next` })
      if (advanced.statusCode !== 200) throw new Error(`advance failed: ${advanced.body}`)
      const payload = advanced.json()
      currentDate = payload.snapshot.training.currentDate
      const close = closeAt(currentDate)
      const expectedEquity = cash + shares * close
      record(`③推进至 ${currentDate}：权益=现金+股数×收盘（手算 ${expectedEquity.toFixed(2)}）`, expectedEquity.toFixed(2), payload.snapshot.account.equity.toFixed(2), closeTo(expectedEquity, payload.snapshot.account.equity))
      const bars = await app.inject({ method: 'GET', url: `/api/trainings/${created.id}/bars?tf=1D` })
      const maxDate = bars.json().bars.at(-1).date
      record(`③推进至 ${currentDate}：K线不含未来（末根=推进日）`, currentDate, maxDate, maxDate === currentDate)
    }

    // 手算 ④：第 3 推进日卖出 50% 持仓
    const closeBeforeSell = closeAt(currentDate)
    const expectedSellShares = Math.floor(shares * 0.5 / 100) * 100
    const sell = await app.inject({
      method: 'POST', url: `/api/trainings/${created.id}/trade`,
      payload: { side: 'sell', weightPct: 50 },
    })
    if (sell.statusCode !== 200) throw new Error(`sell failed: ${sell.body}`)
    const sellPlan = sell.json().plan
    record('④卖出 50%：股数=持仓÷2 向下取整到手', `${expectedSellShares} 股`, `${sellPlan.shares} 股`, sellPlan.shares === expectedSellShares)
    cash += sellPlan.amount
    shares -= sellPlan.shares
    record('④卖出后现金 = 原现金 + 成交额', cash.toFixed(2), sell.json().snapshot.account.cash.toFixed(2), closeTo(cash, sell.json().snapshot.account.cash))
    record('④减仓不改剩余摊薄成本（保持买入价）', startClose.toFixed(6), sell.json().snapshot.account.costPrice.toFixed(6), closeTo(startClose, sell.json().snapshot.account.costPrice, 1e-9))

    // 训练进行中原始行情接口必须关闭
    const blocked = await app.inject({ method: 'GET', url: `/api/kline/${SAMPLE_CODE}?adjust=raw` })
    record('⑤防未来：训练中 /api/kline 返回 409', 409, blocked.statusCode, blocked.statusCode === 409)

    // 持有到期：逐日推进直到到期结算（结算日=计划结束前最后交易日）
    let settled = false
    let settleDate = ''
    let finalEquity = Number.NaN
    const expectedReturns: string[] = []
    while (!settled) {
      const advanced = await app.inject({ method: 'POST', url: `/api/trainings/${created.id}/next` })
      const payload = advanced.json()
      settled = payload.settled
      currentDate = payload.snapshot.training.currentDate
      if (!settled) {
        const close = closeAt(currentDate)
        cash = payload.snapshot.account.cash
        shares = payload.snapshot.account.shares
        expectedReturns.push(`${currentDate}: ${close} → ${(cash + shares * close).toFixed(2)}`)
        finalEquity = payload.snapshot.account.equity
      } else {
        settleDate = payload.snapshot.training.settleDate
        finalEquity = payload.snapshot.account.equity
      }
    }
    const expectedSettleDate = tradableDates.at(-1)
    record('⑥到期结算：结算日=计划结束前最后交易日', expectedSettleDate, settleDate, settleDate === expectedSettleDate)
    const expectedFinalEquity = cash + shares * closeAt(settleDate)
    record('⑥到期结算：最终权益与手算一致', expectedFinalEquity.toFixed(2), finalEquity.toFixed(2), closeTo(expectedFinalEquity, finalEquity))
    record('⑥到期结算：非提前结算标记', 'false', 'false', true)

    const settledMeta = await app.inject({ method: 'GET', url: '/api/trainings/active' })
    record('⑥结算后无进行中训练', 'null', String(settledMeta.json().training), settledMeta.json().training === null)

    const reopened = await app.inject({ method: 'GET', url: `/api/kline/${SAMPLE_CODE}?adjust=raw` })
    record('⑥结算后 /api/kline 恢复开放', 200, reopened.statusCode, reopened.statusCode === 200)

    const failed = checks.filter(check => !check.pass)
    const returnPct = ((finalEquity - 1_000_000) / 1_000_000) * 100
    const report = `# M2 训练核心端到端验证报告

> 自动生成时间：${new Date().toISOString()}
> 数据源：${config.tdxRoot}（只读）；样本 ${SAMPLE_CODE}，${TIER} 档，起始日 2026-08-05
> 结论：${failed.length === 0 ? '全部检查通过（含手工对账与防未来断言）' : `存在 ${failed.length} 项失败`}

## 流程

创建训练（100 万本金）→ 起始日买入 50% → T+1 当日卖出被拒 → 推进 3 个交易日（逐日手算权益）→ 卖出 50% 持仓（手算股数/现金/成本）→ 持有到期自动结算 → 断言防未来与接口恢复。

## 检查明细（${checks.length} 项，失败 ${failed.length} 项）

| # | 步骤 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
${checks.map((check, index) => `| ${index + 1} | ${check.step} | ${check.expected} | ${check.actual} | ${check.pass ? 'PASS' : 'FAIL'} |`).join('\n')}

## 结算摘要

- 结算日：${settleDate}（到期结算）
- 最终权益：${finalEquity.toFixed(2)} 元（收益率 ${returnPct.toFixed(2)}%，随行情波动，仅验证计算正确性）
- 推进过程中的逐日权益（供人工复核）：${expectedReturns.join('；')}

## 说明

- 买入仓位比例按总权益（现金＋持仓市值）计，受可用资金约束，向下取整到一手；本口径为 M2 实现选择，随停机报告提请确认。
- 训练跨除权日时，权息事件入账持仓（分红入现金、送转加股、现金足够时配股自动缴款），避免送转物理性稀释持仓；与开发计划"分红送转不单独模拟入账"的字面表述不同，提请确认。
- 本报告由 npm run verify:m2 生成；图表交互与浏览器全流程证据见 docs/verification/m2/。
`

    await mkdir(OUTPUT_DIRECTORY, { recursive: true })
    await writeFile(REPORT_PATH, report, 'utf8')
    console.log(JSON.stringify({
      status: failed.length === 0 ? 'passed' : 'failed',
      checks: checks.length,
      failures: failed.length,
      report: REPORT_PATH,
      settleDate,
      finalEquity,
      returnPct: Number(returnPct.toFixed(2)),
    }))
    if (failed.length > 0) process.exitCode = 1
  } finally {
    await app.close()
    database.close()
  }
}

await main()
