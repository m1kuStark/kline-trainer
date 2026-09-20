import { expect, type Page } from '@playwright/test'

/** Follow the same explicit choice as a user when local-data freshness is unknown. */
export async function startTrainingFromForm(page: Page): Promise<void> {
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/trainings', { timeout: 30_000 })
  await page.getByRole('button', { name: '开始训练', exact: true }).click()
  const guard = page.getByRole('dialog', { name: '建议先更新日线数据' })
  const training = page.locator('.training-topbar')
  await expect(guard.or(training)).toBeVisible({ timeout: 30_000 })
  if (await guard.isVisible()) {
    await guard.getByRole('button', { name: '仍要开始训练', exact: true }).click()
  }
  expect((await created).status()).toBe(201)
  await expect(training).toBeVisible({ timeout: 30_000 })
}

/**
 * 结束训练走显式确认弹窗（2026-09-19 返修合同行为3）：断言「结束训练」弹窗、
 * 「保留到本机训练历史」默认勾选，真实点击「确认结算」一次后出现结算结果面板，
 * 再真实点击出口按钮。禁止 auto accept 处理器或隐藏旁路。
 */
export async function settleThroughConfirmation(page: Page, after: 'home' | 'chart' = 'home'): Promise<void> {
  await page.getByRole('button', { name: '提前结算', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '结束训练' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: '保留到本机训练历史' })).toBeChecked()
  const confirm = dialog.getByRole('button', { name: '确认结算', exact: true })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  const results = page.getByRole('dialog', { name: '训练结算' })
  await expect(results).toBeVisible()
  await expect(results.getByRole('checkbox', { name: '保留到本机训练历史' })).toBeChecked()
  await results.getByRole('button', { name: after === 'home' ? '完成，返回首页' : '继续查看图表', exact: true }).click()
  await expect(results).not.toBeVisible()
}

/**
 * 自然到期结算不经「提前结算」入口：结算结果面板自动出现，同样默认保留勾选。
 * 断言面板与勾选后由调用方继续（导出本场录制/完成，返回首页）。
 */
export async function expectSettledResultsDialog(page: Page): Promise<void> {
  const results = page.getByRole('dialog', { name: '训练结算' })
  await expect(results).toBeVisible()
  await expect(results.getByRole('checkbox', { name: '保留到本机训练历史' })).toBeChecked()
}
