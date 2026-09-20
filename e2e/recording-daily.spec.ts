import { test, expect } from '@playwright/test'
import { gzipSync } from 'node:zlib'
import { compactRecording } from '../web/src/recording/compactCodec'
import { validateCompactRecording } from '../web/src/recording/compactValidation'
import type { CompactRecordingFile } from '../web/src/recording/compactTypes'
import type { Bar, TrainingSnapshot } from '../web/src/api'
import type { Drawing } from '../web/src/drawingState'
import type { ChartCapture, RecordingCheckpoint, RecordingEvent, RecordingFile } from '../web/src/recording/types'
import { evidencePath } from './runtime'

// REC-03 按交易日回放：合成带 1D 规范检查点的紧凑录制，走真实导入校验与真实键盘/控件。
// 5 个交易日，覆盖首日单根K线和后续多根K线的实际缩放。
const DATES = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']

function makeBar(date: string, close: number): Bar {
  return { date, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000, amount: close * 1000 }
}

function makeDailyBars(through: number): Bar[] {
  return DATES.slice(0, through + 1).map((date, index) => makeBar(date, 10 + index))
}

function makeTraining(currentDate: string, equity: number): TrainingSnapshot {
  return {
    training: {
      id: 7, tier: '6M', code: '600000', name: '浦发银行', market: 'SH',
      startDate: DATES[0]!, plannedEnd: '2026-07-01', currentDate, status: 'running',
      settleDate: null, earlySettle: false, blind: false, adjustMode: 'forward',
      initialCash: 100000, createdAt: '2026-01-05T01:00:00.000Z',
    },
    account: { cash: 95000, shares: 500, availableShares: 500, costPrice: 10, marketValue: 5000, equity },
    trades: [],
  }
}

function makeChart(bars: Bar[], drawings: Drawing[] = [], timeframe: ChartCapture['timeframe'] = '1D'): ChartCapture {
  return {
    timeframe, bars, drawings,
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: 10,
  }
}

function makeEvent(seq: number, overrides: Partial<RecordingEvent> = {}): RecordingEvent {
  return { seq, opId: `op-${seq}`, segmentId: 'seg-1', elapsedMs: seq * 10, phase: 'started', action: 'training.advance', source: 'ui', ...overrides }
}

function makePair(seq: number, opId: string, action: RecordingEvent['action'], overrides: Partial<RecordingEvent> = {}): RecordingEvent[] {
  return [makeEvent(seq, { opId, action }), makeEvent(seq + 1, { opId, action, phase: 'finished', outcome: 'accepted', ...overrides })]
}

function makeCheckpoint(afterSeq: number, overrides: Partial<RecordingCheckpoint> = {}): RecordingCheckpoint {
  return {
    id: `cp-${afterSeq}`, afterSeq, segmentId: 'seg-1',
    capturedAt: `2026-01-05T09:${String(afterSeq % 60).padStart(2, '0')}:00.000Z`,
    training: null, chart: null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: null, ...overrides,
  }
}

function buildCompactFile(): CompactRecordingFile {
  const drawing: Drawing = {
    id: 'dw-e2e-1', name: 'segment', paneId: 'candle_pane',
    points: [{ timestamp: Date.parse(`${DATES[2]}T00:00:00Z`), value: 10.5 }],
  }
  const file: RecordingFile = {
    format: 'trainer-session', schemaVersion: 1, sessionId: 'session-daily-e2e',
    createdAt: '2026-01-05T01:00:00.000Z',
    app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: false, chartLibrary: 'klinecharts@10.0.3' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, dpr: 1 },
    trainingKey: '600000-SH-6M',
    events: [
      ...makePair(1, 'op-create', 'training.create'),
      ...makePair(3, 'op-adv1', 'training.advance', { checkpointId: 'cp-4' }),
      makeEvent(5, { opId: 'op-trade', action: 'training.trade', params: { side: 'buy', shares: 500 } }),
      makeEvent(6, { opId: 'op-trade', action: 'training.trade', phase: 'finished', outcome: 'accepted', checkpointId: 'cp-6', result: { plan: { side: 'buy', shares: 500, price: 10, amount: 5000, fee: 5 } } }),
      ...makePair(7, 'op-adv2', 'training.advance', { checkpointId: 'cp-8' }),
      ...makePair(9, 'op-adv3', 'training.advance', { checkpointId: 'cp-10' }),
      ...makePair(11, 'op-adv4', 'training.advance', { checkpointId: 'cp-12' }),
      makeEvent(13, { opId: 'op-draw', action: 'chart.drawing.create' }),
      makeEvent(14, { opId: 'op-draw', action: 'chart.drawing.create', phase: 'finished', outcome: 'accepted', checkpointId: 'cp-14' }),
      makeEvent(15, { opId: 'op-theme', action: 'ui.theme' }),
      makeEvent(16, { opId: 'op-theme', action: 'ui.theme', phase: 'finished', outcome: 'accepted' }),
    ],
    checkpoints: [
      makeCheckpoint(0, { training: makeTraining(DATES[0]!, 100000), chart: makeChart(makeDailyBars(0)) }),
      makeCheckpoint(4, { training: makeTraining(DATES[1]!, 101000), chart: makeChart(makeDailyBars(1)) }),
      makeCheckpoint(6, {
        training: {
          ...makeTraining(DATES[1]!, 102000),
          trades: [{ seq: 1, date: DATES[1]!, side: 'buy', price: 10, shares: 500, amount: 5000, fee: 5 }],
        },
        chart: makeChart(makeDailyBars(1)),
      }),
      makeCheckpoint(8, { training: makeTraining(DATES[2]!, 103000), chart: makeChart(makeDailyBars(2)) }),
      makeCheckpoint(10, { training: makeTraining(DATES[3]!, 104000), chart: makeChart(makeDailyBars(3)) }),
      makeCheckpoint(12, { training: makeTraining(DATES[4]!, 105000), chart: makeChart(makeDailyBars(4)) }),
      makeCheckpoint(14, { training: makeTraining(DATES[4]!, 105000), chart: makeChart(makeDailyBars(4), [drawing]) }),
    ],
    gaps: [],
    complete: true,
  }
  return validateCompactRecording(compactRecording(file))
}

