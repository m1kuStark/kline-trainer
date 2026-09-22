import Fastify, { type FastifyInstance } from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApi } from '../src/api.js'
import { migrateDatabase } from '../src/db.js'
import { createDataRefreshCoordinator, lastWeekdayBeforeToday, type DataRefreshCoordinator } from '../src/data/refresh.js'
import { registerOnlineSource, type DailySource, type ScanOutcome } from '../src/data/source.js'
import { createTdxSource, TDX_SOURCE_NAME } from '../src/data/tdxSource.js'
import type { AppConfig } from '../src/config.js'

// ===== 夹具：合成 TDX 目录（与 api.test.ts 同款字节布局） =====

const encryptedGbbqRecord = Buffer.from('9a7f1ae8eafde7194156de939ea709c237a8c90d0924e4d63f00000000', 'hex')

function dayRecord(date: number, open: number, high: number, low: number, close: number, amount: number, volume: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeInt32LE(date, 0)
  buffer.writeInt32LE(Math.round(open * 100), 4)
  buffer.writeInt32LE(Math.round(high * 100), 8)
  buffer.writeInt32LE(Math.round(low * 100), 12)
  buffer.writeInt32LE(Math.round(close * 100), 16)
  buffer.writeFloatLE(amount, 20)
  buffer.writeInt32LE(volume, 24)
  return buffer
}

// —— 独立实现的日期工具（不 import 被测代码，形成交叉验证） ——

function isoDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 今天之前最近的工作日（跳过周六周日）——与被测启发式各自的独立实现 */
function expectedLatestTradingDay(now = new Date()): string {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  do {
    cursor.setDate(cursor.getDate() - 1)
  } while (cursor.getDay() === 0 || cursor.getDay() === 6)
  return isoDate(cursor)
}

function shiftWeekdays(dateIso: string, steps: number): string {
  const cursor = new Date(`${dateIso}T12:00:00`)
  const direction = steps < 0 ? -1 : 1
  let remaining = Math.abs(steps)
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + direction)
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) remaining -= 1
  }
  return isoDate(cursor)
}

function dateInt(iso: string): number {
  return Number(iso.replaceAll('-', ''))
}

const E = expectedLatestTradingDay()
const D1 = shiftWeekdays(E, -4)
const D2 = shiftWeekdays(E, -3)
const D3 = shiftWeekdays(E, -2)

async function writeStockDayFile(root: string, market: 'sh' | 'sz', fileName: string, dates: number[]): Promise<void> {
  const directory = join(root, 'vipdoc', market, 'lday')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, fileName), Buffer.concat(dates.map((date, index) =>
    dayRecord(date, 10 + index, 11 + index, 9 + index, 10 + index, 1_000, 100))))
}

async function writeGbbq(root: string): Promise<void> {
  const gbbq = Buffer.alloc(4 + encryptedGbbqRecord.length)
  gbbq.writeUInt32LE(1, 0)
  encryptedGbbqRecord.copy(gbbq, 4)
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbq)
}

/** 两只股票（sh/sz 各一），日线截至 D2（早于最近交易日 E） */
async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tdx-data-refresh-'))
  await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D1), dateInt(D2)])
  await writeStockDayFile(root, 'sz', 'sz000001.day', [dateInt(D1), dateInt(D2)])
  await writeGbbq(root)
  return root
}

