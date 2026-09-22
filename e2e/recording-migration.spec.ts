import { test, expect } from '@playwright/test'
import { readRecordingArtifact } from './recording-file'
import { startTrainingFromForm } from './training-flow'
import { evidencePath } from './runtime'

const legacy = {
  format: 'trainer-session', schemaVersion: 1, sessionId: 'legacy-migration-fixture',
  createdAt: '2026-09-19T00:00:00Z', app: { version: '0.1.0', gitCommit: 'legacy-fixture', dirty: false, chartLibrary: '10.0.3' },
  environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 800 }, dpr: 1 },
  trainingKey: null, events: [], gaps: [], complete: true,
  checkpoints: [{ id: 'c0', afterSeq: 0, segmentId: 'seg0', capturedAt: '2026-09-19T00:00:00Z',
    training: null, chart: null, ui: { theme: 'dark', tool: null, magnet: 'weak_magnet', multiSelect: false }, context: null }],
}

// REC-03 待合入：旧文件无日线时按日回放必须如实降级（仅周/月或明确缺失），不得从未来补齐；
// 本夹具 checkpoint 无图表数据，日导航不产生虚构日线。
test('旧版IndexedDB录制可迁移查看，原始记录仍保留且损坏导入不改变页面', async ({ page }) => {
  test.setTimeout(60_000)
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  await page.route('**/legacy-storage-setup', route => route.fulfill({ contentType: 'text/html', body: '<title>Storage fixture setup</title>' }))
  await page.goto('/legacy-storage-setup')
  await page.evaluate(file => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('trainer-recordings', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'sessionId' })
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').put(file)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }), legacy)
  await page.goto('/')
  // 训练录像库合并展示旧 v1 记录；打开时按需迁移为 v2，原始行保留
  await page.getByRole('button', { name: '训练录像', exact: true }).click()
  await expect(page.getByRole('heading', { name: '训练录像', exact: true })).toBeVisible()
  await page.locator('.recording-history-item').click()
  await expect(page.getByRole('button', { name: '关闭回放', exact: true })).toBeVisible()
  const saved = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open('trainer-recordings', 2)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['sessions', 'compactSessions'], 'readonly')
      const old = tx.objectStore('sessions').get('legacy-migration-fixture')
      const current = tx.objectStore('compactSessions').get('legacy-migration-fixture')
      tx.oncomplete = () => { resolve({ old: old.result, current: current.result }); db.close() }
    }
  }))
  expect(saved.old).toEqual(legacy)
  expect(saved.current.schemaVersion).toBe(2)
  await page.getByRole('button', { name: '关闭回放', exact: true }).click()
  // 损坏 gzip 导入明确报错并停留在录像库页面
  await page.getByLabel('导入录制', { exact: true }).setInputFiles({ name: 'bad.json.gz', mimeType: 'application/gzip', buffer: Buffer.from([0x1f, 0x8b, 1]) })
  await expect(page.getByRole('alert')).toContainText(/gzip|解压/)
  await expect(page.getByRole('heading', { name: '训练录像', exact: true })).toBeVisible()
  // 旧 JSON（v1）导入仍兼容：直接打开回放
  await page.getByLabel('导入录制', { exact: true }).setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) })
  await expect(page.getByRole('button', { name: '关闭回放', exact: true })).toBeVisible()
})

test('复制标签页的续录指针不会产生同会话双写', async ({ page, context }) => {
  test.setTimeout(90_000)
  const active = (await (await page.request.get('/api/trainings/active')).json()).training
  if (active) await page.request.post(`/api/trainings/${active.id}/abandon`)
  await page.goto('/')
  await page.getByPlaceholder('搜索代码或名称，如 600519 或 贵州茅台').fill('600519')
  await page.getByRole('button', { name: /600519 贵州茅台/ }).click()
  await page.locator('input[type="date"]').fill('2026-09-01')
  await startTrainingFromForm(page)
  await expect(page.getByRole('status').filter({ hasText: '正在记录' })).toBeVisible()
  const pointers = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('trainer.recording.')))
  const other = await context.newPage()
  await other.addInitScript(items => { for (const [key,value] of items) sessionStorage.setItem(key,value) }, pointers)
  await other.goto('/')
  await expect(other.getByRole('status').filter({ hasText: '正在记录' })).toBeVisible()
  await expect(other.getByText('另一标签页正在续录，本页已建立独立录制')).toBeVisible()
  const ids: string[] = []
  for (const [index, tab] of [page, other].entries()) {
    const pending = tab.waitForEvent('download')
    await tab.getByRole('button', { name: '导出录制', exact: true }).click()
    const download = await pending, path = evidencePath(`independent-tab-${index}.json.gz`)
    await download.saveAs(path)
    const file = await readRecordingArtifact(path)
    ids.push(file.sessionId)
    expect(file.schemaVersion).toBe(2)
  }
  expect(ids[0]).not.toBe(ids[1])
  await other.close()
})
