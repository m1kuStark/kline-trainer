import { test, expect, type Page } from '@playwright/test'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { CompactReader } from '../web/src/recording/compactCodec'
import { startTrainingFromForm, expectSettledResultsDialog } from './training-flow'
import { evidencePath } from './runtime'
import { readRecordingArtifact } from './recording-file'

async function exported(page: Page, button: string, name: string) {
  const started = Date.now()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: button, exact: true }).click()
  const download = await pending
  const path = evidencePath(name)
  await download.saveAs(path)
  const bytes = await readFile(path)
  expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b])
  const file = await readRecordingArtifact(path)
  expect(file.schemaVersion).toBe(2)
  if (file.schemaVersion !== 2) throw Error('Expected compact recording')
  return { file, path, durationMs: Date.now() - started }
}

test('两年前复权训练含交易画线周期切换，可压缩导出并离线回放', async ({ page }) => {
  test.setTimeout(12 * 60 * 1000)
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/')
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.getByRole('button', { name: '2年', exact: true }).click()
  await page.locator('input[type="date"]').fill('2024-09-13')
  await startTrainingFromForm(page)
  const recording = page.getByRole('status').filter({ hasText: '正在记录' })
  await expect(recording).toBeVisible()
  // Fail early against the old implementation, before the costly two-year journey.
  const initialRecording = await exported(page, '导出录制', 'two-year-initial.json.gz')
  await page.getByRole('button', { name: '买入', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '卖出', exact: true }).click()
  await expect(page.locator('.status-message')).toHaveClass(/error-text/)
  await page.locator('.draw-toolbar').getByRole('button', { name: '线段', exact: true }).click()
  const box = await page.locator('.chart-host').boundingBox()
  await page.mouse.click(box!.x + box!.width * .35, box!.y + 140)
  await page.waitForTimeout(550)
  await page.mouse.click(box!.x + box!.width * .55, box!.y + 180)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart.drawings().length)).toBe(1)
  await expect(page.locator('.drawing-save-status')).toHaveText('已保存')
  const advanceTimes: number[] = []
  let finalSnapshot: any = null
  for (let count = 1; count <= 510; count++) {
    const started = Date.now()
    const response = page.waitForResponse(r => /\/api\/trainings\/\d+\/next$/.test(r.url()) && r.request().method() === 'POST', { timeout: 20_000 })
    await page.getByRole('button', { name: '推进下一日', exact: true }).click()
    const result = await (await response).json()
    expect(result.snapshot).toBeTruthy()
    finalSnapshot = result.snapshot
    await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
    await expect(recording).toBeVisible()
    advanceTimes.push(Date.now() - started)
    if (result.settled) break
    if (count === 1) {
      await page.getByRole('button', { name: '卖出', exact: true }).click()
      await expect(page.locator('.status-message')).toContainText('成交')
      await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
    }
    if (count % 60 === 0) {
      for (const name of ['周K', '月K', '日K']) {
        await page.getByRole('tab', { name, exact: true }).click()
        await expect(page.getByRole('button', { name: '刷新图表', exact: true })).toBeEnabled()
      }
    }
    if (count === 240) {
      await page.reload()
      await expect(page.locator('.training-topbar')).toBeVisible({ timeout: 30_000 })
      await expect(recording).toBeVisible({ timeout: 30_000 })
    }
  }
  expect(finalSnapshot.training.status).toBe('settled')
  expect(advanceTimes.length).toBeGreaterThan(450)
  // 自然到期同样出现结算结果面板，「保留到本机训练历史」默认勾选（返修合同行为3）
  await expectSettledResultsDialog(page)
  const output = await exported(page, '导出本场录制', 'two-year-final.json.gz')
  const file = output.file
  expect(file.sessionId).toBe(initialRecording.file.sessionId)
  expect(file.events.filter(event => event.action === 'training.advance' && event.phase === 'started')).toHaveLength(advanceTimes.length)
  expect(file.gaps).toEqual([])
  const reader = new CompactReader(file)
  const last = reader.checkpointAt(file.checkpoints.length - 1)
  expect(last.training?.account).toEqual(finalSnapshot.account)
  // The chart query additionally supplies chartPrice in the current adjustment basis.
  const displayed = await (await page.request.get(`/api/trainings/${finalSnapshot.training.id}/bars?tf=1D`)).json()
  expect(last.training?.trades).toEqual(displayed.trades)
  expect(last.training?.trades.map(({ chartPrice: _chartPrice, ...trade }) => trade)).toEqual(finalSnapshot.trades)
  expect(last.chart?.drawings.length).toBe(1)
  expect(file.events.some(e => e.action === 'training.trade' && e.outcome === 'rejected')).toBe(true)
  for (let i = 0; i < file.checkpoints.length; i++) {
    const checkpoint = reader.checkpointAt(i)
    if (!checkpoint.chart) continue
    const cutoff = checkpoint.training!.training.currentDate!
    expect(checkpoint.chart.bars.every(bar => (bar.date.length === 7 ? `${bar.date}-01` : bar.date) <= cutoff)).toBe(true)
  }
  await page.getByRole('button', { name: '完成，返回首页', exact: true }).click()
  await page.getByRole('button', { name: '训练录像', exact: true }).click()
  await expect(page.getByRole('heading', { name: '训练录像', exact: true })).toBeVisible()
  await page.route('**/api/**', route => route.abort())
  const writes: string[] = []
  page.on('request', request => { if (/\/api\//.test(request.url()) && ['POST','PUT','DELETE'].includes(request.method())) writes.push(request.url()) })
  const importedAt = Date.now()
  await page.getByLabel('导入录制', { exact: true }).setInputFiles(output.path)
  // REC-03 按日回放：跳到最后一天后画线仍在，且 b/Delete/鼠标都改不动（只读）
  await page.getByRole('button', { name: '跳到最后一天' }).click()
  await expect(page.locator('.replay-day')).toHaveText(/第 \d+ \/ \d+ 日/)
  await expect.poll(() => page.evaluate(() => (window as any).__trainerChart?.drawings().length)).toBe(1)
  const importMs = Date.now() - importedAt
  await page.keyboard.press('b')
  await page.keyboard.press('Delete')
  await page.screenshot({ path: evidencePath('recording-two-year-replay.png') })
  expect(writes).toEqual([])
  expect(pageErrors).toEqual([])
  const sorted = [...advanceTimes].sort((a,b) => a-b)
  await writeFile(evidencePath('recording-two-year-metrics.json'), JSON.stringify({
    steps: advanceTimes.length, events: file.events.length, checkpoints: file.checkpoints.length,
    fileBytes: (await stat(output.path)).size, jsonBytes: Buffer.byteLength(JSON.stringify(file)),
    exportMs: output.durationMs, importMs, advanceP95Ms: sorted[Math.floor(sorted.length*.95)],
    restoredCheckpoints: file.checkpoints.length, unexpectedPageErrors: pageErrors,
  }, null, 2))
})
