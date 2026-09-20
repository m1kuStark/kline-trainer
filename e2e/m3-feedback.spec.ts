import { evidencePath } from './runtime'
import { startTrainingFromForm, settleThroughConfirmation } from './training-flow'
import { test, expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const runtimeErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => { const errors: string[] = []; runtimeErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)) })
test.afterEach(({ page }) => { expect(runtimeErrors.get(page) ?? []).toEqual([]) })

const screenshot = (page: Page, name: string) => page.screenshot({ path: evidencePath(`feedback-${name}.png`) })
async function open(page: Page): Promise<void> {
  await page.goto('/')
  const active = await (await page.request.get('/api/trainings/active')).json()
  if (active.training) await page.request.post(`/api/trainings/${active.training.id}/abandon`)
  await page.goto('/')
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.locator('input[type="date"]').fill('2026-09-01')
  await startTrainingFromForm(page)
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  await page.getByRole('combobox', { name: '吸附', exact: true }).selectOption('normal')
}
const favorites = (page: Page) => page.locator('.favorite-tools [data-tool-name]').evaluateAll(elements => elements.map(element => element.getAttribute('data-tool-name')))
async function tool(page: Page, name: string): Promise<void> {
  const button = page.locator(`[data-tool-name="${name}"]`)
  if (!await button.isVisible()) await page.locator('.other-tools-toggle').click()
  await button.click()
}
async function draw(page: Page, name = 'segment', y = .5): Promise<void> {
  await tool(page, name)
  const box = await page.locator('.chart-host').boundingBox()
  const pane = await page.evaluate(() => (window as any).__trainerChart.panes().find((p: any) => p.name === 'candle_pane'))
  await page.mouse.click(box!.x + pane.width * .3, box!.y + pane.height * y)
  await page.waitForTimeout(550)
  await page.mouse.click(box!.x + pane.width * .65, box!.y + pane.height * (y - .15))
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.mode().draw)).toBeNull()
}
async function dims(page: Page) {
  return page.evaluate(() => ['.draw-toolbar', '.console-scroll', '.drawing-save-footer', '.toolbar-tool-lists'].map(selector => {
    const element = document.querySelector(selector)! as HTMLElement
    const rect = element.getBoundingClientRect()
    return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollTop: element.scrollTop }
  }))
}
test('常用工具拖入移出排序刷新恢复，自定义模式隔离绘图交易', async ({ page }) => {
  test.setTimeout(90_000)
  await open(page)
  await expect(page.locator('.other-tools')).not.toBeVisible()
  await expect(page.locator('[data-tool-name="segment"]')).toHaveAttribute('draggable', 'false')
  const before = await favorites(page)
  await page.locator('.tool-customize-toggle').click()
  await expect(page.locator('.other-tools')).toBeVisible()
  const meta = await page.locator('.training-current-date').innerText()
  await page.locator('.trade-action.buy').focus()
  await page.keyboard.press('b')
  await page.keyboard.press('Space')
  expect(await page.locator('.training-current-date').innerText()).toBe(meta)
  await page.locator('.other-tools [data-tool-name="rectangle"]').dragTo(page.locator('.favorite-tools [data-tool-name="segment"]'), { targetPosition: { x: 3, y: 14 } })
  await expect.poll(() => favorites(page)).toEqual(['rectangle', ...before])
  await page.locator('.favorite-tools [data-tool-name="rayLine"]').dragTo(page.locator('.favorite-tools [data-tool-name="rectangle"]'), { targetPosition: { x: 3, y: 14 } })
  await expect.poll(async () => (await favorites(page))[0]).toBe('rayLine')
  await page.locator('.favorite-tools [data-tool-name="rectangle"]').dragTo(page.locator('.other-tools'))
  await expect.poll(() => favorites(page)).not.toContain('rectangle')
  await screenshot(page, 'customizing')
  const saved = await favorites(page)
  await page.locator('.tool-customize-toggle').click()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.drawings())).toEqual([])
  await page.reload()
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  expect(await favorites(page)).toEqual(saved)
  await expect(page.locator('.other-tools')).not.toBeVisible()
  await screenshot(page, 'favorites-restored')
})

test('自动保存待保存进行中失败重试成功不改变工具区或账户区位置', async ({ page }) => {
  test.setTimeout(60_000)
  await open(page)
  const active = await (await page.request.get('/api/trainings/active')).json()
  const pattern = `**/api/trainings/${active.training.id}/drawings`
  let release!: () => void
  await page.route(pattern, async route => {
    if (route.request().method() === 'PUT') {
      await new Promise<void>(resolve => { release = resolve })
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '模拟保存错误' }) })
    } else await route.continue()
  })
  await draw(page)
  await expect(page.locator('.drawing-save-status')).toHaveText('待保存')
  const expected = await dims(page)
  await expect(page.locator('.drawing-save-status')).toHaveText('保存中')
  expect(await dims(page)).toEqual(expected)
  await expect.poll(() => Boolean(release)).toBe(true)
  release()
  await expect(page.locator('.drawing-save-status')).toHaveText('保存失败')
  await expect(page.locator('.drawing-save-status')).toHaveAttribute('title', '模拟保存错误')
  expect(await dims(page)).toEqual(expected)
  await screenshot(page, 'save-error-stable')
  await page.unroute(pattern)
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  expect(await dims(page)).toEqual(expected)
  writeFileSync(evidencePath('M3-feedback-layout.json'), JSON.stringify({ states: ['待保存', '保存中', '保存失败', '重试后已保存'], identicalDimensionsAndScroll: true, measurements: expected }, null, 2))
  // 已结算训练继续查看图表：结束训练确认弹窗真实点击后仍可画线保存
  await settleThroughConfirmation(page, 'chart')
  await draw(page, 'segment', .7)
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  expect((await (await page.request.get(`/api/trainings/${active.training.id}/drawings`)).json()).drawings).toHaveLength(2)
})

test('折叠其他工具扩展账户可视区，双主题多尺寸标签无背景填充', async ({ page }) => {
  test.setTimeout(60_000)
  await open(page)
  const folded = await page.locator('.console-scroll').boundingBox()
  await page.locator('.other-tools-toggle').click()
  const expanded = await page.locator('.console-scroll').boundingBox()
  expect(folded!.height).toBeGreaterThan(expanded!.height)
  await draw(page, 'fibonacciLine', .4)
  await draw(page, 'percentageLine', .8)
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height)
    const host = await page.locator('.chart-wrap').boundingBox()
    const consoleBox = await page.locator('.trade-panel').boundingBox()
    expect(host!.x + host!.width).toBeLessThan(consoleBox!.x)
    await screenshot(page, `expanded-${viewport.width}`)
  }
  await page.locator('.other-tools-toggle').click()
  await screenshot(page, 'folded-dark')
  await page.locator('.theme-toggle').click()
  await screenshot(page, 'folded-light')
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
})
