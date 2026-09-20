import { evidencePath } from './runtime'
import { test, expect } from '@playwright/test'
import { join } from 'node:path'

test('协创数据送转后成本线与账户一致，清仓再买及日周月不残留旧成本', async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  const created = await page.request.post('/api/trainings', { data: { code: '300857', tier: '1M', start_date: '2026-04-15', initial_cash: 1_000_000, blind: false } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).training.id
  await page.goto('/')
  await expect(page.locator('.training-topbar .workspace-title')).toContainText('300857')
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  await page.getByRole('button', { name: '100%', exact: true }).click()
  await page.getByRole('button', { name: '买入', exact: true }).click()
  const tradeEndpoint = `/api/trainings/${id}`
  const expectedShares = 3500
  await expect.poll(async () => (await (await page.request.get(tradeEndpoint)).json()).account.shares).toBe(expectedShares)
  const buyCost = 280.69
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.costLine()?.value)).toBeCloseTo(buyCost, 6)
  for (let day = 0; day < 5; day++) {
    await page.getByRole('button', { name: /推进下一日/ }).click()
    await expect(page.locator('.loading-dot')).not.toBeVisible()
  }
  await expect(page.locator('.training-current-date')).toContainText('当前 2026-04-22')
  const expectedCost = 982415 / 4900
  const current = await (await page.request.get(`${tradeEndpoint}/bars?tf=1D`)).json()
  expect(current.account.shares).toBe(4900)
  expect(current.account.costPrice).toBeCloseTo(expectedCost, 7)
  expect(current.chartCostPrice).toBeCloseTo(expectedCost, 7)
  expect(current.bars.at(-1).close).toBe(260.76)
  for (const label of ['日K', '周K', '月K']) {
    await page.locator('.timeframe-tabs').getByRole('tab', { name: label, exact: true }).click()
    await expect(page.locator('.loading-dot')).not.toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.costLine()?.value)).toBeCloseTo(expectedCost, 7)
    const pixels = await page.evaluate(() => {
      const api = (window as any).__trainerChart
      const last = api.bars().at(-1)
      return { cost: api.costLine().y, current: api.pointToPixel(last.timestamp, last.close).y }
    })
    expect(pixels.cost).toBeGreaterThan(pixels.current)
    if (label === '日K') await page.screenshot({ path: evidencePath('cost-bonus-profitable.png') })
  }
  await page.route(`**/api/trainings/${id}/bars?**`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '模拟行情刷新失败' }) }))
  await page.getByRole('button', { name: '卖出', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.costLine())).toBeNull()
  await expect(page.locator('.error-text')).toHaveText('模拟行情刷新失败')
  await page.unroute(`**/api/trainings/${id}/bars?**`)
  await page.getByRole('button', { name: /推进下一日/ }).click()
  await expect(page.locator('.loading-dot')).not.toBeVisible()
  await page.getByRole('button', { name: '买入', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get(tradeEndpoint)).json()).account.shares).toBeGreaterThan(0)
  const reopened = await (await page.request.get(`${tradeEndpoint}/bars?tf=1D`)).json()
  expect(reopened.chartCostPrice).toBeCloseTo(reopened.trades.at(-1).price, 7)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.costLine()?.value)).toBeCloseTo(reopened.account.costPrice, 7)
  await page.reload()
  await expect(page.locator('.training-current-date')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.costLine()?.value)).toBeCloseTo(reopened.account.costPrice, 7)
  await page.screenshot({ path: evidencePath('cost-liquidate-reopen.png') })
  expect(errors).toEqual([])
})
