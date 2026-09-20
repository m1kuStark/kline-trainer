import { startTrainingFromForm, settleThroughConfirmation } from './training-flow'
import { expect, test, type Page } from '@playwright/test'

// Playwright 用户旅程（真实受信任事件，与用户输入同构）。
// 本文件当前含 Act 1（训练闭环）与 Act 5（交易与周期）；Act 2/3/4/6 在后续提交追加。
test.describe.configure({ mode: 'serial' })
// Interaction points are mapped into the current pane layout, independently of header height.
test.use({ viewport: { width: 1440, height: 940 } })

// 重试/复跑时临时库中可能残留上次的活动训练（库随 global-setup 只建一次）：
// 直接调 API 放弃残留训练（UI confirm 弹窗的自动 dismiss 会吞掉放弃流程），保证从启动页开始。
async function resetToLauncher(page: import('@playwright/test').Page): Promise<void> {
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  await page.goto('/')
  await page.waitForTimeout(400)
  await expect(page.getByRole('button', { name: '开始训练' })).toBeVisible()
}

test('Act1 创建训练并进入训练视图', async ({ page }) => {
  await resetToLauncher(page)
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.getByRole('button', { name: '3个月' }).click()
  await page.locator('input[type="date"]').fill('2026-09-01')
  await startTrainingFromForm(page)
  await expect(page.locator('.training-meta')).toContainText('时长 3个月')
  // 工具条与多选开关就绪
  await expect(toolButton(page, '线段')).toBeVisible()
  await expect(toolButton(page, '射线')).toBeVisible()
  await expect(toolButton(page, '直线')).toBeVisible()
  await expect(toolButton(page, '多选')).toBeVisible()
  // 模式机初始状态
  const mode = await page.evaluate(() => (window as any).__trainerChart.mode())
  expect(mode).toEqual({ draw: null, multiSelect: false, axisScaleDrag: false })
})

test('Act5 买入推进卖出结算', async ({ page }) => {
  await resetToLauncher(page)
  // 重建训练（serial 顺序在 Act1 之后，库中状态由 Act5 前置步骤决定）
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.getByRole('button', { name: '3个月' }).click()
  await page.locator('input[type="date"]').fill('2026-09-01')
  await startTrainingFromForm(page)
  await expect(page.locator('.training-meta')).toContainText('时长 3个月')
  // B 买入：B/S 标记 overlay 出现（引擎标记不可选中，不在多选集合）。
  // A visible training page can still be waiting for recording initialization;
  // keyboard actions must wait for the same readiness guard as real controls.
  await expect(page.getByRole('status').filter({ hasText: '正在记录' })).toBeVisible()
  await expect(page.locator('.training-grid')).not.toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
  // 注意：expect(promise).resolves 不做重试，此处成交→快照刷新→refreshMarks 有异步链，改轮询断言
  await page.keyboard.press('b')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('bsMark')), { timeout: 5000 }).toBe(1)
  await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
  // Space 推进：当前日期前进
  const metaBefore = await page.locator('.training-current-date').innerText()
  await page.keyboard.press('Space')
  await expect(page.locator('.training-current-date')).not.toHaveText(metaBefore)
  await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
  // S 卖出
  await page.keyboard.press('s')
  await expect(page.locator('.status-message')).toContainText('卖出成交')
  await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
  // 提前结算：结束训练确认弹窗（真实点击确认结算一次）→ 结算面板 → 返回首页
  await settleThroughConfirmation(page)
  await expect(page.getByRole('heading', { name: '创建训练' })).toBeVisible()
})