async function createApp(tdxRoot: string | null) {
  const database = new DatabaseSync(':memory:')
  migrateDatabase(database)
  const app = Fastify()
  const config: AppConfig = { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot }
  await registerApi(app, config, database)
  return { app, database }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

type StatusBody = {
  state: string
  needsUpdate: boolean
  reason: string
  source: { kind: string; name: string; available: boolean }
  tdx: { available: boolean; root: string | null }
  online: { configured: boolean; provider: string | null }
  sourceMaxDate: string | null
  lastCheckedAt: string | null
  lastResult: { finishedAt: string; outcome: string; added: number; removed: number; revised: number; message: string } | null
  revisionWarning: string | null
}

async function getStatus(app: FastifyInstance): Promise<StatusBody> {
  const response = await app.inject({ method: 'GET', url: '/api/data/status' })
  expect(response.statusCode).toBe(200)
  return response.json()
}

async function waitForTerminalStatus(app: FastifyInstance): Promise<StatusBody> {
  let latest: StatusBody | null = null
  await waitFor(async () => {
    latest = await getStatus(app)
    return latest.state !== 'running'
  })
  return latest as unknown as StatusBody
}

/** 触发一次新任务并等待其到达终态 */
async function refreshAndWait(app: FastifyInstance): Promise<{ taskId: string; final: StatusBody }> {
  const started = await app.inject({ method: 'POST', url: '/api/data/refresh' })
  expect(started.statusCode).toBe(202)
  const body = started.json()
  expect(body.state).toBe('running')
  expect(body.joined).toBe(false)
  expect(typeof body.taskId).toBe('string')
  const final = await waitForTerminalStatus(app)
  return { taskId: body.taskId, final }
}

function fakeOnlineSource(name: string, scan: () => Promise<ScanOutcome>): DailySource {
  return { kind: 'online', name, available: async () => true, scan }
}

/** 整批版本标识：目录/权息/文件状态三个域必须指向同一批次（DATA-01）。 */
function readBatchVersion(database: DatabaseSync): string | null {
  const rows = database.prepare(
    "SELECT key, value FROM cache_meta WHERE key IN ('catalog_batch', 'adjustment_batch', 'snapshot_batch')",
  ).all() as unknown as Array<{ key: string; value: string }>
  if (rows.length !== 3) return null
  const values = new Set(rows.map(row => row.value))
  if (values.size !== 1) return null
  return [...values][0] ?? null
}

/** 直连协调器：触发一次新任务并等待终态（不经 Fastify 路由，便于检查数据库）。 */
async function runCoordinatorAndWait(coordinator: DataRefreshCoordinator): Promise<StatusBody> {
  const started = await coordinator.start()
  expect(started).not.toBeNull()
  expect(started?.joined).toBe(false)
  let latest: StatusBody | null = null
  await waitFor(async () => {
    latest = await coordinator.getStatus()
    return latest.state !== 'running'
  })
  return latest as unknown as StatusBody
}

function directCoordinator(database: DatabaseSync, tdxRoot: string, options: Parameters<typeof createDataRefreshCoordinator>[2] = {}): DataRefreshCoordinator {
  return createDataRefreshCoordinator(
    database,
    { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot },
    options,
  )
}

// ===== 用例 =====

describe('data refresh service', () => {
  it('a) scans a synthetic TDX fixture: baseline updated, then unchanged on rescan', async () => {
    const root = await createFixtureRoot()
    const { app, database } = await createApp(root)
    try {
      const first = await refreshAndWait(app)
      expect(first.final.state).toBe('updated')
      expect(first.final.source.kind).toBe('tdx')
      expect(first.final.source.available).toBe(true)
      expect(first.final.sourceMaxDate).toBe(D2)
      // 首个快照按基线处理：不报新增/移除/修订
      expect(first.final.lastResult).toMatchObject({ outcome: 'updated', added: 0, removed: 0, revised: 0 })
      expect(first.final.lastResult?.message).toContain('基线')
      expect(first.final.lastCheckedAt).toBeTruthy()
      expect(first.final.revisionWarning).toBeNull()
      // 数据早于最近交易日 → 建议更新
      expect(first.final.needsUpdate).toBe(true)
      expect(first.final.reason).toContain(D2)
      // 约定字段一个不少
      for (const key of ['state', 'needsUpdate', 'reason', 'source', 'tdx', 'online', 'sourceMaxDate', 'lastCheckedAt', 'lastResult', 'revisionWarning']) {
        expect(first.final).toHaveProperty(key)
      }
      // 快照落库
      const snapshot = database.prepare('SELECT COUNT(*) AS count FROM data_file_state').get() as unknown as { count: number }
      expect(snapshot.count).toBe(2)

      const second = await refreshAndWait(app)
      expect(second.final.state).toBe('unchanged')
      expect(second.final.lastResult).toMatchObject({ outcome: 'unchanged', added: 0, removed: 0, revised: 0 })
      expect(second.final.sourceMaxDate).toBe(D2)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('b/h) joins concurrent refresh POSTs into one task and reports running meanwhile', async () => {
    let scanCalls = 0
    let releaseScan: (() => void) | null = null
    const gate = new Promise<void>(resolve => { releaseScan = resolve })
    const unregister = registerOnlineSource(fakeOnlineSource('测试在线源', async () => {
      scanCalls += 1
      await gate
      return {
        kind: 'online', name: '测试在线源', totalStocks: 1, added: 0, removed: 0,
        revised: 0, baseline: true, sourceMaxDate: '2026-01-08', files: [],
      }
    }))
    const { app, database } = await createApp(null)
    try {
      const first = await app.inject({ method: 'POST', url: '/api/data/refresh' })
      expect(first.statusCode).toBe(202)
      const firstBody = first.json()
      expect(firstBody.joined).toBe(false)
      expect(firstBody.state).toBe('running')

      const second = await app.inject({ method: 'POST', url: '/api/data/refresh' })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json()
      expect(secondBody.joined).toBe(true)
      expect(secondBody.taskId).toBe(firstBody.taskId)
      expect(secondBody.state).toBe('running')

      // h) running 期间查询状态
      const during = await getStatus(app)
      expect(during.state).toBe('running')
      expect(during.source.kind).toBe('online')
      expect(during.source.available).toBe(true)

      releaseScan?.()
      const final = await waitForTerminalStatus(app)
      expect(final.state).toBe('updated')
      expect(scanCalls).toBe(1)
      expect(final.online).toEqual({ configured: true, provider: '测试在线源' })
    } finally {
      unregister()
      await app.close()
      database.close()
    }
  })

  it('c) reports unavailable source with needsUpdate=false and POST refresh returns 409 in Chinese', async () => {
    const { app, database } = await createApp(null)
    try {
      const status = await getStatus(app)
      expect(status.tdx).toEqual({ available: false, root: null })
      expect(status.source.kind).toBe('none')
      expect(status.source.available).toBe(false)
      expect(status.needsUpdate).toBe(false)
      expect(status.reason).toContain('未检测到')
      expect(status.state).toBe('idle')
      expect(status.lastResult).toBeNull()
      expect(status.lastCheckedAt).toBeNull()

      const refresh = await app.inject({ method: 'POST', url: '/api/data/refresh' })
      expect(refresh.statusCode).toBe(409)
      expect(refresh.json().error).toContain('未检测到')
    } finally {
      await app.close()
      database.close()
    }
  })

  it('d) fails the task and preserves snapshot+caches when a market day directory disappears', async () => {
    const root = await createFixtureRoot()
    const { app, database } = await createApp(root)
    try {
      const first = await refreshAndWait(app)
      expect(first.final.state).toBe('updated')
      const before = database.prepare('SELECT COUNT(*) AS count FROM data_file_state').get() as unknown as { count: number }
      expect(before.count).toBe(2)

      // 市场目录 vipdoc/sh 仍在但 lday 消失：available() 仍为真，扫描中途失败
      await rm(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true, force: true })
      const second = await refreshAndWait(app)
      expect(second.final.state).toBe('failed')
      expect(second.final.lastResult?.outcome).toBe('failed')
      expect(second.final.lastResult?.message).toContain('无法读取')
      expect(second.final.lastResult?.message).toContain('lday')
      expect(second.final.lastCheckedAt).toBeTruthy()

      // 旧快照与旧目录缓存保留，未被清空
      const after = database.prepare('SELECT COUNT(*) AS count FROM data_file_state').get() as unknown as { count: number }
      expect(after.count).toBe(2)
      const snapshotRow = database.prepare("SELECT max_date FROM data_file_state WHERE path LIKE '%600519%'").get() as unknown as { max_date: string }
      expect(snapshotRow.max_date).toBe(D2)
      const stocks = database.prepare('SELECT COUNT(*) AS count FROM stocks').get() as unknown as { count: number }
      expect(stocks.count).toBe(2)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('e) rejects a torn (non-32-byte-multiple) .day file: failed, nothing published, recovers after fix', async () => {
    const root = await createFixtureRoot()
    const { app, database } = await createApp(root)
    const dayFile = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
    try {
      const first = await refreshAndWait(app)
      expect(first.final.state).toBe('updated')

      // 半条记录：追加 10 字节
      await writeFile(dayFile, Buffer.concat([Buffer.alloc(64), Buffer.alloc(10)]))
      const broken = await refreshAndWait(app)
      expect(broken.final.state).toBe('failed')
      expect(broken.final.lastResult?.outcome).toBe('failed')
      expect(broken.final.lastResult?.message).toContain('600519')
      // 不发布部分结果：快照仍为旧值
      const snapshotRow = database.prepare("SELECT size, max_date FROM data_file_state WHERE path LIKE '%600519%'").get() as unknown as { size: number; max_date: string }
      expect(snapshotRow.size).toBe(64)
      expect(snapshotRow.max_date).toBe(D2)
      const stocks = database.prepare('SELECT COUNT(*) AS count FROM stocks').get() as unknown as { count: number }
      expect(stocks.count).toBe(2)

      // 修复后可恢复（新交易日 D3）
      await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D1), dateInt(D2), dateInt(D3)])
      const future = new Date(Date.now() + 5_000)
      await utimes(dayFile, future, future)
      const recovered = await refreshAndWait(app)
      expect(recovered.final.state).toBe('updated')
      expect(recovered.final.sourceMaxDate).toBe(D3)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('f) detects appended bars: added>0, sourceMaxDate moves to E, needsUpdate turns false', async () => {
    const root = await createFixtureRoot()
    const { app, database } = await createApp(root)
    try {
      const first = await refreshAndWait(app)
      expect(first.final.needsUpdate).toBe(true)

      // 两只股票都追加最新交易日 E 的日线
      await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D1), dateInt(D2), dateInt(E)])
      await writeStockDayFile(root, 'sz', 'sz000001.day', [dateInt(D1), dateInt(D2), dateInt(E)])
      const dayFile = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
      const future = new Date(Date.now() + 5_000)
      await utimes(dayFile, future, future)

      const second = await refreshAndWait(app)
      expect(second.final.state).toBe('updated')
      expect(second.final.lastResult?.outcome).toBe('updated')
      expect(second.final.lastResult?.added).toBe(2)
      expect(second.final.sourceMaxDate).toBe(E)
      expect(second.final.needsUpdate).toBe(false)
      expect(second.final.reason).toContain(E)
      // 训练器目录缓存同步到了新交易日
      const stock = database.prepare("SELECT last_date FROM stocks WHERE code = '600519'").get() as unknown as { last_date: string }
      expect(stock.last_date).toBe(E)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('g) flags suspicious historical revision when size changes but maxDate stays', async () => {
    const root = await createFixtureRoot()
    const { app, database } = await createApp(root)
    try {
      const first = await refreshAndWait(app)
      expect(first.final.state).toBe('updated')
      expect(first.final.revisionWarning).toBeNull()

      // 历史修订：同一只股票只剩 1 根日线，末日不变（size 64→32）
      await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D2)])
      const dayFile = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
      const future = new Date(Date.now() + 5_000)
      await utimes(dayFile, future, future)

      const second = await refreshAndWait(app)
      expect(second.final.state).toBe('updated')
      expect(second.final.lastResult?.revised).toBe(1)
      expect(second.final.revisionWarning).toContain('1 只')
      expect(second.final.revisionWarning).toContain('疑似修订')
      expect(second.final.sourceMaxDate).toBe(D2)
      // 训练数据绝不被改写
      const trades = database.prepare('SELECT COUNT(*) AS count FROM trades').get() as unknown as { count: number }
      expect(trades.count).toBe(0)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('i) watchdog marks a hung scan as failed within the injected timeout', async () => {
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)
    const unregister = registerOnlineSource(fakeOnlineSource('慢速在线源', () => new Promise<ScanOutcome>(() => {})))
    try {
      const coordinator = createDataRefreshCoordinator(
        database,
        { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot: null },
        { timeoutMs: 40 },
      )
      const started = await coordinator.start()
      expect(started).not.toBeNull()
      expect(started?.joined).toBe(false)
      await waitFor(async () => (await coordinator.getStatus()).state === 'failed')
      const status = await coordinator.getStatus()
      expect(status.lastResult?.outcome).toBe('failed')
      expect(status.lastResult?.message).toContain('扫描超时')
      // 未提交任何部分结果
      const rows = database.prepare('SELECT COUNT(*) AS count FROM data_file_state').get() as unknown as { count: number }
      expect(rows.count).toBe(0)
    } finally {
      unregister()
      database.close()
    }
  })

  it('j) keeps /api/env response shape 100% backward compatible', async () => {
    const root = await createFixtureRoot()
    const { app, database } = await createApp(root)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/env' })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(Object.keys(body).sort()).toEqual([
        'activeTrainingId', 'capabilities', 'dataCutoff', 'status', 'stockCount', 'tdxRoot',
      ].sort())
      expect(body).toMatchObject({
        status: 'ok',
        tdxRoot: root,
        dataCutoff: D2,
        stockCount: 2,
        activeTrainingId: null,
      })
      expect(Object.keys(body.capabilities).sort()).toEqual([
        'benchmark', 'catalogCache', 'day', 'forwardAdjust', 'training',
      ].sort())
      for (const value of Object.values(body.capabilities)) expect(value).toBe(true)
    } finally {
      await app.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('computes the last weekday before today, skipping weekends', () => {
    expect(lastWeekdayBeforeToday(new Date('2026-09-16T12:00:00'))).toBe('2026-09-15') // 周三 → 周二
    expect(lastWeekdayBeforeToday(new Date('2026-09-14T12:00:00'))).toBe('2026-09-11') // 周一 → 上周五
    expect(lastWeekdayBeforeToday(new Date('2026-09-13T12:00:00'))).toBe('2026-09-11') // 周日 → 上周五
    expect(lastWeekdayBeforeToday(new Date('2026-09-12T12:00:00'))).toBe('2026-09-11') // 周六 → 上周五
    expect(lastWeekdayBeforeToday(new Date('2026-09-07T12:00:00'))).toBe('2026-09-04') // 周一 → 上周五
  })

  // ===== DATA-01：整批发布与超时屏障 =====

  it('k) keeps the last fully published batch when the adjustment cache fails after the catalog scan', async () => {
    const root = await createFixtureRoot()
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)
    const coordinator = directCoordinator(database, root)
    try {
      const first = await runCoordinatorAndWait(coordinator)
      expect(first.state).toBe('updated')
      // 目录、权息、文件状态共享同一批次标识
      const batch1 = readBatchVersion(database)
      expect(batch1).not.toBeNull()

      // 目录扫描能成功（日线追加 D3），但权息刷新将失败（gbbq 消失）
      await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D1), dateInt(D2), dateInt(D3)])
      await writeStockDayFile(root, 'sz', 'sz000001.day', [dateInt(D1), dateInt(D2), dateInt(D3)])
      const dayFile = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
      const future = new Date(Date.now() + 5_000)
      await utimes(dayFile, future, future)
      await rm(join(root, 'T0002', 'hq_cache', 'gbbq'))

      const second = await runCoordinatorAndWait(coordinator)
      expect(second.state).toBe('failed')
      expect(second.lastResult?.outcome).toBe('failed')
      expect(second.lastResult?.message).toContain('刷新权息缓存失败')
      // 失败必须保留上一份可用状态：目录不得单独发布 D3
      const stock = database.prepare("SELECT last_date FROM stocks WHERE code = '600519'").get() as unknown as { last_date: string }
      expect(stock.last_date).toBe(D2)
      const snapshotRow = database.prepare("SELECT max_date FROM data_file_state WHERE path LIKE '%600519%'").get() as unknown as { max_date: string }
      expect(snapshotRow.max_date).toBe(D2)
      // 批次标识仍指向上一份完整批次
      expect(readBatchVersion(database)).toBe(batch1)

      // 恢复 gbbq 后可整批发布新状态
      await writeGbbq(root)
      const third = await runCoordinatorAndWait(coordinator)
      expect(third.state).toBe('updated')
      const recovered = database.prepare("SELECT last_date FROM stocks WHERE code = '600519'").get() as unknown as { last_date: string }
      expect(recovered.last_date).toBe(D3)
      const batch3 = readBatchVersion(database)
      expect(batch3).not.toBeNull()
      expect(batch3).not.toBe(batch1)
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('l) late async work after the watchdog cannot publish and cannot clobber a newer task', async () => {
    const root = await createFixtureRoot()
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)
    // 门控只挂起第二次发布（超时任务 A）；首扫与后续任务 B 正常放行
    let publishCalls = 0
    let releaseStale: (() => void) | null = null
    const staleGate = new Promise<void>(resolve => { releaseStale = resolve })
    const coordinator = directCoordinator(database, root, {
      timeoutMs: 120,
      beforePublish: async () => {
        publishCalls += 1
        if (publishCalls === 2) await staleGate
      },
    })
    try {
      const first = await runCoordinatorAndWait(coordinator)
      expect(first.state).toBe('updated')
      const batch1 = readBatchVersion(database)
      expect(batch1).not.toBeNull()

      // 任务 A：全部扫描可成功，但发布被门控挂起，直到看门狗超时
      await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D1), dateInt(D2), dateInt(D3)])
      await writeStockDayFile(root, 'sz', 'sz000001.day', [dateInt(D1), dateInt(D2), dateInt(D3)])
      const dayFile = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
      const future = new Date(Date.now() + 5_000)
      await utimes(dayFile, future, future)
      const stale = await coordinator.start()
      expect(stale?.joined).toBe(false)
      await waitFor(async () => (await coordinator.getStatus()).state === 'failed')
      const failedStatus = await coordinator.getStatus()
      expect(failedStatus.lastResult?.message).toContain('扫描超时')

      // 任务 B：在任务 A 仍挂起时安全开始，并整批发布
      const fresh = await coordinator.start()
      expect(fresh?.joined).toBe(false)
      await waitFor(async () => (await coordinator.getStatus()).state !== 'running')
      const afterFresh = await coordinator.getStatus()
      expect(afterFresh.state).toBe('updated')
      const batch2 = readBatchVersion(database)
      expect(batch2).not.toBeNull()
      expect(batch2).not.toBe(batch1)

      // 释放任务 A：迟到流程不得再写库（既不覆盖批次，也不改写日志）
      releaseStale?.()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(readBatchVersion(database)).toBe(batch2)
      const logs = database.prepare('SELECT outcome, message FROM data_refresh_log ORDER BY id').all() as unknown as Array<{ outcome: string; message: string }>
      expect(logs.map(log => log.outcome)).toEqual(['updated', 'failed', 'updated'])
      expect(logs[1]?.message).toContain('扫描超时')
      const statusAfter = await coordinator.getStatus()
      expect(statusAfter.state).toBe('updated')
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('m) fails the whole batch when the catalog scan is incomplete mid-task', async () => {
    const root = await createFixtureRoot()
    const database = new DatabaseSync(':memory:')
    migrateDatabase(database)
    // 包装真实 TDX 来源：第二次扫描成功返回后，立刻移除 sz 目录，制造"扫描成功但目录阶段不完整"
    const real = createTdxSource(root)
    let scanCalls = 0
    const coordinator = directCoordinator(database, root, {
      tdxSource: {
        kind: 'tdx',
        name: TDX_SOURCE_NAME,
        available: () => real.available(),
        scan: async previous => {
          const outcome = await real.scan(previous)
          scanCalls += 1
          if (scanCalls === 2) await rm(join(root, 'vipdoc', 'sz', 'lday'), { recursive: true, force: true })
          return outcome
        },
      },
    })
    try {
      const first = await runCoordinatorAndWait(coordinator)
      expect(first.state).toBe('updated')
      const batch1 = readBatchVersion(database)
      expect(batch1).not.toBeNull()

      // sh 追加 D3；目录阶段将发现 sz 不可读
      await writeStockDayFile(root, 'sh', 'sh600519.day', [dateInt(D1), dateInt(D2), dateInt(D3)])
      const dayFile = join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day')
      const future = new Date(Date.now() + 5_000)
      await utimes(dayFile, future, future)

      const second = await runCoordinatorAndWait(coordinator)
      expect(second.state).toBe('failed')
      expect(second.lastResult?.outcome).toBe('failed')
      expect(second.lastResult?.message).toContain('刷新股票目录失败')
      expect(second.lastResult?.message).toContain('sz')
      // 扫描不完整＝整批不发布：健康的 sh 也不得单独更新
      const stock = database.prepare("SELECT last_date FROM stocks WHERE code = '600519'").get() as unknown as { last_date: string }
      expect(stock.last_date).toBe(D2)
      const snapshotRow = database.prepare("SELECT max_date FROM data_file_state WHERE path LIKE '%600519%'").get() as unknown as { max_date: string }
      expect(snapshotRow.max_date).toBe(D2)
      expect(readBatchVersion(database)).toBe(batch1)

      // 恢复 sz 后整批成功
      await writeStockDayFile(root, 'sz', 'sz000001.day', [dateInt(D1), dateInt(D2)])
      const third = await runCoordinatorAndWait(coordinator)
      expect(third.state).toBe('updated')
      const recovered = database.prepare("SELECT last_date FROM stocks WHERE code = '600519'").get() as unknown as { last_date: string }
      expect(recovered.last_date).toBe(D3)
      const batch3 = readBatchVersion(database)
      expect(batch3).not.toBeNull()
      expect(batch3).not.toBe(batch1)
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
