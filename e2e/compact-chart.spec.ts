import { evidencePath } from './runtime'
import { expect, test } from '@playwright/test'
import { join } from 'node:path'

test('紧凑行情栏释放主图高度，详情覆盖显示不挤动图表', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  const response = await page.request.post('/api/trainings', { data: { code: '300857', tier: '2Y', start_date: '2024-09-13' } })
  expect(response.status()).toBe(201)
  await page.goto('/')
  await expect(page.locator('.training-topbar .workspace-title')).toContainText('300857')
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 840, height: 768 }]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(250)
    await expect(page.getByLabel('记录操作', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '导出录制', exact: true })).toBeVisible()
    const chart = await page.locator('.chart-host').boundingBox()
    expect(chart!.y).toBeLessThanOrEqual(size.width <= 960 ? 120 : 95)
    expect(chart!.height).toBeGreaterThan(size.height - 200)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width)
    await page.screenshot({ path: evidencePath(`compact-${size.width}.png`) })
  }
  const before = await page.locator('.chart-host').boundingBox()
  const currentDate = await page.locator('.training-current-date').innerText()
  await page.getByLabel('训练详情', { exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(page.locator('.training-meta')).toBeVisible()
  expect(await page.locator('.training-current-date').innerText()).toBe(currentDate)
  expect(await page.locator('.chart-host').boundingBox()).toEqual(before)
  await page.screenshot({ path: evidencePath('compact-details.png') })
  await page.getByLabel('训练详情', { exact: true }).click()
  await page.locator('.theme-toggle').click()
  await page.screenshot({ path: evidencePath('compact-light.png') })
  expect(errors).toEqual([])
})

test('刷新读取新增本地行情但不越过推进日，日期可见且可回到最新', async ({ page }) => {
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  const created = await page.request.post('/api/trainings', { data: { code: '300857', tier: '1M', start_date: '2026-09-11' } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).training.id
  const url = `/api/trainings/${id}/bars?tf=1D`
  const actual = (await (await page.request.get(url)).json())
  expect(actual.bars.at(-1).date).toBe('2026-09-11')
  expect(actual.bars.at(-1).close).toBe(261)
  await page.route(`**${url}`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...actual, bars: actual.bars.filter((bar: any) => bar.date <= '2026-08-04') }) }))
  await page.goto('/')
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.bars().at(-1).date)).toBe('2026-08-04')
  await page.unroute(`**${url}`)
  await page.getByRole('button', { name: '刷新图表', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.bars().at(-1).date)).toBe('2026-09-11')
  await expect(page.locator('.chart-date-status')).toContainText('2026-09-11')
  expect((await (await page.request.get(`/api/trainings/${id}`)).json()).training.currentDate).toBe('2026-09-11')
  const host = await page.locator('.chart-host').boundingBox()
  await page.mouse.move(host!.x + host!.width * .6, host!.y + 100)
  await page.mouse.wheel(900, 0)
  await page.getByRole('button', { name: '回到最新K线', exact: true }).click()
  const last = await page.evaluate(() => {
    const api = (window as any).__trainerChart
    const bars = api.bars(), range = api.visibleRange()
    return bars[Math.min(range.to - 1, bars.length - 1)].date
  })
  expect(last).toBe('2026-09-11')
  await page.screenshot({ path: evidencePath('latest-date-300857.png') })
  await page.keyboard.press('BracketRight')
  await expect(page.locator('.timeframe-tabs [aria-selected="true"]')).toHaveText('周K')
  await expect(page.locator('.chart-date-status')).toContainText('右端周K 2026-09-07')
  await expect(page.locator('.training-current-date')).toContainText('2026-09-11')
})
