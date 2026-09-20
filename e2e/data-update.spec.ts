import { expect, test, type Page } from '@playwright/test'

// 日线数据更新 e2e：全部 /api/data/* 用 page.route mock（不依赖服务端真实实现），
// /api/env、/api/trainings/active、/api/stocks、POST /api/trainings 一并 mock 保证与
// 隔离服务端的真实数据解耦。断言纪律：可见性用 toBeVisible，真实点击真实事件。

// /api/data/status 契约样例（与服务端 R1 契约一致）
function statusPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'unchanged',
    needsUpdate: false,
    reason: '本地数据与数据源一致',
    source: { kind: 'tdx', name: '通达信本地数据', available: true },
    tdx: { available: true, root: 'C:/new_tdx' },
    online: { configured: false, provider: null },
    sourceMaxDate: '2026-09-15',
    lastCheckedAt: '2026-09-16T09:00:00.000Z',
    lastResult: null,
    revisionWarning: null,
    ...overrides,
  })
}

async function installBaseMocks(page: Page): Promise<void> {
  await page.route('**/api/env', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', tdxRoot: 'C:/new_tdx', dataCutoff: '2026-09-15', stockCount: 5321, capabilities: {}, activeTrainingId: null }),
  }))
  await page.route('**/api/trainings/active', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ training: null }),
  }))
  await page.route('**/api/stocks?**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ code: '600519', market: 'sh', name: '贵州茅台', bars: 8200, lastDate: '2026-09-15' }], total: 1 }),
  }))
  await page.route('**/api/trainings', route => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ training: { id: 77, tier: '3M', code: '600519', name: '贵州茅台', market: 'sh', startDate: '2026-09-16', plannedEnd: '2026-12-16', currentDate: null, status: 'running', settleDate: null, earlySettle: false, blind: false, adjustMode: 'forward', initialCash: 1000000, createdAt: '2026-09-16T01:00:00.000Z' } }),
  }))
}

test('a) needsUpdate 时顶栏出现摇晃的"更新日线"醒目按钮＋截止日小字，窄屏不横向溢出', async ({ page }) => {
  await installBaseMocks(page)
  await page.route('**/api/data/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: statusPayload({ state: 'unchanged', needsUpdate: true, reason: '数据源已有 2026-09-16 的日线' }),
  }))
  await page.goto('/')
  const button = page.locator('.data-update-btn.attention')
  await expect(button).toBeVisible()
  await expect(button).toHaveClass(/shake/)
  await expect(button).toHaveText('更新日线')
  await expect(page.locator('.data-status-note')).toBeVisible()
  await expect(page.locator('.data-status-note')).toHaveText('截止 2026-09-15')
  // 布局红线抽查：840/1024/1440/1920 四档宽度都不得横向溢出
  for (const width of [840, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(overflow, `${width}px 宽出现横向溢出`).toBe(false)
  }
})

test('b) 点击更新 → POST refresh 被调用 → 更新中禁用态 → updated 后按钮隐藏并显示"数据已最新"', async ({ page }) => {
  await installBaseMocks(page)
  let refreshCalls = 0
  let statusPhase: 'initial' | 'running' | 'done' = 'initial'
  await page.route('**/api/data/refresh', route => {
    refreshCalls++
    void route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-1', state: 'running', joined: false }) })
  })
  await page.route('**/api/data/status', route => {
    const body = statusPhase === 'initial'
      ? statusPayload({ state: 'unchanged', needsUpdate: true, reason: '数据源已有新日线' })
      : statusPhase === 'running'
        ? statusPayload({ state: 'running', needsUpdate: true, reason: '更新任务进行中' })
        : statusPayload({
            state: 'updated', needsUpdate: false,
            lastResult: { finishedAt: '2026-09-16T09:30:00.000Z', outcome: 'updated', added: 5321, removed: 0, revised: 12, message: '已更新到 2026-09-16，新增 5321 根' },
          })
    void route.fulfill({ status: 200, contentType: 'application/json', body })
  })
  await page.goto('/')
  const button = page.locator('.data-update-btn.attention')
  await expect(button).toBeVisible()
  statusPhase = 'running'
  await button.click()
  await expect.poll(() => refreshCalls).toBe(1)
  // 进入更新中：禁用态按钮（running 分支），不摇晃
  const runningButton = page.locator('.data-update-btn.running')
  await expect(runningButton).toBeVisible()
  await expect(runningButton).toBeDisabled()
  await expect(runningButton).toContainText('更新中')
  // 模拟任务完成：下一次轮询返回 updated
  statusPhase = 'done'
  const okRow = page.locator('.data-status-ok')
  await expect(okRow).toBeVisible()
  await expect(okRow).toHaveText(/数据已最新 · 截止 2026-09-15/)
  await expect(page.locator('.data-update-btn')).toHaveCount(0)
})

