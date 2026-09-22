import { evidencePath } from './runtime'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', e => list.push(e.message)) })
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]) })
const shot = (page: Page, name: string) => page.screenshot({ path: evidencePath(`round3-${name}.png`) })

async function open(page: Page): Promise<number> {
  const active = await (await page.request.get('/api/trainings/active')).json()
  if (active.training) await page.request.post(`/api/trainings/${active.training.id}/abandon`)
  const response = await page.request.post('/api/trainings', { data: { code: '600519', tier: '1Y', start_date: '2025-01-02', initial_cash: 100_000_000 } })
  expect(response.status()).toBe(201)
  const id = (await response.json()).training.id
  await page.goto('/')
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  await expect(page.locator('.loading-dot')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__trainerChart?.bars?.().length))).toBe(true)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  return id
}
async function choose(page: Page, name: string) {
  if (!await page.locator(`[data-tool-name="${name}"]`).isVisible()) await page.locator('.other-tools-toggle').click()
  await page.locator(`[data-tool-name="${name}"]`).click()
}
async function point(page: Page, x: number, y: number) {
  const box = await page.locator('.chart-host').boundingBox()
  const pane = await page.evaluate(() => (window as any).__trainerChart.panes()[0])
  return { x: box!.x + pane.width * x, y: box!.y + pane.height * y }
}

test('中括号双向循环周期并隔离输入、自定义和未完成画线', async ({ page }) => {
  await open(page)
  for (const [key, names] of [['BracketRight', ['周K', '月K', '日K']], ['BracketLeft', ['月K', '周K', '日K']]] as const) {
    for (const name of names) {
      await page.keyboard.press(key)
      await expect(page.locator('.timeframe-tabs button.selected')).toHaveText(name)
      await expect(page.locator('.loading-dot')).not.toBeVisible()
    }
  }
  const input = page.getByPlaceholder('自定义%')
  await input.focus()
  await page.keyboard.press('BracketRight')
  await expect(page.locator('.timeframe-tabs button.selected')).toHaveText('日K')
  await page.locator('.tool-customize-toggle').click()
  await page.keyboard.press('BracketLeft')
  await expect(page.locator('.timeframe-tabs button.selected')).toHaveText('日K')
  await page.locator('.tool-customize-toggle').click()
  await choose(page, 'segment')
  await page.keyboard.press('BracketRight')
  await expect(page.locator('.timeframe-tabs button.selected')).toHaveText('日K')
  await page.keyboard.press('Escape')
  await shot(page, 'keyboard-cycle')
})

test('840根真实可视范围、历史供给与纯黑主副图', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const id = await open(page)
  const bars = (await (await page.request.get(`/api/trainings/${id}/bars?tf=1D`)).json()).bars
  expect(bars).toHaveLength(1040)
  expect(bars.every((bar: any) => bar.date <= '2025-01-02')).toBe(true)
  for (let i = 0; i < 13; i++) await page.keyboard.press('ArrowDown')
  await expect(page.locator('.view-count')).toContainText('840 / 840')
  const range = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  expect(range.to - range.from).toBeGreaterThanOrEqual(838)
  expect(range.to - range.from).toBeLessThanOrEqual(840)
  for (const selector of ['.chart-host', '.chart-wrap', '.chart-panel', '.trade-marker-rail']) {
    expect(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)')
  }
  await shot(page, '840-black-1280')
  const narrowWidth = await page.locator('.chart-host').evaluate(el => el.clientWidth)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.viewportMetrics().width)).toBeGreaterThan(narrowWidth + 400)
  await page.waitForTimeout(350)
  await expect.poll(() => page.evaluate(() => { const range = (window as any).__trainerChart.visibleRange(); return range.to - range.from })).toBeLessThanOrEqual(840)
  await shot(page, '840-black-1920')
  await page.keyboard.press('Home')
  await expect(page.locator('.view-count')).toContainText('/ 840')
  await shot(page, 'black-1920')
})