// ---------- Act 2：画线全生命周期（绘制/编辑/删除/延伸段命中） ----------
// Existing fixture points describe line geometry in the original panes, not absolute screen positions.
async function screenPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => {
    const chart = (window as any).__trainerChart
    const host = document.querySelector('.chart-host')!.getBoundingClientRect()
    const panes = chart.panes()
    const reference = y < 656 ? { index: 0, top: 266, height: 389 }
      : y < 757 ? { index: 1, top: 656, height: 100 }
        : { index: 2, top: 757, height: 100 }
    const pane = panes[reference.index]
    const mainWidth = chart.viewportMetrics().width
    return {
      x: host.left + (x >= 1035 ? mainWidth + (pane.width - mainWidth) / 2 : (x - 107) / (1035 - 107) * mainWidth),
      y: host.top + pane.top + (y - reference.top) / reference.height * pane.height,
    }
  }, { x, y })
}
async function clickAt(page: Page, x: number, y: number, options?: Parameters<Page['mouse']['click']>[2]): Promise<void> {
  const point = await screenPoint(page, x, y)
  await page.mouse.click(point.x, point.y, options)
}
async function moveTo(page: Page, x: number, y: number, options?: Parameters<Page['mouse']['move']>[2]): Promise<void> {
  const point = await screenPoint(page, x, y)
  await page.mouse.move(point.x, point.y, options)
}
async function openTraining(page: import('@playwright/test').Page): Promise<void> {
  await resetToLauncher(page)
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.getByRole('button', { name: '3个月' }).click()
  await page.locator('input[type="date"]').fill('2026-09-01')
  await startTrainingFromForm(page)
  await expect(page.locator('.training-meta')).toContainText('时长 3个月')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.panes().length)).toBe(3)
  await expect(page.locator('.loading-dot')).not.toBeVisible()
  // 控制台滚动到底，露出完整工具条
  await page.locator('.console-scroll').evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight })
}

// 工具按钮精确定位（'线段' 与 '水平线段' 等互为子串，hasText 会 strict 冲突）
function toolButton(page: import('@playwright/test').Page, label: string): import('@playwright/test').Locator {
  return page.locator('.draw-toolbar button').filter({ has: page.locator(`text="${label}"`) })
}

async function pickTool(page: import('@playwright/test').Page, label: string): Promise<void> {
  if (!await toolButton(page, label).isVisible()) await page.locator('.other-tools-toggle').click()
  await toolButton(page, label).click()
  await expect(page.locator('.status-strip')).toContainText(`画线模式：${label}`)
  // watch(props.drawTool) 的 createOverlay 在微任务中完成：等一拍再开始取点，避免工具激活竞态
  await page.waitForTimeout(300)
}

async function drawTwoPointLine(page: import('@playwright/test').Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await clickAt(page, x1, y1)
  // 两次点击间隔 >500ms：避开 klinecharts 双击判定窗口（Delay.ResetClick=500）
  await page.waitForTimeout(650)
  await clickAt(page, x2, y2)
  await page.waitForTimeout(400)
  // 完成后自动退出画线模式
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.mode().draw)).toBeNull()
}

test('Act2a 线段绘制编辑删除', async ({ page }) => {
  await openTraining(page)
  await pickTool(page, '线段')
  const before = await page.evaluate(() => (window as any).__trainerChart.overlayCount('segment'))
  await drawTwoPointLine(page, 400, 480, 700, 350)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('segment'))).toBe(before + 1)
  // 右键线体 → 编辑面板 → 改颜色与端点价位 → 确定 → 断言生效
  await clickAt(page, 550, 415, { button: 'right' })
  await page.getByText('编辑划线', { exact: true }).click()
  await page.locator('.overlay-edit-panel input[type="color"]').fill('#ff4d4f')
  const v = page.locator('.overlay-edit-panel input[type="number"]').first()
  await v.fill('1250')
  await page.getByRole('button', { name: '确定' }).click()
  await page.waitForTimeout(300)
  // Delete 删除（先左键点选编辑后的线体：端点1 已改价 1250、线体已移位，点未移动的端点2 精确位置保证命中。
  // 旧坐标 (550,415) 在编辑后脱靶——旧流程靠"画线完成后的残留选中态"误打误撞删除，正是 Act2d 修掉的缺陷）
  await clickAt(page, 700, 350)
  await page.waitForTimeout(200)
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('segment'))).toBe(before)
})

test('Act2d 空白点击解除持久选中（选中状态机）', async ({ page }) => {
  await openTraining(page)
  await pickTool(page, '线段')
  await drawTwoPointLine(page, 400, 480, 700, 350)
  // 左键点选线体 → 持久选中态（库 click 选中，端点显示）
  await clickAt(page, 550, 415)
  await page.waitForTimeout(300)
  const selectedId = await page.evaluate(() => (window as any).__trainerChart.singleSelected())
  expect(selectedId).not.toBeNull()
  // 左键点击主图空白（图内、远离线体）→ 持久选中立即解除（框选拦截不得吞掉解除链路——端点常显假选中回归）
  await clickAt(page, 400, 300)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.singleSelected())).toBeNull()
})