test('按交易日回放：键盘步进、观察周期独立、画线终态与只读安全', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const writes: string[] = []
  page.on('request', request => {
    if (/\/api\//.test(request.url()) && ['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url())
  })

  await page.goto('/')
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  // 回放完全离线：导入后掐断所有 API，再执行全部交互
  await page.route('**/api/**', route => route.abort())

  const compact = buildCompactFile()
  await page.getByLabel('导入录制', { exact: true }).setInputFiles({
    name: 'daily-recording.trainer-session.gz',
    mimeType: 'application/gzip',
    buffer: gzipSync(JSON.stringify(compact)),
  })
  await expect(page.getByRole('button', { name: '关闭回放' })).toBeVisible()
  const firstWidth = await page.evaluate(() => (window as any).__trainerChart.viewportMetrics().bar)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.viewportMetrics().bar)).toBeGreaterThan(firstWidth)
  const firstZoomed = await page.evaluate(() => (window as any).__trainerChart.viewportMetrics().bar)
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.viewportMetrics().bar)).toBeLessThan(firstZoomed)
  await page.keyboard.press('Home')
  await expect(page.locator('.replay-day')).toHaveText(`第 1 / 5 日 · ${DATES[0]}`)
  // 业务列表只有买卖与图形变更：主题切换不入列
  await expect(page.locator('.replay-event-list li')).toHaveCount(2)
  await expect(page.locator('.replay-event-list li').first()).toContainText('买入 500股 @10.00')

  // 键盘步进：空格=下一日，PageUp/PageDown=前后一日；键盘不改观察周期
  await page.locator('.replay-head h2').click()
  await page.keyboard.press('Space')
  await expect(page.locator('.replay-day')).toContainText('第 2 / 5 日')
  await expect(page.locator('.replay-day')).not.toContainText('第 3 / 5 日')
  // 当日终态=范围内最后检查点：终态权益 102000（成交后），非日初 101000
  await expect(page.locator('.replay-account dd').first()).toHaveText('102,000.00')
  await expect(page.getByRole('tab', { name: '日K' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('PageUp')
  await expect(page.locator('.replay-day')).toContainText('第 1 / 5 日')
  await page.keyboard.press('PageDown')
  await expect(page.locator('.replay-day')).toContainText('第 2 / 5 日')

  // 前四日无画线
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.drawings().length ?? -1)).toBe(0)
  await page.getByRole('button', { name: '下一日', exact: true }).click()
  await expect(page.locator('.replay-day')).toContainText('第 3 / 5 日')
  await page.getByRole('button', { name: '下一日', exact: true }).click()
  await expect(page.locator('.replay-day')).toContainText('第 4 / 5 日')

  // 键盘缩放/复位必须真实作用于图表视窗：barSpace 与 visibleRange 实测变化
  //（仅断言「日期不变」掩盖过图表 ref 未绑定、键盘操作全部落空的缺陷）
  const readMetrics = () => page.evaluate(() => {
    const metrics = (window as any).__trainerChart?.viewportMetrics?.()
    return metrics && Number.isFinite(metrics.bar) && metrics.range
      ? { bar: metrics.bar as number, from: metrics.range.from as number, to: metrics.range.to as number }
      : null
  })
  await expect.poll(readMetrics).not.toBeNull()
  const baseline = (await readMetrics())!
  expect(baseline.bar).toBeGreaterThan(0)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await readMetrics())!.bar).toBeGreaterThan(baseline.bar)
  const zoomedIn = (await readMetrics())!
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await readMetrics())!.bar).toBeLessThan(zoomedIn.bar)
  await page.keyboard.press('Home')
  await expect.poll(async () => (await readMetrics())!.bar).toBeCloseTo(baseline.bar, 6)
  await expect.poll(async () => (await readMetrics())!.to).toBe(await page.evaluate(() => (window as any).__trainerChart.bars().length))

  // 缩放后推进到画线日：图表重挂还原该日最终画线，用户缩放视窗跨日保留（重挂前捕获、挂载后还原）
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await readMetrics())!.bar).toBeGreaterThan(baseline.bar)
  const zoomedBeforeRemount = (await readMetrics())!
  await page.getByRole('button', { name: '下一日', exact: true }).click()
  await expect(page.locator('.replay-day')).toContainText('第 5 / 5 日')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.drawings().length ?? -1)).toBe(1)
  await expect.poll(async () => (await readMetrics())!.bar).toBeCloseTo(zoomedBeforeRemount.bar, 3)
  // 观察周期独立于播放日期：[ ] 切周期不改变日期
  await page.keyboard.press('BracketLeft')
  await expect(page.locator('.replay-tabs [aria-selected="true"]')).toHaveText('月K')
  await expect(page.locator('.replay-day')).toContainText('第 5 / 5 日')
  await page.keyboard.press('BracketRight')
  await expect(page.locator('.replay-tabs [aria-selected="true"]')).toHaveText('日K')

  // 十字线/其余键不改变播放日期；B/S/Delete 无写入口
  for (const key of ['ArrowLeft', 'ArrowRight', 'b', 's', 'Delete']) {
    await page.keyboard.press(key)
  }
  await expect(page.locator('.replay-day')).toContainText('第 5 / 5 日')
  await expect(page.locator('.replay-account dd').first()).toHaveText('105,000.00')

  // 自动播放：0.2 秒/日固定间隔推进，末日自动停止
  await page.getByRole('button', { name: '回到第一天', exact: true }).click()
  await expect(page.locator('.replay-day')).toContainText('第 1 / 5 日')
  await page.getByLabel('每日播放时长').selectOption({ label: '0.2 秒/日' })
  await page.getByRole('button', { name: '播放录制', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停回放' })).toBeVisible()
  await expect(page.locator('.replay-day')).toContainText('第 5 / 5 日', { timeout: 5000 })
  await expect(page.getByRole('button', { name: '播放录制', exact: true })).toBeVisible({ timeout: 5000 })

  await page.screenshot({ path: evidencePath('recording-daily.png') })
  expect(writes).toEqual([])
  expect(pageErrors).toEqual([])
})