test('诅咒线仅保留第二点起始的50%右向射线，编辑与刷新恢复', async ({ page }) => {
  test.setTimeout(60_000)
  const id = await open(page)
  await page.getByRole('combobox', { name: '吸附', exact: true }).selectOption('normal')
  await choose(page, 'curseLine')
  const a = await point(page, .3, .3), b = await point(page, .65, .7)
  await page.mouse.click(a.x, a.y)
  await page.mouse.click(b.x, b.y)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.drawings().length)).toBe(1)
  const drawing = await page.evaluate(() => (window as any).__trainerChart.drawings()[0])
  expect(drawing.name).toBe('curseLine')
  const geometry = await page.evaluate(() => (window as any).__trainerChart.geometry()[0])
  expect(geometry.segs).toHaveLength(1)
  expect(geometry.segs[0][0].x).toBe(geometry.anchors[1].x)
  const mean = (drawing.points[0].value + drawing.points[1].value) / 2
  const expected = await page.evaluate(({ timestamp, value }) => (window as any).__trainerChart.pointToPixel(timestamp, value), { timestamp: drawing.points[1].timestamp, value: mean })
  // The library rounds each projected endpoint; averaging them may differ by half a pixel.
  expect(Math.abs(geometry.segs[0][0].y - expected.y)).toBeLessThanOrEqual(0.5)
  expect(geometry.segs[0][1].x).toBeGreaterThan(geometry.segs[0][0].x)
  const box = await page.locator('.chart-host').boundingBox()
  await page.mouse.click(box!.x + geometry.segs[0][0].x + 35, box!.y + geometry.segs[0][0].y, { button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: '编辑划线', exact: true }).click()
  await page.locator('.overlay-edit-panel input[type="number"]').first().fill('1800')
  await page.locator('.overlay-edit-panel').getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  const saved = (await (await page.request.get(`/api/trainings/${id}/drawings`)).json()).drawings
  expect(saved[0].points[0].value).toBe(1800)
  await page.reload()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.drawings())).toEqual(saved)
  await choose(page, 'priceLine')
  const p = await point(page, .4, .65)
  await page.mouse.click(p.x, p.y)
  await page.mouse.move(20, 20)
  await shot(page, 'curse-price-labels')
})

test('频繁成交聚合标记不覆盖主副图与时间轴，颜色明细正确', async ({ page }) => {
  test.setTimeout(90_000)
  const id = await open(page)
  for (let i = 0; i < 20; i++) expect((await page.request.post(`/api/trainings/${id}/trade`, { data: { side: 'buy', weightPct: 1 } })).ok()).toBe(true)
  expect((await page.request.post(`/api/trainings/${id}/next`)).ok()).toBe(true)
  for (let i = 0; i < 20; i++) expect((await page.request.post(`/api/trainings/${id}/trade`, { data: { side: 'sell', shares: 100 } })).ok()).toBe(true)
  await page.reload()
  await expect(page.locator('.trade-marker-badge')).toHaveCount(2)
  const chart = await page.locator('.chart-wrap').boundingBox()
  const badges = await page.locator('.trade-marker-badge').evaluateAll(elements => elements.map(el => {
    const box = el.getBoundingClientRect()
    return { y: box.y, x: box.x, right: box.right, side: el.getAttribute('data-side'), count: Number(el.getAttribute('data-count')), color: getComputedStyle(el).backgroundColor, title: el.getAttribute('title') }
  }))
  for (const badge of badges) { expect(badge.y).toBeGreaterThanOrEqual(chart!.y + chart!.height); expect(badge.count).toBe(20); expect(badge.title).toContain('20 笔') }
  expect(badges.find(b => b.side === 'buy')!.color).toBe('rgb(232, 137, 24)')
  expect(badges.find(b => b.side === 'sell')!.color).toBe('rgb(36, 166, 217)')
  await page.keyboard.press('BracketRight')
  await expect(page.locator('.timeframe-tabs button.selected')).toHaveText('周K')
  await expect(page.locator('.trade-marker-badge')).toHaveCount(2)
  await page.mouse.move(20, 20)
  await shot(page, 'dense-trades')
  for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(350)
    await expect(page.locator('.trade-marker-badge')).toHaveCount(2)
    const rail = await page.locator('.trade-marker-rail').boundingBox()
    const markerBoxes = await page.locator('.trade-marker-badge').evaluateAll(elements => elements.map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })))
    for (const box of markerBoxes) { expect(box.left).toBeGreaterThanOrEqual(rail!.x); expect(box.right).toBeLessThanOrEqual(rail!.x + rail!.width) }
  }
})
