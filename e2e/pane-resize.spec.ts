import { evidencePath } from './runtime'
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

type Pane = { id: string; name: string; top: number; height: number; width: number }
type Point = { x: number; y: number }
const errors = new WeakMap<Page, string[]>()

test.beforeEach(({ page }) => {
  const list: string[] = []
  errors.set(page, list)
  page.on('pageerror', error => list.push(error.message))
})
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]) })

async function openChart(page: Page): Promise<void> {
  const active = await (await page.request.get('/api/trainings/active')).json()
  if (active.training) await page.request.post(`/api/trainings/${active.training.id}/abandon`)
  const response = await page.request.post('/api/trainings', {
    data: { code: '600519', tier: '1Y', start_date: '2025-01-02', initial_cash: 100_000_000 },
  })
  expect(response.status()).toBe(201)
  await page.goto('/')
  await expect(page.locator('.training-current-date')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  await expect(page.locator('.loading-dot')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.panes().length)).toBe(3)
  await page.getByRole('combobox', { name: '吸附', exact: true }).selectOption('normal')
}

async function panes(page: Page): Promise<Pane[]> {
  return page.evaluate(() => (window as any).__trainerChart.panes())
}
async function state(page: Page) {
  return page.evaluate(() => {
    const chart = (window as any).__trainerChart
    return { range: chart.visibleRange(), drawings: chart.drawings(), selected: chart.selectedCount(), mode: chart.mode() }
  })
}
async function mainPoint(page: Page, x: number, y: number): Promise<Point> {
  const box = await page.locator('.chart-host').boundingBox()
  const pane = (await panes(page))[0]
  return { x: box!.x + pane.width * x, y: box!.y + pane.top + pane.height * y }
}
async function drawSegment(page: Page): Promise<void> {
  const button = page.locator('[data-tool-name="segment"]')
  if (!await button.isVisible()) await page.locator('.other-tools-toggle').click()
  await button.click()
  const a = await mainPoint(page, .25, .25), b = await mainPoint(page, .45, .4)
  await page.mouse.click(a.x, a.y)
  await page.mouse.click(b.x, b.y)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.drawings().length)).toBe(1)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.mode().draw)).toBeNull()
}
async function selectSegment(page: Page): Promise<void> {
  const box = await page.locator('.chart-host').boundingBox()
  const point = await page.evaluate(() => {
    const [a, b] = (window as any).__trainerChart.geometry()[0].anchors
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  })
  await page.mouse.click(box!.x + point.x, box!.y + point.y)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(1)
}

// These are the library's real seven-pixel separator widgets, including their hit margins.
function separators(page: Page) { return page.locator('.chart-host div[style*="cursor: ns-resize"][style*="height: 7px"]') }

async function resizePane(page: Page, index: number, dx: number, dy: number, hitY: number, axisSide = false): Promise<void> {
  const before = await state(page)
  const beforeMetrics = await page.evaluate(() => (window as any).__trainerChart.viewportMetrics())
  const sizes = await panes(page)
  const box = await separators(page).nth(index).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThanOrEqual(7)
  const x = box!.x + (axisSide ? box!.width - 5 : box!.width * .58)
  const y = box!.y + hitY
  await page.mouse.move(x, y)
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x, y })).toBe('ns-resize')
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 12 })
  await expect(page.locator('.select-rect')).not.toBeVisible()
  await expect(page.locator('.multi-rect')).not.toBeVisible()
  expect((await state(page)).mode.axisScaleDrag).toBe(false)
  await expect.poll(async () => Math.abs((await panes(page))[index].height - sizes[index].height)).toBeGreaterThan(10)
  await page.mouse.up()
  const afterSizes = await panes(page)
  expect(Math.abs(afterSizes[index + 1].height - sizes[index + 1].height)).toBeGreaterThan(10)
  expect(afterSizes[index].height + afterSizes[index + 1].height).toBeCloseTo(sizes[index].height + sizes[index + 1].height, 5)
  const after = await state(page)
  const afterMetrics = await page.evaluate(() => (window as any).__trainerChart.viewportMetrics())
  expect(afterMetrics.bar, JSON.stringify({ beforeMetrics, afterMetrics })).toBe(beforeMetrics.bar)
  expect({ ...after, range: undefined }).toEqual({ ...before, range: undefined })
  expect(after.range.to).toBe(before.range.to)
  expect(after.range.realTo).toBe(before.range.realTo)
  // Native y-axis labels can change width when pane heights change, exposing at most two edge bars.
  const edgeTolerance = beforeMetrics.width === afterMetrics.width ? 0 : Math.min(2, Math.ceil(Math.abs(afterMetrics.width - beforeMetrics.width) / beforeMetrics.bar) + 1)
  for (const key of ['from', 'realFrom'] as const) {
    expect(Math.abs(after.range[key] - before.range[key]), JSON.stringify({ beforeMetrics, afterMetrics })).toBeLessThanOrEqual(edgeTolerance)
  }
  await page.mouse.move(x + dx + 40, y + dy - 25)
  expect(await state(page)).toEqual(after)
}