test('旧文件缺当日日线：首日即时回退唯一周期、明示缺日线、次日恢复偏好', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/')
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  await page.route('**/api/**', route => route.abort())

  // 旧录制形态：首日只有周K快照（整日无日线），次日推进后有当日日线
  const weekBar: Bar = { date: '2026-01-05', open: 9, high: 12, low: 8, close: 11, volume: 2000, amount: 21000 }
  const file: RecordingFile = {
    format: 'trainer-session', schemaVersion: 1, sessionId: 'session-daily-legacy-e2e',
    createdAt: '2026-01-05T01:00:00.000Z',
    app: { version: '0.1.0', gitCommit: 'aba7d82', dirty: false, chartLibrary: 'klinecharts@10.0.3' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, dpr: 1 },
    trainingKey: '600000-SH-6M',
    events: [
      ...makePair(1, 'op-create', 'training.create'),
      ...makePair(3, 'op-adv', 'training.advance', { checkpointId: 'cp-4' }),
    ],
    checkpoints: [
      makeCheckpoint(0, { id: 'cp-0', training: makeTraining(DATES[0]!, 100000), chart: makeChart([weekBar], [], '1W') }),
      makeCheckpoint(4, { id: 'cp-4', training: makeTraining(DATES[1]!, 101000), chart: makeChart(makeDailyBars(1)) }),
    ],
    gaps: [],
    complete: true,
  }
  const compact = validateCompactRecording(compactRecording(file))
  await page.getByLabel('导入录制', { exact: true }).setInputFiles({
    name: 'daily-legacy.trainer-session.gz',
    mimeType: 'application/gzip',
    buffer: gzipSync(JSON.stringify(compact)),
  })
  await expect(page.getByRole('button', { name: '关闭回放' })).toBeVisible()
  await expect(page.locator('.replay-day')).toHaveText(`第 1 / 2 日 · ${DATES[0]}`)

  // 首日缺当日日线：观察周期即时回落到周K（不留停在不可用的日K上），图表真实渲染周K并明示缺日线
  await expect(page.getByRole('tab', { name: '日K' })).toBeDisabled()
  await expect(page.getByRole('tab', { name: '周K' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.replay-chart .chart-host canvas').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.bars()?.length ?? -1)).toBe(1)
  const hint = page.locator('.replay-gap', { hasText: '缺日线' })
  await expect(hint).toBeVisible()
  await expect(hint).toHaveAttribute('title', '此日期仅记录了周K快照，缺少当日日线')

  // 次日有当日日线：日K重新可用，观察偏好恢复为日K
  await page.getByRole('button', { name: '下一日', exact: true }).click()
  await expect(page.locator('.replay-day')).toContainText('第 2 / 2 日')
  await expect(page.getByRole('tab', { name: '日K' })).toBeEnabled()
  await expect(page.getByRole('tab', { name: '日K' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.replay-gap', { hasText: '缺日线' })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.bars()?.length ?? -1)).toBe(2)

  expect(pageErrors).toEqual([])
})