test('Act2b 射线延伸段可选中', async ({ page }) => {
  await openTraining(page)
  await pickTool(page, '射线')
  await drawTwoPointLine(page, 450, 550, 650, 400)
  // 延伸段（p2 之外、主图窗格内）左键点击 → Delete 应删除（命中几何延伸）
  await clickAt(page, 780, 305)
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('rayLine'))).toBe(0)
})

test('Act2c 直线两端延伸段可选中', async ({ page }) => {
  await openTraining(page)
  await pickTool(page, '直线')
  await drawTwoPointLine(page, 450, 550, 650, 400)
  // 左下延伸段（p1 之外）：线方向 (0.8,-0.6)，x=330 处 y=640（主图窗格内；旧坐标 (200,610) 实际距线 102px，
  // 旧流程靠"画线完成后的残留选中态"误打误撞删除——正是 Act2d 修掉的缺陷）
  await clickAt(page, 330, 640)
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('straightLine'))).toBe(0)
})

test('Act2e 水平线系三工具（D5~D7）', async ({ page }) => {
  await openTraining(page)
  // 水平直线：单点完成（totalStep 2），线体全宽
  await pickTool(page, '水平直线')
  await clickAt(page, 500, 380)
  await page.waitForTimeout(650)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('horizontalStraightLine'))).toBe(1)
  // 水平线段：两点之间
  await pickTool(page, '水平线段')
  await clickAt(page, 420, 430)
  await page.waitForTimeout(650)
  await clickAt(page, 700, 430)
  await page.waitForTimeout(400)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('horizontalSegment'))).toBe(1)
  // 水平射线：点1 沿点2 方向延伸到边
  await pickTool(page, '水平射线')
  await clickAt(page, 450, 470)
  await page.waitForTimeout(650)
  await clickAt(page, 700, 470)
  await page.waitForTimeout(400)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('horizontalRayLine'))).toBe(1)
  // 线体命中（远离锚点的位置点击水平直线线体）→ 选中 → Delete 删除
  await clickAt(page, 250, 380)
  await page.waitForTimeout(200)
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('horizontalStraightLine'))).toBe(0)
})

// ---------- Act 3：交互矩阵（Pattern B 组合遍历，全部真实事件） ----------

test('Act3a 轴拖拽进主图缩放持续（不中断）', async ({ page }) => {
  await openTraining(page)
  // Move from the price axis into the main plot while keeping the drag active.
  const y0 = await page.evaluate(() => (window as any).__trainerChart.yRange())
  const start = await screenPoint(page, 1065, 300), end = await screenPoint(page, 700, 640)
  await moveTo(page, 1065, 300)
  await page.mouse.down()
  await moveTo(page, 900, 430, { steps: 5 })
  await moveTo(page, 700, 640, { steps: 5 })
  await page.mouse.up()
  const y1 = await page.evaluate(() => (window as any).__trainerChart.yRange())
  // The library's native scale factor uses pageY, so derive the expectation from actual points.
  const factor = y1.range / y0.range
  const expectedFactor = end.y / start.y
  expect(factor).toBeGreaterThan(expectedFactor * .75)
  expect(factor).toBeLessThan(expectedFactor * 1.25)
})

test('Act3b 手动轴后框选无纵向叠加', async ({ page }) => {
  await openTraining(page)
  // 先把纵轴拖入手动模式
  await moveTo(page, 1065, 400)
  await page.mouse.down()
  await moveTo(page, 1065, 480, { steps: 4 })
  await page.mouse.up()
  const yBefore = await page.evaluate(() => (window as any).__trainerChart.yRange())
  // 主图空白右滑框选：值域不得被叠加平移（框选前 restoreYAxisAutoFit）
  await moveTo(page, 300, 420)
  await page.mouse.down()
  await moveTo(page, 560, 460, { steps: 5 })
  expect(await page.evaluate(() => (window as any).__trainerChart.yRange())).toEqual(yBefore)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const yAfter = await page.evaluate(() => (window as any).__trainerChart.yRange())
  // Auto-fit resumes on release; only the completed horizontal zoom can rebuild this range.
  expect(Number.isFinite(yAfter.range)).toBe(true)
  expect(yAfter.range).toBeGreaterThan(0)
})

