import { evidencePath } from './runtime'
import { startTrainingFromForm, settleThroughConfirmation } from './training-flow'
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

type Point = { x: number; y: number }
type Drawing = {
  id: string; name: string; paneId: string
  points: Array<{ timestamp: number; value: number }>
  styles?: { line?: { color?: string; size?: number; style?: string }; text?: Record<string, unknown> }
  extendData?: Record<string, unknown>
}
type Geometry = { id: string; name: string; anchors: Point[]; segs: Point[][] }
type Pane = { id: string; name: string; top: number; height: number; left: number; width: number }
type ToolCase = { label: string; name: string; unit: string; points: Point[] }

const evidenceDir = dirname(evidencePath('placeholder.png'))
const runtimeErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(({ page }) => { expect(runtimeErrors.get(page) ?? []).toEqual([]) })

async function openTraining(page: Page): Promise<void> {
  await page.goto('/')
  const active = await page.request.get('/api/trainings/active')
  const { training } = await active.json()
  if (training) await page.request.post(`/api/trainings/${training.id}/abandon`)
  await page.goto('/')
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.getByRole('button', { name: '3个月', exact: true }).click()
  await page.locator('input[type="date"]').fill('2026-09-01')
  await startTrainingFromForm(page)
  await expect(page.locator('.training-meta')).toContainText('时长 3个月')
}

function toolButton(page: Page, label: string) {
  return page.locator('.draw-toolbar').getByRole('button', { name: label, exact: true })
}

async function readyChart(page: Page): Promise<void> {
  await expect(page.locator('.training-current-date')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.loading-dot')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__trainerChart?.drawings))).toBe(true)
  await expect.poll(async () => (await panes(page)).length).toBeGreaterThanOrEqual(3)
  await page.getByRole('combobox', { name: '吸附', exact: true }).selectOption({ label: '关闭' })
  if (!await page.locator('.other-tools').isVisible()) await page.locator('.other-tools-toggle').click()
}

async function drawings(page: Page): Promise<Drawing[]> {
  return page.evaluate(() => (window as any).__trainerChart.drawings())
}

async function panes(page: Page): Promise<Pane[]> {
  return page.evaluate(() => (window as any).__trainerChart.panes())
}

async function geometry(page: Page, id: string): Promise<Geometry> {
  const result = await page.evaluate(id => (window as any).__trainerChart.geometry().find((item: Geometry) => item.id === id), id)
  expect(result, `geometry for ${id}`).toBeTruthy()
  return result
}

async function clientPoint(page: Page, point: Point): Promise<Point> {
  const rect = await page.locator('.chart-host').boundingBox()
  expect(rect).not.toBeNull()
  return { x: rect!.x + point.x, y: rect!.y + point.y }
}

async function panePoint(page: Page, point: Point, paneName = 'candle_pane'): Promise<Point> {
  const pane = (await panes(page)).find(item => item.name === paneName || item.id === paneName)
  expect(pane, `${paneName} pane`).toBeTruthy()
  return clientPoint(page, { x: pane!.left + pane!.width * point.x, y: pane!.top + pane!.height * point.y })
}

async function pickTool(page: Page, label: string): Promise<void> {
  await toolButton(page, label).click()
  await expect(page.locator('.status-strip')).toContainText(`画线模式：${label}`)
  await page.waitForTimeout(80)
}

async function drawTool(page: Page, tool: ToolCase, paneName = 'candle_pane'): Promise<Drawing> {
  const before = await drawings(page)
  await pickTool(page, tool.label)
  // KLineCharts treats clicks within 500 ms as a double-click; each anchor is a distinct user action.
  for (const point of tool.points) {
    const target = await panePoint(page, point, paneName)
    await page.mouse.click(target.x, target.y)
    await page.waitForTimeout(560)
  }
  if (tool.name === 'polyline') {
    const target = await panePoint(page, tool.points.at(-1)!, paneName)
    await page.mouse.click(target.x, target.y, { button: 'right' })
  }
  await expect.poll(async () => (await drawings(page)).length).toBe(before.length + 1)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.mode().draw)).toBeNull()
  const result = (await drawings(page)).find(item => !before.some(existing => existing.id === item.id))!
  expect(result.name).toBe(tool.name)
  expect(result.points).toHaveLength(tool.points.length)
  expect(result.points.every(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.singleSelected())).toBeNull()
  return result
}

async function screenshot(page: Page, name: string, parkPointer = true): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true })
  if (parkPointer) await page.mouse.move(20, 20)
  await page.screenshot({ path: join(evidenceDir, `M3-${name}.png`), fullPage: false })
}

async function clearDrawings(page: Page): Promise<void> {
  page.once('dialog', dialog => dialog.accept())
  await toolButton(page, '清空').click()
  await expect.poll(async () => (await drawings(page)).length).toBe(0)
}

async function clickGeometry(page: Page, drawing: Drawing, button: 'left' | 'right' = 'left'): Promise<void> {
  const shape = await geometry(page, drawing.id)
  const segment = shape.segs.find(points => points.length >= 2)
  const target = segment
    ? { x: (segment[0].x + segment.at(-1)!.x) / 2, y: (segment[0].y + segment.at(-1)!.y) / 2 }
    : shape.anchors[0]
  const client = await clientPoint(page, target)
  await page.mouse.click(client.x, client.y, { button })
}

