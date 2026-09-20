import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
import { runtime } from './e2e/runtime'

// Playwright 真实事件用户旅程（六幕）。前置：npm run build:journey（server/dist + web/dist journey 构建含测试钩子）。
// 浏览器：系统 Edge channel（免下载）；断言纪律：优先 window.__trainerChart 状态断言，截图仅存档。
// --list remains available without starting any server; actual execution requires the owned manifest.
const run = process.env.TRAINER_RUN_MANIFEST ? runtime() : null
const artifacts = run?.artifactsDir ?? '.runs/discovery'
export default defineConfig({
  testDir: 'e2e',
  globalSetup: 'e2e/global-setup.ts',
  use: {
    baseURL: run?.baseURL,
    channel: 'msedge',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  workers: 1,
  retries: 1,
  reporter: [['list'], ['json', { outputFile: join(artifacts, 'browser-results.json') }], ['html', { open: 'never', outputFolder: join(artifacts, 'html') }]],
  outputDir: join(artifacts, 'test-results'),
})