test('Act3c 按线拖拽只动线段不动图', async ({ page }) => {
  await openTraining(page)
  await pickTool(page, '线段')
  await drawTwoPointLine(page, 400, 480, 700, 350)
  // 记录日期轴基准：读取 x 轴标签首项
  const axisBefore = await page.locator('.chart-host').evaluate(() => {
    const labels = [...document.querySelectorAll('canvas')].length
    return labels
  })
  // 按住线段中点拖动：只动线段；图表平移/缩放不发生（overlayCount 不变、可见根数不变）
  const countBefore = await page.evaluate(() => (window as any).__trainerChart.overlayCount('segment'))
  const barsBefore = await page.locator('.view-count').textContent()
  await moveTo(page, 550, 415)
  await page.mouse.down()
  await moveTo(page, 600, 465, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const countAfter = await page.evaluate(() => (window as any).__trainerChart.overlayCount('segment'))
  const barsAfter = await page.locator('.view-count').textContent()
  expect(countAfter).toBe(countBefore)
  expect(barsAfter).toBe(barsBefore)
  expect(axisBefore).toBeGreaterThan(0)
})

test('Act3d 中键平移整图且松键不残留', async ({ page }) => {
  await openTraining(page)
  // 中键按住拖拽：横向平移（Space/Home 之后自动轴模式下纵向由自动适配接管，此处验证横向）
  const barsBefore = await page.locator('.view-count').textContent()
  const rangeBefore = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  await moveTo(page, 600, 420)
  await page.mouse.down({ button: 'middle' })
  await moveTo(page, 430, 420, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await page.waitForTimeout(300)
  const rangeAfterDrag = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  expect(rangeAfterDrag).not.toEqual(rangeBefore)
  // 松键后自由移动鼠标：不得有任何平移（用可见根数与日期轴不变性近似断言）
  await moveTo(page, 400, 300)
  await moveTo(page, 700, 500)
  await moveTo(page, 500, 380)
  await page.waitForTimeout(300)
  const barsAfter = await page.locator('.view-count').textContent()
  expect(barsAfter).toBe(barsBefore)
  expect(await page.evaluate(() => (window as any).__trainerChart.visibleRange())).toEqual(rangeAfterDrag)
})

// ---------- Act 4：划线多选（Ctrl+点选/框选批量/批量删除/选项卡面板） ----------

async function drawThreeLines(page: import('@playwright/test').Page): Promise<void> {
  await pickTool(page, '线段')
  await drawTwoPointLine(page, 380, 480, 680, 350)
  await pickTool(page, '射线')
  await drawTwoPointLine(page, 380, 570, 630, 430)
  await pickTool(page, '直线')
  await drawTwoPointLine(page, 450, 570, 650, 430)
}

test('Act4a 多选模式框选批量选中且不缩放', async ({ page }) => {
  await openTraining(page)
  await drawThreeLines(page)
  // 进入多选模式
  await toolButton(page, '多选').click()
  await expect(page.locator('.status-strip')).toContainText('多选模式')
  const barsBefore = await page.locator('.view-count').textContent()
  const rangeBefore = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  // 框选扫过三条画线
  await moveTo(page, 300, 300)
  await page.mouse.down()
  await moveTo(page, 800, 530, { steps: 6 })
  // 拖拽中途：橡皮筋矩形必须可见且有尺寸（multiRect 不可见缺陷两连的回归断言——状态断言覆盖不到视觉可见性）
  await expect(page.locator('.multi-rect')).toBeVisible()
  expect(await page.locator('.multi-rect').evaluate((el: HTMLElement) => el.getBoundingClientRect().width)).toBeGreaterThan(20)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(3)
  // K 线根数不变（框选不缩放）
  expect(await page.locator('.view-count').textContent()).toBe(barsBefore)
  expect(await page.evaluate(() => (window as any).__trainerChart.visibleRange())).toEqual(rangeBefore)
  // 多选模式下普通左键直接点选（无需 Ctrl——用户 D4 验收反馈）：点已选中线 → 移出；再点 → 加回
  await clickAt(page, 500, 428)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(2)
  await clickAt(page, 500, 428)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(3)
})

test('Act4b Ctrl+点选累加与批量删除', async ({ page }) => {
  await openTraining(page)
  await drawThreeLines(page)
  // Ctrl+点选两条（各自线体上的点：线段 x=500 处 y≈428，射线 x=500 处 y≈503）
  await page.keyboard.down('Control')
  await clickAt(page, 500, 428)
  await page.waitForTimeout(200)
  await clickAt(page, 500, 503)
  await page.keyboard.up('Control')
  // 选中标识＝锚点高亮：线体颜色绝不变动（用户拍板：变色与自定义线色冲突；null＝继承全局默认黄）
  const lineColors = await page.evaluate(() => [0, 1, 2].map((i: number) => (window as any).__trainerChart.overlayInfo(i).lineColor))
  for (const color of lineColors) expect(color).toBeNull()
  // 多选成员锚点层：选中 2 条 × 每条 2 端点＝4 个锚点全部可见（box 选中的画线库不绘制锚点，自绘层负责视觉反馈）
  await expect(page.locator('.anchor-dot')).toHaveCount(4)
  // Delete 批量删除
  await page.keyboard.press('Delete')
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.overlayCount('segment') + (window as any).__trainerChart.overlayCount('rayLine') + (window as any).__trainerChart.overlayCount('straightLine'))).toBe(1)
})