const segmentTool: ToolCase = { label: '线段', name: 'segment', unit: 'D2', points: [{ x: .3, y: .65 }, { x: .68, y: .35 }] }

test('M3 D6-D7 水平工具改价保持水平且可撤销保存', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  for (const [label, name] of [['水平线段', 'horizontalSegment'], ['水平射线', 'horizontalRayLine']]) {
    const original = await drawTool(page, { label, name, unit: 'D6-D7', points: [{ x: .35, y: .5 }, { x: .7, y: .5 }] })
    await clickGeometry(page, original, 'right')
    await page.locator('.ctx-menu').getByRole('button', { name: '编辑划线', exact: true }).click()
    const prices = page.locator('.overlay-edit-panel input[type="number"]')
    await expect(prices).toHaveCount(1)
    const price = Number((original.points[0].value + 10).toFixed(2))
    await prices.fill(String(price))
    await page.locator('.overlay-edit-panel').getByRole('button', { name: '确定', exact: true }).click()
    await expect.poll(async () => (await drawings(page))[0].points.map(point => point.value)).toEqual([price, price])
    await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
    await toolButton(page, '撤销').click()
    await expect.poll(() => drawings(page)).toEqual([original])
    await clearDrawings(page)
  }
})

test('M3 工具清单与默认吸附', async ({ page }) => {
  await openTraining(page)
  await page.locator('.other-tools-toggle').click()
  const labels = ['线段', '射线', '直线', '水平直线', '水平线段', '水平射线',
    '垂直直线', '垂直线段', '垂直射线', '平行直线', '价格通道线', '斐波那契线',
    '画笔', '价位线', '矩形', '圆圈', '圆弧', '箭头线', '看涨箭头', '看跌箭头',
    '百分比线', '文本', '撤销', '重做', '清空', '多选']
  for (const label of labels) await expect(toolButton(page, label)).toBeVisible()
  await expect(page.getByRole('combobox', { name: '吸附', exact: true })).toHaveValue('weak_magnet')
  await screenshot(page, 'D1-toolbar')
})

test('M3 D2-D13 线系与通道工具逐项绘制', async ({ page }) => {
  test.setTimeout(120_000)
  await openTraining(page)
  await readyChart(page)
  const tools: ToolCase[] = [
    segmentTool,
    { ...segmentTool, label: '射线', name: 'rayLine', unit: 'D3' },
    { ...segmentTool, label: '直线', name: 'straightLine', unit: 'D4' },
    { label: '水平直线', name: 'horizontalStraightLine', unit: 'D5', points: [{ x: .45, y: .48 }] },
    { label: '水平线段', name: 'horizontalSegment', unit: 'D6', points: [{ x: .3, y: .5 }, { x: .7, y: .5 }] },
    { label: '水平射线', name: 'horizontalRayLine', unit: 'D7', points: [{ x: .4, y: .5 }, { x: .65, y: .5 }] },
    { label: '垂直直线', name: 'verticalStraightLine', unit: 'D8', points: [{ x: .5, y: .45 }] },
    { label: '垂直线段', name: 'verticalSegment', unit: 'D9', points: [{ x: .5, y: .3 }, { x: .5, y: .7 }] },
    { label: '垂直射线', name: 'verticalRayLine', unit: 'D10', points: [{ x: .5, y: .6 }, { x: .5, y: .35 }] },
    { label: '平行直线', name: 'parallelStraightLine', unit: 'D11', points: [{ x: .3, y: .55 }, { x: .65, y: .35 }, { x: .45, y: .7 }] },
    { label: '价格通道线', name: 'priceChannelLine', unit: 'D12', points: [{ x: .3, y: .5 }, { x: .65, y: .35 }, { x: .45, y: .65 }] },
    { label: '斐波那契线', name: 'fibonacciLine', unit: 'D13', points: [{ x: .3, y: .25 }, { x: .7, y: .7 }] },
  ]
  for (const tool of tools) {
    await test.step(tool.label, async () => {
      const drawing = await drawTool(page, tool)
      const shape = await geometry(page, drawing.id)
      expect(shape.anchors).toHaveLength(tool.points.length)
      expect(shape.segs.length).toBeGreaterThan(0)
      if (tool.name.startsWith('horizontal')) {
        expect(shape.segs.every(points => Math.abs(points[0].y - points.at(-1)!.y) < 1)).toBe(true)
      }
      if (tool.name.startsWith('vertical')) {
        expect(shape.segs.every(points => Math.abs(points[0].x - points.at(-1)!.x) < 1)).toBe(true)
      }
      if (tool.name === 'parallelStraightLine' || tool.name === 'priceChannelLine') {
        expect(shape.segs.length).toBeGreaterThanOrEqual(2)
        const slopes = shape.segs.map(points => (points.at(-1)!.y - points[0].y) / (points.at(-1)!.x - points[0].x))
        for (const slope of slopes) expect(slope).toBeCloseTo(slopes[0], 5)
      }
      if (tool.name === 'fibonacciLine') expect(shape.segs.length).toBeGreaterThanOrEqual(6)
      await screenshot(page, `${tool.unit}-${tool.name}`)
      await clearDrawings(page)
    })
  }
})