async function normalBoxSelect(page: Page): Promise<void> {
  const before = await state(page)
  const a = await mainPoint(page, .55, .55), b = await mainPoint(page, .82, .55)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await expect(page.locator('.select-rect')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.select-rect')).not.toBeVisible()
  await expect.poll(async () => { const { range } = await state(page); return range.to - range.from }).toBeLessThan(before.range.to - before.range.from)
  expect((await state(page)).drawings).toEqual(before.drawings)
}

for (const mode of ['default', 'multi'] as const) {
  for (const [index, name] of ['candle/VOL', 'VOL/MACD'].entries()) {
    test(`${name} separator owns diagonal left/right drags in ${mode} mode`, async ({ page }) => {
      if (mode === 'multi') await page.setViewportSize({ width: 1280, height: 800 })
      await openChart(page)
      await drawSegment(page)
      if (mode === 'multi') {
        await page.locator('.draw-toolbar').getByRole('button', { name: '多选', exact: true }).click()
        await selectSegment(page)
      }
      await resizePane(page, index, -65, -24, 1)
      await resizePane(page, index, 65, 24, 5)
      await resizePane(page, index, 0, -20, 3)
      await page.screenshot({ path: evidencePath(`pane-resize-${index}-${mode}.png`) })
      if (mode === 'multi') await page.locator('.draw-toolbar').getByRole('button', { name: '多选', exact: true }).click()
      await normalBoxSelect(page)
    })
  }
}

test('Ctrl separator drag preserves selection through the right axis side', async ({ page }) => {
  await openChart(page)
  await drawSegment(page)
  await page.keyboard.down('Control')
  await selectSegment(page)
  await resizePane(page, 0, -35, -24, 1, true)
  await resizePane(page, 1, -35, -24, 5, true)
  await page.keyboard.up('Control')
  await normalBoxSelect(page)
})

test('separator drag preserves an active drawing tool and maximized panes remain usable', async ({ page }) => {
  await openChart(page)
  const button = page.locator('[data-tool-name="segment"]')
  if (!await button.isVisible()) await page.locator('.other-tools-toggle').click()
  await button.click()
  await resizePane(page, 0, -35, -24, 1)
  await resizePane(page, 1, 35, -24, 5)
  expect(await page.evaluate(() => (window as any).__trainerChart.viewportMetrics().scrollEnabled)).toBe(false)
  const beforeDrawing = await state(page)
  const a = await mainPoint(page, .25, .25), b = await mainPoint(page, .45, .4)
  await page.mouse.click(a.x, a.y)
  await page.mouse.click(b.x, b.y)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.drawings().length)).toBe(1)
  expect((await state(page)).range).toEqual(beforeDrawing.range)
  expect(await page.evaluate(() => (window as any).__trainerChart.viewportMetrics().scrollEnabled)).toBe(true)
  const host = await page.locator('.chart-host').boundingBox()
  const macd = (await panes(page))[2]
  await page.mouse.dblclick(host!.x + macd.width * .45, host!.y + macd.top + macd.height * .5)
  await expect.poll(async () => (await panes(page))[0].height).toBe(0)
  await page.mouse.dblclick(host!.x + macd.width * .45, host!.y + 100)
  await expect.poll(async () => (await panes(page))[0].height).toBeGreaterThan(0)
  await normalBoxSelect(page)
})
