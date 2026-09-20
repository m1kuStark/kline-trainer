import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerApi } from '../src/api.js'
import { migrateDatabase } from '../src/db.js'
import { readAppInfo, registerRecordingContextRoutes, resolveProjectRoot } from '../src/recording-context.js'
import type { AppConfig } from '../src/config.js'

// 真实临时 SQLite 文件 + Fastify.inject；不触碰个人训练库，也不需要 TDX 目录。
async function createApp(seed: (database: DatabaseSync) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'recording-context-'))
  const databasePath = join(root, 'trainer.sqlite')
  const database = new DatabaseSync(databasePath)
  migrateDatabase(database)
  seed(database)
  const app = Fastify()
  const config: AppConfig = { host: '127.0.0.1', port: 0, databasePath, tdxRoot: null }
  await registerApi(app, config, database)
  return { app, database, root, databasePath }
}

async function closeApp(context: Awaited<ReturnType<typeof createApp>>) {
  await context.app.close()
  context.database.close()
  await rm(context.root, { recursive: true, force: true })
}

function insertTraining(
  database: DatabaseSync,
  overrides: { currentDate?: string | null; adjustMode?: string; status?: string } = {},
): number {
  const row = {
    startDate: '2024-01-02', plannedEnd: '2024-04-02',
    status: overrides.status ?? 'running',
    adjustMode: overrides.adjustMode ?? 'forward',
    currentDate: overrides.currentDate === undefined ? '2024-03-01' : overrides.currentDate,
  }
  const result = database.prepare(`
    INSERT INTO trainings (tier, code, name, market, start_date, planned_end, status, blind,
      adjust_mode, initial_cash, created_at, current_date, current_close)
    VALUES ('3M', '600519', '贵州茅台', 'sh', ?, ?, ?, 0, ?, 1000000, '2026-09-18T00:00:00.000Z', ?, 1500)
  `).run(row.startDate, row.plannedEnd, row.status, row.adjustMode, row.currentDate)
  return Number(result.lastInsertRowid)
}

function insertEvent(
  database: DatabaseSync, trainingId: number, seq: number, date: string,
  sharesDelta: number, cashDelta: number, costDelta: number | null,
): void {
  database.prepare(`
    INSERT INTO position_events (training_id, seq, date, kind, shares_delta, cash_delta, cost_delta)
    VALUES (?, ?, ?, 'corporate_action', ?, ?, ?)
  `).run(trainingId, seq, date, sharesDelta, cashDelta, costDelta)
}

// 固定字面量表清单，导出整库快照用于只读断言。
function dumpRows(database: DatabaseSync): string {
  const tables = ['trainings', 'position_events', 'settings', 'trades', 'equity_curve']
  return JSON.stringify(tables.map(table => ({ table, rows: database.prepare(`SELECT * FROM ${table}`).all() })))
}