test('M3 D14-D22 折线与自定义图形逐项绘制', async ({ page }) => {
  test.setTimeout(120_000)
  await openTraining(page)
  await readyChart(page)
  const tools: ToolCase[] = [
    { label: '画笔', name: 'polyline', unit: 'D14', points: [{ x: .25, y: .6 }, { x: .4, y: .3 }, { x: .65, y: .55 }] },
    { label: '价位线', name: 'priceLine', unit: 'D15', points: [{ x: .4, y: .5 }] },
    { label: '矩形', name: 'rectangle', unit: 'D16', points: [{ x: .3, y: .3 }, { x: .68, y: .7 }] },
    { label: '圆圈', name: 'circle', unit: 'D17', points: [{ x: .4, y: .4 }, { x: .56, y: .6 }] },
    { label: '圆弧', name: 'arc', unit: 'D18', points: [{ x: .3, y: .6 }, { x: .5, y: .28 }, { x: .7, y: .6 }] },
    { label: '箭头线', name: 'arrowLine', unit: 'D19', points: [{ x: .3, y: .65 }, { x: .65, y: .3 }] },
    { label: '看涨箭头', name: 'bullArrow', unit: 'D20', points: [{ x: .5, y: .5 }] },
    { label: '看跌箭头', name: 'bearArrow', unit: 'D21', points: [{ x: .5, y: .5 }] },
    { label: '百分比线', name: 'percentageLine', unit: 'D22', points: [{ x: .3, y: .25 }, { x: .7, y: .7 }] },
  ]
  for (const tool of tools) {
    await test.step(tool.label, async () => {
      const drawing = await drawTool(page, tool)
      const shape = await geometry(page, drawing.id)
      expect(shape.anchors).toHaveLength(tool.points.length)
      expect(shape.segs.length).toBeGreaterThan(0)
      if (tool.name === 'rectangle') expect(shape.segs).toHaveLength(4)
      if (tool.name === 'polyline') expect(shape.segs).toHaveLength(2)
      if (tool.name === 'percentageLine') {
        expect(shape.segs).toHaveLength(5)
        const levels = shape.segs.map(points => points[0].y).sort((a, b) => a - b)
        for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeCloseTo((levels[4] - levels[0]) / 4, 4)
      }
      await screenshot(page, `${tool.unit}-${tool.name}`)
      await clearDrawings(page)
    })
  }
})

test('M3 D6-D10 有限线段边界与反向射线命中', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  const horizontal = await drawTool(page, { label: '水平线段', name: 'horizontalSegment', unit: 'D6', points: [{ x: .35, y: .45 }, { x: .65, y: .45 }] })
  let shape = await geometry(page, horizontal.id)
  const outside = await clientPoint(page, { x: Math.min(...shape.anchors.map(point => point.x)) - 35, y: shape.anchors[0].y })
  expect(await page.evaluate(point => (window as any).__trainerChart.hitTest(point.x, point.y), outside)).toBeNull()
  await clickGeometry(page, horizontal)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.singleSelected())).toBe(horizontal.id)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await drawings(page)).length).toBe(0)
  const ray = await drawTool(page, { label: '水平射线', name: 'horizontalRayLine', unit: 'D7', points: [{ x: .62, y: .5 }, { x: .42, y: .5 }] })
  shape = await geometry(page, ray.id)
  const left = await clientPoint(page, { x: shape.anchors[1].x - 60, y: shape.anchors[0].y })
  const right = await clientPoint(page, { x: shape.anchors[0].x + 40, y: shape.anchors[0].y })
  expect(await page.evaluate(point => (window as any).__trainerChart.hitTest(point.x, point.y), left)).toBe(ray.id)
  expect(await page.evaluate(point => (window as any).__trainerChart.hitTest(point.x, point.y), right)).toBeNull()
  await page.mouse.click(left.x, left.y)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await drawings(page)).length).toBe(0)
  const vertical = await drawTool(page, { label: '垂直射线', name: 'verticalRayLine', unit: 'D10', points: [{ x: .5, y: .6 }, { x: .5, y: .4 }] })
  shape = await geometry(page, vertical.id)
  const up = await clientPoint(page, { x: shape.anchors[0].x, y: shape.anchors[1].y - 40 })
  const down = await clientPoint(page, { x: shape.anchors[0].x, y: shape.anchors[0].y + 35 })
  expect(await page.evaluate(point => (window as any).__trainerChart.hitTest(point.x, point.y), up)).toBe(vertical.id)
  expect(await page.evaluate(point => (window as any).__trainerChart.hitTest(point.x, point.y), down)).toBeNull()
  await screenshot(page, 'D7-D10-reverse-rays')
})