test('c) 已最新初始态：更新按钮不渲染，只显示绿点＋"数据已最新 · 截止"一行小字', async ({ page }) => {
  await installBaseMocks(page)
  await page.route('**/api/data/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: statusPayload(),
  }))
  await page.goto('/')
  const okRow = page.locator('.data-status-ok')
  await expect(okRow).toBeVisible()
  await expect(okRow).toContainText('数据已最新 · 截止 2026-09-15')
  await expect(page.locator('.data-update-btn')).toHaveCount(0)
  // 数据已最新时开始训练零打扰：点击直接创建，不弹确认框
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  let createCalls = 0
  await page.route('**/api/trainings', route => { createCalls++; void route.continue() })
  await page.getByRole('button', { name: '开始训练' }).click()
  await expect(page.locator('.data-confirm-panel')).toHaveCount(0)
  await expect.poll(() => createCalls).toBe(1)
})

test('d) needsUpdate 时点开始训练弹确认框：仍要开始训练照常创建；先更新数据只触发 refresh 不创建', async ({ page }) => {
  await installBaseMocks(page)
  await page.route('**/api/data/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: statusPayload({ state: 'unchanged', needsUpdate: true, reason: '数据源已有新日线' }),
  }))
  let refreshCalls = 0
  let createCalls = 0
  await page.route('**/api/data/refresh', route => {
    refreshCalls++
    void route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-2', state: 'running', joined: false }) })
  })
  await page.route('**/api/trainings', route => {
    createCalls++
    void route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ training: { id: 78, tier: '3M', code: '600519', name: '贵州茅台', market: 'sh', startDate: '2026-09-16', plannedEnd: '2026-12-16', currentDate: null, status: 'running', settleDate: null, earlySettle: false, blind: false, adjustMode: 'forward', initialCash: 1000000, createdAt: '2026-09-16T01:00:00.000Z' } }),
    })
  })
  await page.goto('/')
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.getByRole('button', { name: '开始训练' }).click()
  const dialog = page.locator('.data-confirm-panel')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('建议先更新日线数据')
  await expect(dialog).toContainText('本地日线数据截止 2026-09-15')
  // 次按钮【仍要开始训练】：创建请求照常发出
  await page.getByRole('button', { name: '仍要开始训练' }).click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(() => createCalls).toBe(1)
  expect(refreshCalls).toBe(0)
  // 再次开始训练 → 弹窗 →【先更新数据】：refresh 被调用且不发创建请求
  await page.getByRole('button', { name: '开始训练' }).click()
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: '先更新数据' }).click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(() => refreshCalls).toBe(1)
  await page.waitForTimeout(500)
  expect(createCalls).toBe(1)
})

test('e) 无可用来源：中性警示按钮，点击后 409 中文原因行内展示（不用 alert）', async ({ page }) => {
  await installBaseMocks(page)
  await page.route('**/api/data/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: statusPayload({
      state: 'idle', needsUpdate: true,
      source: { kind: 'none', name: '无可用来源', available: false },
      tdx: { available: false, root: null },
      online: { configured: false, provider: null },
    }),
  }))
  let refreshCalls = 0
  await page.route('**/api/data/refresh', route => {
    refreshCalls++
    void route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: '未检测到可用的日线数据来源：请先安装通达信并完成盘后下载' }) })
  })
  await page.goto('/')
  const unavailable = page.locator('.data-update-btn.unavailable')
  await expect(unavailable).toBeVisible()
  await expect(unavailable).toHaveText('未检测到通达信数据')
  await unavailable.click()
  const errorLine = page.locator('.data-refresh-error')
  await expect(errorLine).toBeVisible()
  await expect(errorLine).toHaveText('未检测到可用的日线数据来源：请先安装通达信并完成盘后下载')
  expect(refreshCalls).toBe(1)
})