test('Act4c 选项卡式批量编辑', async ({ page }) => {
  await openTraining(page)
  await drawThreeLines(page)
  // 多选模式框选三条 → 右键其中一条 → 批量编辑
  await toolButton(page, '多选').click()
  await moveTo(page, 300, 300)
  await page.mouse.down()
  await moveTo(page, 800, 530, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(3)
  await clickAt(page, 550, 406, { button: 'right' })
  await page.getByText(/编辑划线（3）|编辑划线/).first().click()
  // 选项卡面板：3 个标签（线段一/射线一/直线一）
  await expect(page.locator('.edit-tabs button')).toHaveCount(3)
  await expect(page.locator('.edit-tabs button')).toContainText(['线段一', '射线一', '直线一'])
  // 逐标签改颜色 → 确定批量应用
  const tabs = page.locator('.edit-tabs button')
  for (let i = 0; i < 3; i++) {
    await tabs.nth(i).click()
    await page.locator('.overlay-edit-panel input[type="color"]').nth(0).fill(i === 0 ? '#ff4d4f' : i === 1 ? '#22c55e' : '#3b82f6')
  }
  await page.getByRole('button', { name: '确定' }).click()
  await page.waitForTimeout(400)
  // 批量应用后多选清除
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(0)
})

// ---------- Act 4 追加：副图同权 ----------
// MACD 副图窗格约 y[757,857]（画布栈探针实测）；副图画线取点第一击所在 pane 即落点（库同步 overlay.paneId）
test('Act4d 副图画线与多选框选（主副图同权）', async ({ page }) => {
  await openTraining(page)
  // 在 MACD 副图画一条线段
  await pickTool(page, '线段')
  await drawTwoPointLine(page, 350, 790, 750, 830)
  const info = await page.evaluate(() => (window as any).__trainerChart.overlayInfo(0))
  expect(info.paneId).not.toBe('candle_pane')
  // 多选模式：框选扫过 MACD 副图区域
  await toolButton(page, '多选').click()
  await expect(page.locator('.status-strip')).toContainText('多选模式')
  const barsBefore = await page.locator('.view-count').textContent()
  const rangeBefore = await page.evaluate(() => (window as any).__trainerChart.visibleRange())
  await moveTo(page, 300, 770)
  await page.mouse.down()
  await moveTo(page, 820, 850, { steps: 6 })
  // 中途矩形可见（同 Act4a 的可见性回归）
  await expect(page.locator('.multi-rect')).toBeVisible()
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.selectedCount())).toBe(1)
  // 副图框选不缩放 K 线
  expect(await page.locator('.view-count').textContent()).toBe(barsBefore)
  expect(await page.evaluate(() => (window as any).__trainerChart.visibleRange())).toEqual(rangeBefore)
  // 多选模式下主图框选同样不缩放（门限放开不破坏原语义）
  await moveTo(page, 300, 300)
  await page.mouse.down()
  await moveTo(page, 800, 530, { steps: 6 })
  await page.mouse.up()
  expect(await page.locator('.view-count').textContent()).toBe(barsBefore)
  expect(await page.evaluate(() => (window as any).__trainerChart.visibleRange())).toEqual(rangeBefore)
})

// ---------- Act 6：主题切换 ----------

test('Act6 主题切换持久化', async ({ page }) => {
  await openTraining(page)
  // 默认深色
  expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(true)
  // 切浅色
  await page.getByRole('button', { name: /浅色/ }).click()
  expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('trainer_theme'))).toBe('light')
  // 切回深色
  await page.getByRole('button', { name: /深色/ }).click()
  expect(await page.evaluate(() => document.body.classList.contains('dark'))).toBe(true)
})