test('M3 D26-D29 编辑移动撤销重做删除清空保留交易标记', async ({ page }) => {
  test.setTimeout(90_000)
  await openTraining(page)
  await readyChart(page)
  await page.keyboard.press('b')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('bsMark'))).toBe(1)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('costLine'))).toBe(1)
  const created = await drawTool(page, segmentTool)
  await toolButton(page, '撤销').click()
  await expect.poll(async () => (await drawings(page)).length).toBe(0)
  await toolButton(page, '重做').click()
  await expect.poll(() => drawings(page)).toEqual([created])
  await clickGeometry(page, created, 'right')
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await page.locator('.ctx-menu').getByRole('button', { name: '编辑划线', exact: true }).click()
  const panel = page.locator('.overlay-edit-panel')
  await expect(panel).toBeVisible()
  await panel.locator('input[type="color"]').fill('#ff4d4f')
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(await drawings(page)).toEqual([created])
  await clickGeometry(page, created, 'right')
  await page.locator('.ctx-menu').getByRole('button', { name: '编辑划线', exact: true }).click()
  const newValue = Number((created.points[0].value + 12).toFixed(2))
  await panel.locator('input[type="color"]').fill('#ff4d4f')
  await panel.locator('select').nth(0).selectOption('3')
  await panel.locator('select').nth(1).selectOption('solid')
  await panel.locator('input[type="number"]').first().fill(String(newValue))
  await screenshot(page, 'D26-edit-panel')
  await panel.getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(async () => (await drawings(page))[0]?.styles?.line?.color).toBe('#ff4d4f')
  const edited = (await drawings(page))[0]
  expect(edited.styles?.line).toMatchObject({ color: '#ff4d4f', size: 3, style: 'solid' })
  expect(edited.points[0].value).toBe(newValue)
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([created])
  await toolButton(page, '重做').click()
  await expect.poll(() => drawings(page)).toEqual([edited])
  const shape = await geometry(page, edited.id)
  const center = await clientPoint(page, { x: (shape.anchors[0].x + shape.anchors[1].x) / 2, y: (shape.anchors[0].y + shape.anchors[1].y) / 2 })
  const rangeBefore = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 35, center.y + 24, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await drawings(page))[0].points).not.toEqual(edited.points)
  expect(await page.evaluate(() => (window as any).__trainerChart.visibleRange())).toEqual(rangeBefore)
  const moved = (await drawings(page))[0]
  const timestampDeltas = moved.points.map((point, i) => point.timestamp - edited.points[i].timestamp)
  expect(timestampDeltas.every(delta => delta !== 0)).toBe(true)
  const valueDeltas = moved.points.map((point, i) => point.value - edited.points[i].value)
  expect(valueDeltas[0]).toBeCloseTo(valueDeltas[1], 6)
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([edited])
  await toolButton(page, '重做').click()
  await expect.poll(() => drawings(page)).toEqual([moved])
  await clickGeometry(page, moved)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await drawings(page)).length).toBe(0)
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([moved])
  page.once('dialog', dialog => dialog.dismiss())
  await toolButton(page, '清空').click()
  expect(await drawings(page)).toEqual([moved])
  await clearDrawings(page)
  expect(await page.evaluate(() => (window as any).__trainerChart.overlayCount('bsMark'))).toBe(1)
  expect(await page.evaluate(() => (window as any).__trainerChart.overlayCount('costLine'))).toBe(1)
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([moved])
  await screenshot(page, 'D29-history-engine-marks')
})

test('M3 D14 取消取点与画线模式热键隔离', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  const meta = await page.locator('.training-current-date').innerText()
  await pickTool(page, '画笔')
  const target = await panePoint(page, { x: .4, y: .4 })
  await page.mouse.click(target.x, target.y)
  await page.keyboard.press('b')
  await page.keyboard.press('s')
  await page.keyboard.press('Space')
  expect(await page.locator('.training-current-date').innerText()).toBe(meta)
  expect(await page.evaluate(() => (window as any).__trainerChart.overlayCount('bsMark'))).toBe(0)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.mode().draw)).toBeNull()
  expect(await drawings(page)).toEqual([])
  await pickTool(page, '矩形')
  await page.mouse.click(target.x, target.y)
  await page.mouse.click(target.x + 30, target.y + 30, { button: 'right' })
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.mode().draw)).toBeNull()
  expect(await drawings(page)).toEqual([])
  await expect(page.locator('.ctx-menu')).not.toBeVisible()
})