describe('recording-context API', () => {
  it('拒绝非正整数训练 id 并返回中文错误', async () => {
    const context = await createApp()
    try {
      for (const id of ['abc', '0', '-1', '1.5']) {
        const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toBe('id 必须是正整数')
      }
    } finally {
      await closeApp(context)
    }
  })

  it('拒绝非规范十进制整数字符串 id（1e0、0x1、1.0 等宽松解析形式）', async () => {
    const context = await createApp()
    try {
      for (const raw of ['1e0', '0x1', '1.0', '01', '+1']) {
        const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${encodeURIComponent(raw)}/recording-context` })
        expect(response.statusCode, `id ${raw} 应被拒绝`).toBe(400)
        expect(response.json().error).toBe('id 必须是正整数')
      }
    } finally {
      await closeApp(context)
    }
  })

  it('对不存在的训练返回 404 中文错误', async () => {
    const context = await createApp()
    try {
      const response = await context.app.inject({ method: 'GET', url: '/api/trainings/999/recording-context' })
      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('训练 999 不存在')
    } finally {
      await closeApp(context)
    }
  })

  it('返回注册时读取的版本信息与钉定图表库版本', async () => {
    const context = await createApp()
    try {
      const id = insertTraining(context.database)
      const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      const expectedVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
      expect(body.app.version).toBe(expectedVersion)
      expect(body.app.chartLibrary).toBe('10.0.3')
      expect(body.app.gitCommit).toMatch(/^([0-9a-f]{40}|unknown)$/)
      expect(typeof body.app.dirty).toBe('boolean')
    } finally {
      await closeApp(context)
    }
  })

  it('rules 读取 settings 当前实际值而非默认冻结值', async () => {
    const context = await createApp(database => {
      database.prepare("INSERT INTO settings (key, value) VALUES ('fees_enabled', '1'), ('t1_enabled', '0')").run()
    })
    try {
      const id = insertTraining(context.database)
      const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.rules).toMatchObject({
        feesEnabled: true,
        tPlusOne: false,
        lotSize: 100,
        commissionRate: 0.00025,
        minimumCommission: 5,
        stampDutyRate: 0.0005,
        execution: 'same-day-raw-close',
        weightBasis: 'total-equity',
        adjustMode: 'forward',
      })
      expect(Number.isNaN(Date.parse(body.rules.observedAt))).toBe(false)
    } finally {
      await closeApp(context)
    }
  })

  it('未配置 settings 时按引擎回退值观察（费用关、T+1 开）', async () => {
    const context = await createApp()
    try {
      const id = insertTraining(context.database)
      const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      expect(response.statusCode).toBe(200)
      expect(response.json().rules).toMatchObject({ feesEnabled: false, tPlusOne: true })
    } finally {
      await closeApp(context)
    }
  })

  it('按 current_date 截断权息事件并按 date/seq 稳定排序，不泄漏未来数据', async () => {
    const context = await createApp()
    try {
      const id = insertTraining(context.database, { currentDate: '2024-05-10' })
      insertEvent(context.database, id, 2, '2024-05-10', 0, 300, 0)
      insertEvent(context.database, id, 1, '2024-05-10', 100, -50, null)
      insertEvent(context.database, id, 3, '2024-03-05', 0, 500, 0)
      insertEvent(context.database, id, 4, '2024-06-01', 100, 0, 0)
      const other = insertTraining(context.database, { currentDate: '2024-05-10' })
      insertEvent(context.database, other, 1, '2024-04-01', 999, 0, 0)

      const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      expect(response.statusCode).toBe(200)
      expect(response.json().positionEvents).toEqual([
        { seq: 3, date: '2024-03-05', kind: 'corporate_action', sharesDelta: 0, cashDelta: 500, costDelta: 0 },
        { seq: 1, date: '2024-05-10', kind: 'corporate_action', sharesDelta: 100, cashDelta: -50, costDelta: null },
        { seq: 2, date: '2024-05-10', kind: 'corporate_action', sharesDelta: 0, cashDelta: 300, costDelta: 0 },
      ])
    } finally {
      await closeApp(context)
    }
  })

  it('响应不包含本机路径、数据库路径或配置环境信息', async () => {
    const context = await createApp()
    try {
      const id = insertTraining(context.database)
      const response = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      expect(response.statusCode).toBe(200)
      const text = response.body
      expect(text).not.toContain(context.root)
      expect(text).not.toContain(context.databasePath)
      expect(text).not.toContain(tmpdir())
      expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
      expect(text).not.toMatch(/"(tdxRoot|databasePath|host)":/)
      expect(Object.keys(response.json().app).sort()).toEqual(['chartLibrary', 'dirty', 'gitCommit', 'version'])
    } finally {
      await closeApp(context)
    }
  })

  it('只读观察：请求前后数据库行完全不变', async () => {
    const context = await createApp()
    try {
      const id = insertTraining(context.database, { currentDate: '2024-05-10' })
      insertEvent(context.database, id, 1, '2024-03-05', 0, 500, 0)
      insertEvent(context.database, id, 2, '2024-06-01', 100, 0, 0)
      const before = dumpRows(context.database)
      const first = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      const second = await context.app.inject({ method: 'GET', url: `/api/trainings/${id}/recording-context` })
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(dumpRows(context.database)).toBe(before)
    } finally {
      await closeApp(context)
    }
  })
})

// 隔离构建布局：产物位于 <某根>/.runs/run-uuid/server/index.js。旧实现按 import.meta.url 上推两级
// 会把仓库根推成 .runs（package.json 落空 → version unknown）；现约定以进程 cwd（运行架构固定在
// worktree 根）为唯一根来源。诱饵 package.json 放在旧实现会误读的 .runs 下，防止回退到按模块定位。
async function createIsolatedBuildLayout(): Promise<string> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'recording-context-iso-'))
  const buildServerDir = join(isolatedRoot, '.runs', 'run-uuid', 'server')
  await mkdir(buildServerDir, { recursive: true })
  await writeFile(join(buildServerDir, 'index.js'), '// simulated isolated build output\n')
  await writeFile(join(isolatedRoot, '.runs', 'package.json'), JSON.stringify({ name: 'decoy', version: '9.9.9-decoy' }))
  return isolatedRoot
}

describe('recording-context 根定位（cwd 可信源）', () => {
  it('根定位跟随进程 cwd 而非模块位置：chdir 到隔离构建根时不再上推到仓库或 .runs', async () => {
    const originalCwd = process.cwd()
    const isolatedRoot = await createIsolatedBuildLayout()
    try {
      process.chdir(isolatedRoot)
      expect(resolveProjectRoot()).toBe(isolatedRoot)
      expect(resolveProjectRoot()).not.toBe(originalCwd)
      // cwd 指向无 package.json/.git 的目录时严格降级，不读取 .runs 下的诱饵包
      const info = readAppInfo()
      expect(info.version).toBe('unknown')
      expect(info.gitCommit).toBe('unknown')
      expect(info.dirty).toBe(false)
    } finally {
      process.chdir(originalCwd)
      await rm(isolatedRoot, { recursive: true, force: true })
    }
  })

  it('调用者 cwd 为 worktree 根时 version/git 准确，诱饵隔离布局不干扰', async () => {
    const isolatedRoot = await createIsolatedBuildLayout()
    try {
      const info = readAppInfo()
      const expectedVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
      expect(resolveProjectRoot()).toBe(process.cwd())
      expect(info.version).toBe(expectedVersion)
      expect(info.version).not.toBe('9.9.9-decoy')
      expect(info.version).not.toBe('unknown')
      expect(info.gitCommit).toMatch(/^([0-9a-f]{40}|unknown)$/)
      expect(typeof info.dirty).toBe('boolean')
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true })
    }
  })
})