test('M3 D23 文本多行样式编辑取消与输入热键隔离', async ({ page }) => {
  test.setTimeout(60_000)
  await openTraining(page)
  await readyChart(page)
  const meta = await page.locator('.training-current-date').innerText()
  await pickTool(page, '文本')
  const target = await panePoint(page, { x: .92, y: .85 })
  await page.mouse.click(target.x, target.y)
  const panel = page.locator('.text-edit-panel')
  await expect(panel).toBeVisible()
  const bounds = await panel.boundingBox()
  const host = await page.locator('.chart-wrap').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(host!.x)
  expect(bounds!.y).toBeGreaterThanOrEqual(host!.y)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(host!.x + host!.width + 1)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(host!.y + host!.height + 1)
  const input = panel.locator('textarea')
  await input.fill('关键区间\n等待确认')
  await input.press('End')
  await input.press('Space')
  await input.press('b')
  await input.press('s')
  await expect(input).toHaveValue('关键区间\n等待确认 bs')
  expect(await page.locator('.training-current-date').innerText()).toBe(meta)
  expect(await page.evaluate(() => (window as any).__trainerChart.overlayCount('bsMark'))).toBe(0)
  await input.fill('关键区间\n等待确认')
  await panel.locator('input[type="color"]').fill('#22c55e')
  await panel.locator('input[type="number"]').fill('20')
  await panel.getByRole('checkbox', { name: '加粗' }).check()
  await panel.getByRole('checkbox', { name: '斜体' }).check()
  await screenshot(page, 'D23-text-panel')
  await panel.getByRole('button', { name: '确定', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await expect.poll(async () => (await drawings(page)).length).toBe(1)
  const text = (await drawings(page))[0]
  expect(text.name).toBe('textAnnotation')
  expect(text.extendData).toMatchObject({ text: '关键区间\n等待确认', color: '#22c55e', size: 20, bold: true, italic: true })
  expect(JSON.stringify(text)).toContain('关键区间\\n等待确认')
  expect(JSON.stringify(text)).toContain('#22c55e')
  const textPane = (await panes(page)).find(item => item.name === 'candle_pane')!
  const textGeometry = await geometry(page, text.id)
  expect(textGeometry.segs.flat().every(point => point.x >= textPane.left && point.x <= textPane.left + textPane.width && point.y >= textPane.top && point.y <= textPane.top + textPane.height)).toBe(true)
  await screenshot(page, 'D23-text-rendered')
  const anchor = await clientPoint(page, (await geometry(page, text.id)).anchors[0])
  await page.mouse.click(anchor.x, anchor.y, { button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: /编辑/ }).click()
  await expect(panel).toBeVisible()
  await expect(input).toHaveValue('关键区间\n等待确认')
  await input.fill('取消的改动')
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(await drawings(page)).toEqual([text])
  await page.mouse.click(anchor.x, anchor.y, { button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: /编辑/ }).click()
  await input.fill('已复核\n保留观察')
  await panel.getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(async () => JSON.stringify((await drawings(page))[0])).toContain('已复核\\n保留观察')
  const editedText = (await drawings(page))[0]
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([text])
  await toolButton(page, '重做').click()
  await expect.poll(() => drawings(page)).toEqual([editedText])
  await pickTool(page, '文本')
  const cancelTarget = await panePoint(page, { x: .3, y: .4 })
  await page.mouse.click(cancelTarget.x, cancelTarget.y)
  await expect(panel).toBeVisible()
  await input.fill('取消的新文本')
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(await drawings(page)).toEqual([editedText])
})

test('M3 D16-D25 形状拖角缩放与悬停指针', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  const rectangle = await drawTool(page, { label: '矩形', name: 'rectangle', unit: 'D16', points: [{ x: .3, y: .3 }, { x: .65, y: .65 }] })
  const shape = await geometry(page, rectangle.id)
  const edge = await clientPoint(page, { x: (shape.anchors[0].x + shape.anchors[1].x) / 2, y: shape.anchors[0].y })
  await page.mouse.move(edge.x, edge.y)
  await expect(page.locator('.chart-host')).toHaveCSS('cursor', 'pointer')
  expect((await drawings(page))[0].styles).toEqual(rectangle.styles)
  const anchor = await clientPoint(page, shape.anchors[1])
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.down()
  await page.mouse.move(anchor.x + 48, anchor.y + 30, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await drawings(page))[0].points[1]).not.toEqual(rectangle.points[1])
  const resized = (await drawings(page))[0]
  expect(resized.points[0]).toEqual(rectangle.points[0])
  const resizedShape = await geometry(page, rectangle.id)
  expect(resizedShape.segs).toHaveLength(4)
  expect(resizedShape.segs.every(points => Math.abs(points[0].x - points[1].x) < 1 || Math.abs(points[0].y - points[1].y) < 1)).toBe(true)
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([rectangle])
  await toolButton(page, '重做').click()
  await expect.poll(() => drawings(page)).toEqual([resized])
  await screenshot(page, 'D16-D25-resize-hover')
})

test('M3 D28 混合形状框选批量删除与撤销', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  await drawTool(page, { label: '矩形', name: 'rectangle', unit: 'D16', points: [{ x: .25, y: .3 }, { x: .4, y: .55 }] })
  await drawTool(page, { label: '箭头线', name: 'arrowLine', unit: 'D19', points: [{ x: .55, y: .65 }, { x: .7, y: .35 }] })
  const before = await drawings(page)
  await toolButton(page, '多选').click()
  const start = await panePoint(page, { x: .15, y: .2 })
  const end = await panePoint(page, { x: .8, y: .75 })
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await expect(page.locator('.multi-rect')).toBeVisible()
  await screenshot(page, 'D28-mixed-selection-box', false)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(2)
  await expect(page.locator('.anchor-dot')).toHaveCount(4)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await drawings(page)).length).toBe(0)
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual(before)
})

test('M3 D24 三态吸附与强吸附开高低收', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  const select = page.getByRole('combobox', { name: '吸附', exact: true })
  const active = await (await page.request.get('/api/trainings/active')).json()
  const { bars } = await (await page.request.get(`/api/trainings/${active.training.id}/bars?tf=1D`)).json()
  await select.selectOption({ label: '强吸附' })
  const snapped = await drawTool(page, { label: '水平直线', name: 'horizontalStraightLine', unit: 'D24', points: [{ x: .52, y: .42 }] })
  const point = snapped.points[0]
  const bar = bars.find((item: { date: string }) => Date.parse(`${item.date}T00:00:00Z`) === point.timestamp)
  expect(bar).toBeTruthy()
  expect(Math.min(...[bar.open, bar.high, bar.low, bar.close].map(value => Math.abs(value - point.value)))).toBeLessThan(1e-6)
  await screenshot(page, 'D24-strong-magnet')
  await clearDrawings(page)
  await select.selectOption({ label: '关闭' })
  const free = await drawTool(page, { label: '水平直线', name: 'horizontalStraightLine', unit: 'D24', points: [{ x: .52, y: .42 }] })
  expect(free.points[0].value).not.toBeCloseTo(point.value, 4)
  await select.selectOption({ label: '弱吸附' })
  await expect(select).toHaveValue('weak_magnet')
})

test('M3 D30-D31 主副图保存刷新与跨周期恢复', async ({ page }) => {
  test.setTimeout(90_000)
  await openTraining(page)
  await readyChart(page)
  await drawTool(page, segmentTool)
  await drawTool(page, { ...segmentTool, points: [{ x: .35, y: .3 }, { x: .7, y: .7 }] }, 'MACD')
  const before = await drawings(page)
  expect(before.find(item => item.paneId !== 'candle_pane')?.paneId).toBe('MACD')
  const active = await (await page.request.get('/api/trainings/active')).json()
  await expect.poll(async () => {
    const response = await page.request.get(`/api/trainings/${active.training.id}/drawings`)
    if (!response.ok()) return []
    return (await response.json()).drawings
  }).toEqual(before)
  await page.reload()
  await readyChart(page)
  await expect.poll(() => drawings(page)).toEqual(before)
  const restored = await geometry(page, before[1].id)
  const macd = (await panes(page)).find(item => item.name === 'MACD')!
  expect(restored.anchors.every(point => point.y >= macd.top && point.y <= macd.top + macd.height)).toBe(true)
  for (const label of ['周K', '月K', '日K']) {
    await page.locator('.timeframe-tabs').getByRole('tab', { name: label, exact: true }).click()
    await expect(page.locator('.timeframe-tabs').getByRole('tab', { name: label, exact: true })).toHaveClass(/selected/)
    await expect(page.locator('.loading-dot')).not.toBeVisible()
    await expect.poll(() => drawings(page)).toEqual(before)
  }
  await screenshot(page, 'D31-main-secondary-restored')
  const beforeRange = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  const start = await panePoint(page, { x: .7, y: .2 })
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(start.x - 160, start.y + 24, { steps: 8 })
  await page.mouse.up({ button: 'middle' })
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.visibleRange())).not.toEqual(beforeRange)
  expect(await drawings(page)).toEqual(before)
  await page.keyboard.press('Home')
  await expect.poll(() => drawings(page)).toEqual(before)
  const historyTarget = await panePoint(page, { x: .5, y: .25 })
  await page.mouse.move(historyTarget.x, historyTarget.y)
  const historyResponse = page.waitForResponse(response => response.url().includes('/bars?') && new URL(response.url()).searchParams.has('before'), { timeout: 15_000 })
  await page.mouse.wheel(0, 6000)
  const older = await historyResponse
  expect(older.ok()).toBe(true)
  expect((await older.json()).bars.length).toBeGreaterThan(0)
  await expect.poll(() => drawings(page)).toEqual(before)
  await page.keyboard.press('Home')
  await screenshot(page, 'D31-history-loaded')
  await page.reload()
  await readyChart(page)
  await expect.poll(() => drawings(page)).toEqual(before)
})

test('M3 D23 取消新文本不污染保存与撤销历史', async ({ page }) => {
  test.setTimeout(60_000)
  await openTraining(page)
  await readyChart(page)
  const line = await drawTool(page, segmentTool)
  const active = await (await page.request.get('/api/trainings/active')).json()
  const drawingUrl = `/api/trainings/${active.training.id}/drawings`
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  expect((await (await page.request.get(drawingUrl)).json()).drawings).toEqual([line])
  await pickTool(page, '文本')
  const target = await panePoint(page, { x: .5, y: .4 })
  await page.mouse.click(target.x, target.y)
  const panel = page.locator('.text-edit-panel')
  await expect(panel).toBeVisible()
  await panel.locator('textarea').fill('这段文本不应保存')
  // Wait beyond autosave while the provisional overlay is still open, then cancel it.
  await page.waitForTimeout(1500)
  expect(await drawings(page)).toEqual([line])
  expect((await (await page.request.get(drawingUrl)).json()).drawings).toEqual([line])
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await page.waitForTimeout(1500)
  expect((await (await page.request.get(drawingUrl)).json()).drawings).toEqual([line])
  await toolButton(page, '撤销').click()
  await expect.poll(() => drawings(page)).toEqual([])
  await toolButton(page, '重做').click()
  await expect.poll(() => drawings(page)).toEqual([line])
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  await page.reload()
  await readyChart(page)
  await expect.poll(() => drawings(page)).toEqual([line])
  expect((await (await page.request.get(drawingUrl)).json()).drawings).toEqual([line])
  await screenshot(page, 'D23-cancel-reload-clean')
})

test('M3 D31 保存失败后立即刷新从本地恢复最新画线', async ({ page }) => {
  test.setTimeout(60_000)
  await openTraining(page)
  await readyChart(page)
  const original = await drawTool(page, segmentTool)
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  const active = await (await page.request.get('/api/trainings/active')).json()
  const drawingUrl = `/api/trainings/${active.training.id}/drawings`
  const pattern = `**${drawingUrl}`
  let failedPuts = 0
  let staleGets = 0
  await page.route(pattern, async route => {
    if (route.request().method() === 'PUT') {
      failedPuts++
      await route.abort('failed')
    } else if (route.request().method() === 'GET') {
      staleGets++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ drawings: [original] }) })
    } else await route.continue()
  })
  try {
    const latest = await drawTool(page, { ...segmentTool, points: [{ x: .35, y: .25 }, { x: .7, y: .5 }] })
    const expected = [original, latest]
    await expect(page.locator('.drawing-save-status')).toHaveText('保存失败')
    expect(failedPuts).toBeGreaterThan(0)
    expect((await (await page.request.get(drawingUrl)).json()).drawings).toEqual([original])
    // Pagehide keepalive can escape page routing; serve stale GET data to isolate local recovery.
    await page.reload()
    await readyChart(page)
    await expect.poll(() => drawings(page)).toEqual(expected)
    expect(staleGets).toBeGreaterThan(0)
    await expect(page.locator('.drawing-save-status')).toHaveText('保存失败')
    await page.unroute(pattern)
    await page.getByRole('button', { name: '重试保存', exact: true }).click()
    await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
    await expect.poll(async () => (await (await page.request.get(drawingUrl)).json()).drawings).toEqual(expected)
    await page.reload()
    await readyChart(page)
    await expect.poll(() => drawings(page)).toEqual(expected)
    await screenshot(page, 'D31-save-failure-recovered')
  } finally {
    await page.unroute(pattern)
  }
})

test('M3 D31 已结算训练继续查看刷新保留画线并返回首页', async ({ page }) => {
  test.setTimeout(60_000)
  await openTraining(page)
  await readyChart(page)
  const line = await drawTool(page, segmentTool)
  const active = await (await page.request.get('/api/trainings/active')).json()
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  // 结束训练确认弹窗真实点击确认结算 → 结算面板继续查看图表
  await settleThroughConfirmation(page, 'chart')
  await expect(page.getByRole('button', { name: '返回首页', exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`[?&]training=${active.training.id}(?:&|$)`))
  await expect.poll(() => drawings(page)).toEqual([line])
  await page.reload()
  await readyChart(page)
  await expect(page.getByRole('button', { name: '返回首页', exact: true })).toBeVisible()
  await expect.poll(() => drawings(page)).toEqual([line])
  await expect(page.getByRole('button', { name: '买入', exact: true })).toBeDisabled()
  await screenshot(page, 'D31-settled-reopened')
  await page.getByRole('button', { name: '返回首页', exact: true }).click()
  await expect(page.getByRole('heading', { name: '创建训练', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.has('training')).toBe(false)
})

test('M3 D31 快速切换周期时过期周线响应不覆盖月线', async ({ page }) => {
  test.setTimeout(60_000)
  await openTraining(page)
  await readyChart(page)
  const line = await drawTool(page, segmentTool)
  const active = await (await page.request.get('/api/trainings/active')).json()
  const monthlyResponse = await page.request.get(`/api/trainings/${active.training.id}/bars?tf=1M`)
  const monthly = (await monthlyResponse.json()).bars as Array<{ date: string; open: number; high: number; low: number; close: number }>
  const expectedBars = monthly.map(bar => ({
    timestamp: Date.parse(`${bar.date.length === 7 ? `${bar.date}-01` : bar.date}T00:00:00Z`),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
  }))
  const chartBars = () => page.evaluate(() => (window as any).__trainerChart.bars().map((bar: { timestamp: number; open: number; high: number; low: number; close: number }) => ({
    timestamp: bar.timestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
  })))
  let releaseWeek!: () => void
  let requestArrived!: () => void
  const heldWeek = new Promise<void>(resolve => { releaseWeek = resolve })
  const weekRequested = new Promise<void>(resolve => { requestArrived = resolve })
  const pattern = `**/api/trainings/${active.training.id}/bars?*`
  await page.route(pattern, async route => {
    if (new URL(route.request().url()).searchParams.get('tf') !== '1W') {
      await route.continue()
      return
    }
    requestArrived()
    const response = await route.fetch()
    await heldWeek
    await route.fulfill({ response })
  })
  try {
    await page.locator('.timeframe-tabs').getByRole('tab', { name: '周K', exact: true }).click()
    await weekRequested
    await page.locator('.timeframe-tabs').getByRole('tab', { name: '月K', exact: true }).click()
    await expect(page.locator('.loading-dot')).not.toBeVisible()
    await expect.poll(chartBars).toEqual(expectedBars)
    const finishedWeek = page.waitForResponse(response => new URL(response.url()).searchParams.get('tf') === '1W')
    releaseWeek()
    await (await finishedWeek).finished()
    await page.waitForTimeout(150)
    await expect(page.locator('.timeframe-tabs').getByRole('tab', { name: '月K', exact: true })).toHaveClass(/selected/)
    expect(await chartBars()).toEqual(expectedBars)
    await expect.poll(() => drawings(page)).toEqual([line])
    await screenshot(page, 'D31-timeframe-latest-response')
  } finally {
    releaseWeek()
    await page.unroute(pattern)
  }
})

test('M3 D28 副图框选不命中主图直线的不可见延伸', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  const line = await drawTool(page, { label: '直线', name: 'straightLine', unit: 'D4', points: [{ x: .4, y: .25 }, { x: .5, y: .7 }] })
  const [a, b] = (await geometry(page, line.id)).anchors
  const macd = (await panes(page)).find(pane => pane.name === 'MACD')!
  const crossY = macd.top + macd.height / 2
  const crossX = a.x + (crossY - a.y) * (b.x - a.x) / (b.y - a.y)
  expect(crossX).toBeGreaterThan(macd.left + 40)
  expect(crossX).toBeLessThan(macd.left + macd.width - 40)
  await toolButton(page, '多选').click()
  const start = await clientPoint(page, { x: crossX - 35, y: macd.top + 10 })
  const end = await clientPoint(page, { x: crossX + 35, y: macd.top + macd.height - 10 })
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await expect(page.locator('.multi-rect')).toBeVisible()
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(0)
  await page.keyboard.press('Delete')
  expect(await drawings(page)).toEqual([line])
  await screenshot(page, 'D28-pane-selection-isolated')
})

test('M3 D31 最新日线锚点跨周月映射到当前聚合柱', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  for (let step = 0; step < 2; step++) {
    await page.getByRole('button', { name: /推进下一日/ }).click()
    await expect(page.locator('.loading-dot')).not.toBeVisible()
  }
  await expect(page.locator('.training-current-date')).toContainText('当前 2026-09-03')
  const daily = await page.evaluate(() => (window as any).__trainerChart.bars().at(-1))
  const pixel = await page.evaluate(({ timestamp, close }) => (window as any).__trainerChart.pointToPixel(timestamp, close), daily)
  const client = await clientPoint(page, pixel)
  await pickTool(page, '水平直线')
  await page.mouse.click(client.x, client.y)
  await expect.poll(async () => (await drawings(page)).length).toBe(1)
  const original = (await drawings(page))[0]
  expect(original.points[0].timestamp).toBe(daily.timestamp)
  for (const label of ['周K', '月K']) {
    await page.locator('.timeframe-tabs').getByRole('tab', { name: label, exact: true }).click()
    await expect(page.locator('.loading-dot')).not.toBeVisible()
    const aggregate = await page.evaluate(() => (window as any).__trainerChart.bars().at(-1))
    const expectedPixel = await page.evaluate(({ timestamp, close }) => (window as any).__trainerChart.pointToPixel(timestamp, close), aggregate)
    await expect.poll(async () => (await geometry(page, original.id)).anchors[0].x).toBeCloseTo(expectedPixel.x, 5)
    expect(await drawings(page)).toEqual([original])
    expect((await drawings(page))[0].points[0].timestamp).toBe(daily.timestamp)
  }
  await screenshot(page, 'D31-latest-anchor-month')
})

test('M3 D32 两种桌面尺寸的布局与圆形比例', async ({ page }) => {
  await openTraining(page)
  await readyChart(page)
  const circle = await drawTool(page, { label: '圆圈', name: 'circle', unit: 'D17', points: [{ x: .4, y: .35 }, { x: .58, y: .6 }] })
  for (const size of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(350)
    const chartBox = await page.locator('.chart-wrap').boundingBox()
    const consoleBox = await page.locator('.trade-panel').boundingBox()
    expect(chartBox!.x + chartBox!.width).toBeLessThanOrEqual(consoleBox!.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height)
    const curve = (await geometry(page, circle.id)).segs.flat()
    const width = Math.max(...curve.map(point => point.x)) - Math.min(...curve.map(point => point.x))
    const height = Math.max(...curve.map(point => point.y)) - Math.min(...curve.map(point => point.y))
    expect(Math.abs(width - height)).toBeLessThan(1)
    await screenshot(page, `D32-desktop-${size.width}x${size.height}`)
  }
})

test('M3 D28 文本线段混选编辑文本颜色内容并刷新恢复', async ({ page }) => {
  test.setTimeout(60_000)
  await openTraining(page)
  await readyChart(page)
  const line = await drawTool(page, segmentTool)
  await pickTool(page, '文本')
  const target = await panePoint(page, { x: .35, y: .28 })
  await page.mouse.click(target.x, target.y)
  const textPanel = page.locator('.text-edit-panel')
  await expect(textPanel).toBeVisible()
  await textPanel.locator('textarea').fill('原始标注')
  await textPanel.getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(async () => (await drawings(page)).length).toBe(2)
  const text = (await drawings(page)).find(item => item.name === 'textAnnotation')!
  await toolButton(page, '多选').click()
  await clickGeometry(page, line)
  await clickGeometry(page, text)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(2)
  await clickGeometry(page, text, 'right')
  await page.locator('.ctx-menu').getByRole('button', { name: /^编辑划线/ }).click()
  const panel = page.locator('.overlay-edit-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.edit-tabs').getByRole('button', { name: /^文本/ }).click()
  await expect(panel.locator('textarea')).toHaveValue('原始标注')
  await panel.locator('input[type="color"]').fill('#3b82f6')
  await panel.locator('textarea').fill('混选修订\n复核完成')
  await panel.getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(async () => (await drawings(page)).find(item => item.id === text.id)?.extendData).toMatchObject({ text: '混选修订\n复核完成', color: '#3b82f6' })
  const saved = await drawings(page)
  expect(saved).toHaveLength(2)
  expect(saved.find(item => item.id === line.id)?.name).toBe('segment')
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  const active = await (await page.request.get('/api/trainings/active')).json()
  expect((await (await page.request.get(`/api/trainings/${active.training.id}/drawings`)).json()).drawings).toEqual(saved)
  await page.reload()
  await readyChart(page)
  await expect.poll(() => drawings(page)).toEqual(saved)
  await screenshot(page, 'D28-mixed-text-edit-restored')
})
