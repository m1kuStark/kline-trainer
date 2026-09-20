import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { access, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import launcherModule from '../../scripts/release/launcher.cjs'

interface LaunchResult {
  reused: boolean
  url: string
  port: number
  pid: number
  runId: string
  dataDir: string
  logPath: string
  tdxRoot: string | null
  openedBrowser: boolean
}

interface StopResult {
  stopped: boolean
  noop?: 'no-state' | 'already-dead'
  cleanedStaleState?: boolean
  portDrained?: boolean
  pid?: number
  port?: number
  url?: string
  runId?: string
  dataDir: string
  logPath?: string
}

interface StopOptions {
  root?: string
  configPath?: string
  env?: Record<string, string | undefined>
  lockWaitMs?: number
  exitTimeoutMs?: number
  portDrainTimeoutMs?: number
}

interface ProbeResult {
  responded: boolean
  refused: boolean
  status?: number
  json?: unknown
  reason?: string
}

interface LaunchOptions {
  root?: string
  configPath?: string
  openBrowser?: boolean
  env?: Record<string, string | undefined>
  tdxCandidates?: string[]
  startTimeoutMs?: number
  lockWaitMs?: number
}

interface LauncherModule {
  APP_ID: string
  DATA_DIR_NAME: string
  DEFAULT_PORT: number
  TDX_CANDIDATES: string[]
  parseArgs(argv: string[]): { root?: string, configPath?: string, openBrowser: boolean, stop?: boolean, help?: boolean }
  resolveConfig(root: string, raw: unknown, env?: Record<string, string | undefined>): {
    port: number
    dataDir: string
    databasePath: string
    tdxRoot: string | null
  }
  pidAlive(pid: number): boolean
  isTdxRootPath(root: string): Promise<boolean>
  readOwnedState(dataDir: string): Promise<{ state?: Record<string, unknown>, stale?: string, pid?: number | null } | null>
  launch(options: LaunchOptions): Promise<LaunchResult>
  stop(options: StopOptions): Promise<StopResult>
  openURL(url: string, spawnImpl?: unknown): Promise<boolean>
  probeHealth(port: number, options?: { timeoutMs?: number }): Promise<ProbeResult>
  confirmOwnedServer(
    state: { runId: string, pid: number, port: number },
    options?: { attempts?: number, timeoutMs?: number },
  ): Promise<boolean>
  usage(): string
}

const launcher = launcherModule as unknown as LauncherModule

// 固定包结构的最小替身：真实 Node 进程、动态端口，ready 文件与 /api/health
// 身份语义与 server/dist/index.js 对齐。响应体是启动时预计算的静态字符串，
// 不在请求处理器里拼接任何请求输入。
const FIXTURE_SERVER = `
import { appendFile, rename, writeFile } from 'node:fs/promises'
import http from 'node:http'

const counterFile = process.env.FIXTURE_SPAWN_COUNTER
if (counterFile) await appendFile(counterFile, process.pid + '\\n')
const pidFile = process.env.FIXTURE_PID_FILE
if (pidFile) await writeFile(pidFile, String(process.pid))

const mode = process.env.FIXTURE_MODE ?? 'ok'
if (mode === 'crash') {
  console.error('fixture crash sentinel')
  process.exit(7)
}
if (mode === 'hang') {
  console.log('fixture hang mode')
  setInterval(() => {}, 10_000)
} else {
  const runId = process.env.TRAINER_RUN_ID ?? ''
  const readyFile = process.env.TRAINER_READY_FILE ?? ''
  const healthBody = JSON.stringify({ status: 'ok', runId, pid: process.pid })
  const healthStatus = Number(process.env.FIXTURE_HEALTH_STATUS ?? 200)
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(healthStatus, { 'content-type': 'application/json; charset=utf-8' })
      response.end(healthBody)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('fixture\\n')
  })
  await new Promise(resolveListen => { server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', resolveListen) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseURL = 'http://127.0.0.1:' + port
  if (mode === 'wrongready') {
    await writeFile(readyFile, JSON.stringify({ runId: 'run-00000000-0000-0000-0000-000000000000', pid: process.pid, port, baseURL }))
  } else {
    const temporary = readyFile + '.tmp'
    await writeFile(temporary, JSON.stringify({ runId, pid: process.pid, port, baseURL }))
    await rename(temporary, readyFile)
  }
  console.log('fixture server ' + baseURL + ' mode=' + mode)
}
`

// 夹具目录名同时包含空格和中文，所有启动路径都暴露给 Windows 特殊字符。
const FIXTURE_DIR_NAME = 'rel launch 容器 pkg'
const NODE_BINARY = process.platform === 'win32' ? 'node.exe' : 'node'

const activePids = new Set<number>()
const activeRoots = new Set<string>()
const activeClosers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const closer of activeClosers.splice(0)) await closer().catch(() => {})
  for (const pid of activePids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  for (const pid of activePids) await waitForExit(pid)
  activePids.clear()
  for (const root of activeRoots) await removeTree(root)
  activeRoots.clear()
})

async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!launcher.pidAlive(pid)) return
    await delay(100)
  }
}

async function removeTree(path: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch { await delay(200) }
  }
  throw new Error(`cleanup failed for ${path}`)
}

async function makeFixture() {
  const base = await mkdtemp(join(tmpdir(), 'rel-launch-'))
  const root = join(base, FIXTURE_DIR_NAME)
  activeRoots.add(base)
  await mkdir(join(root, 'runtime'), { recursive: true })
  await mkdir(join(root, 'server', 'dist'), { recursive: true })
  await mkdir(join(root, 'web', 'dist'), { recursive: true })
  const nodeTarget = join(root, 'runtime', NODE_BINARY)
  try {
    await link(process.execPath, nodeTarget)
  } catch {
    await copyFile(process.execPath, nodeTarget)
  }
  await Promise.all([
    writeFile(join(root, 'release.json'), JSON.stringify({ appId: launcher.APP_ID, version: '0.3.0-test', gitCommit: 'fixture' })),
    writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.3.0-test' })),
    writeFile(join(root, 'server', 'dist', 'index.js'), FIXTURE_SERVER),
    writeFile(join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>fixture</title>'),
  ])
  return root
}

async function freePort() {
  const probe = http.createServer()
  await new Promise<void>(resolveListen => probe.listen(0, '127.0.0.1', resolveListen))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolveClose => probe.close(() => resolveClose()))
  expect(port).toBeGreaterThan(0)
  return port
}

// 一个解析为"无进程"的 PID：不需要真实退出过的进程，只要 pidAlive 判死即可。
// Windows PID 按 4 对齐；跳过 EPERM（系统进程）与极小值。
function deadPid() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = 4 * (2 + (randomBytes(4).readUInt32BE(0) % 1_000_000))
    if (!launcher.pidAlive(candidate)) return candidate
  }
  throw new Error('no dead pid found')
}

function writeConfig(root: string, fields: Record<string, unknown>) {
  return writeFile(join(root, 'trainer.config.json'), JSON.stringify(fields))
}

// sanitize process.env so developer shells (TDX_ROOT, NODE_OPTIONS, ...) cannot
// steer the fixtures; launcher overrides are applied on top inside launch().
async function launchFixture(root: string, overrides: Record<string, string | undefined> = {}, options: Partial<LaunchOptions> = {}) {
  const result = await launcher.launch({
    root,
    openBrowser: false,
    env: { ...process.env, NODE_OPTIONS: '', TDX_ROOT: '', TRAINER_DB: '', ...overrides },
    tdxCandidates: [],
    startTimeoutMs: 10_000,
    lockWaitMs: 2_000,
    ...options,
  })
  activePids.add(result.pid)
  return result
}

// 测试自身对已启动服务的健康访问：URL 用 new URL 显式构造，
// 只指向启动器返回的 127.0.0.1 基址，协议与主机都是常量。
async function fetchHealth(base: string): Promise<{ status: number, body: { status?: unknown, runId?: unknown, pid?: unknown } }> {
  const url = new URL('/api/health', base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error(`unexpected health target: ${url.protocol}://${url.hostname}`)
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  return { status: response.status, body: await response.json() }
}

function spawnCounter(dataDir: string) {
  return join(dataDir, 'spawns.txt')
}

async function spawnCount(dataDir: string) {
  return (await readFile(spawnCounter(dataDir), 'utf8')).trim().split('\n').length
}

// 与 launchFixture 相同的 env 净化：开发者 shell 的 TDX_ROOT/TRAINER_DB 不得影响目标定位。
async function stopFixture(root: string, overrides: Record<string, string | undefined> = {}, options: Partial<StopOptions> = {}) {
  return launcher.stop({
    root,
    env: { ...process.env, NODE_OPTIONS: '', TDX_ROOT: '', TRAINER_DB: '', ...overrides },
    lockWaitMs: 4_000,
    exitTimeoutMs: 5_000,
    ...options,
  })
}

function stateFile(dataDir: string) {
  return join(dataDir, 'trainer-state.json')
}

// 停止/启动拒绝场景要求"状态文件原样保留"，按原始字节比较而不是重新序列化。
async function writeRawState(dataDir: string, value: unknown) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(stateFile(dataDir), JSON.stringify(value))
}

async function tamperStateRunId(dataDir: string) {
  const raw = await readFile(stateFile(dataDir), 'utf8')
  const state = JSON.parse(raw) as { runId: string }
  const tampered = raw.replace(state.runId, 'run-22222222-2222-2222-2222-222222222222')
  await writeFile(stateFile(dataDir), tampered)
  return { original: raw, tampered }
}

describe('release launcher config resolution', () => {
  it('falls back to documented defaults without a config file', () => {
    const config = launcher.resolveConfig('D:\\pkg', null, {})
    expect(config.port).toBe(8787)
    expect(config.dataDir).toBe(join(homedir(), '.a-share-kline-trainer'))
    expect(config.databasePath).toBe(join(config.dataDir, 'trainer.sqlite'))
    expect(config.tdxRoot).toBeNull()
  })

  it('resolves relative paths against the package root and requires a sane port', () => {
    const config = launcher.resolveConfig('D:\\pkg', { port: '9123', tdxRoot: 'tdx', dataDir: 'data dir' }, {})
    expect(config.port).toBe(9123)
    expect(config.tdxRoot).toBe(resolve('D:\\pkg', 'tdx'))
    expect(config.dataDir).toBe(resolve('D:\\pkg', 'data dir'))
    expect(config.databasePath).toBe(join(config.dataDir, 'trainer.sqlite'))
    for (const port of [0, -1, 70000, 1.5, 'abc']) {
      expect(() => launcher.resolveConfig('D:\\pkg', { port }, {})).toThrow(/port|端口/)
    }
    expect(launcher.resolveConfig('D:\\pkg', { port: null }, {})).toMatchObject({ port: 8787 })
    expect(() => launcher.resolveConfig('D:\\pkg', { databasePath: 'relative.sqlite' }, {})).toThrow(/absolute|绝对路径/)
  })

  it('lets explicitly set environment variables override the config file', () => {
    const config = launcher.resolveConfig('D:\\pkg', { tdxRoot: 'C:\\tdx', port: 1 }, { TDX_ROOT: 'C:\\other tdx', TRAINER_DB: 'D:\\db\\t.sqlite' })
    expect(config.tdxRoot).toBe(resolve('C:\\other tdx'))
    expect(config.databasePath).toBe(resolve('D:\\db\\t.sqlite'))
    expect(config.port).toBe(1)
    expect(() => launcher.resolveConfig('D:\\pkg', {}, { TRAINER_DB: 'relative.sqlite' })).toThrow(/absolute|绝对路径/)
  })

  it('parses launcher CLI arguments', () => {
    expect(launcher.parseArgs(['--no-open'])).toMatchObject({ openBrowser: false })
    expect(launcher.parseArgs(['--stop'])).toMatchObject({ stop: true })
    expect(launcher.parseArgs(['--root', 'a b', '--config=c.json'])).toMatchObject({ root: 'a b', configPath: 'c.json', openBrowser: true })
    expect(launcher.parseArgs(['--help'])).toMatchObject({ help: true })
    expect(() => launcher.parseArgs(['--wat'])).toThrow(/unknown argument|未知参数/)
  })
})

describe('release launcher package checks', () => {
  it('refuses an incomplete package and never builds implicitly', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rel-launch-'))
    activeRoots.add(base)
    await expect(launcher.launch({ root: base, openBrowser: false })).rejects.toThrow(/release\.json/)

    const root = join(base, 'pkg')
    await mkdir(join(root, 'server', 'dist'), { recursive: true })
    await mkdir(join(root, 'web', 'dist'), { recursive: true })
    await writeFile(join(root, 'release.json'), JSON.stringify({ appId: launcher.APP_ID }))
    await writeFile(join(root, 'server', 'dist', 'index.js'), 'export {}\n')
    await writeFile(join(root, 'web', 'dist', 'index.html'), '<!doctype html>')
    await expect(launcher.launch({ root, openBrowser: false, tdxCandidates: [] })).rejects.toThrow(/runtime|安装不完整/)
    await expect(readFile(join(root, 'server', 'dist', 'index.js'), 'utf8')).resolves.toContain('export')
  })

  it('refuses a release.json claiming another appId', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rel-launch-'))
    const root = join(base, 'pkg')
    activeRoots.add(base)
    await mkdir(join(root, 'server', 'dist'), { recursive: true })
    await mkdir(join(root, 'web', 'dist'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'release.json'), JSON.stringify({ appId: 'other-app' }))
    await writeFile(join(root, 'server', 'dist', 'index.js'), 'export {}\n')
    await writeFile(join(root, 'web', 'dist', 'index.html'), '<!doctype html>')
    await writeFile(join(root, 'runtime', NODE_BINARY), 'placeholder')
    await expect(launcher.launch({ root, openBrowser: false, tdxCandidates: [] })).rejects.toThrow(/appId/)
  })

  it('recognizes the TDX root layout used for discovery', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rel-launch-'))
    activeRoots.add(base)
    const tdx = join(base, 'tdx')
    await mkdir(join(tdx, 'vipdoc', 'sh', 'lday'), { recursive: true })
    await mkdir(join(tdx, 'T0002', 'hq_cache'), { recursive: true })
    await writeFile(join(tdx, 'vipdoc', 'sh', 'lday', 'sh600000.day'), 'x')
    expect(await launcher.isTdxRootPath(tdx)).toBe(true)
    expect(await launcher.isTdxRootPath(base)).toBe(false)
  })
})

describe('release launcher lifecycle', () => {
  it('starts once and reuses the owned healthy server on repeat launch', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    expect(root).toMatch(/[^\x00-\x7F]/)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: spawnCounter(dataDir) })
    expect(first.reused).toBe(false)
    expect(first.url).toBe(`http://127.0.0.1:${port}`)
    const health = await fetchHealth(first.url)
    expect(health).toMatchObject({ status: 200, body: { status: 'ok', runId: first.runId, pid: first.pid } })
    const state = JSON.parse(await readFile(join(dataDir, 'trainer-state.json'), 'utf8'))
    expect(state).toMatchObject({ appId: launcher.APP_ID, pid: first.pid, port, runId: first.runId })

    const second = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: spawnCounter(dataDir) })
    expect(second.reused).toBe(true)
    expect(second.pid).toBe(first.pid)
    expect(second.runId).toBe(first.runId)
    expect(second.url).toBe(first.url)
    expect(await spawnCount(dataDir)).toBe(1)
  }, 30_000)

  it('refuses a foreign port occupant without killing it or switching ports', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const occupant = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end('{"hello":1}\n')
    })
    await new Promise<void>(resolveListen => occupant.listen(0, '127.0.0.1', resolveListen))
    const address = occupant.address()
    const port = typeof address === 'object' && address ? address.port : 0
    activeClosers.push(() => new Promise(resolveClose => occupant.close(() => resolveClose())))
    await writeConfig(root, { port, dataDir })

    await expect(launchFixture(root)).rejects.toThrow(/occupied by another program|被其他程序占用/)
    expect(await (await fetch(new URL(`http://127.0.0.1:${port}/`))).text()).toContain('hello')
    await expect(readFile(spawnCounter(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(dataDir, 'trainer-state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('does not adopt a trainer-shaped server that has no launcher state', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    await rm(join(dataDir, 'trainer-state.json'), { force: true })
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })).rejects.toThrow(/without launcher state|没有对应的启动状态/)
    expect(await spawnCount(dataDir)).toBe(1)
    expect(await fetchHealth(first.url)).toMatchObject({ body: { pid: first.pid } })
  }, 30_000)

  it('refuses a second writer when the running server listens on another port', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    const changed = await freePort()
    await writeConfig(root, { port: changed, dataDir })
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })).rejects.toThrow(/still runs on port|仍在端口/)
    expect(await spawnCount(dataDir)).toBe(1)
  }, 30_000)

  it('keeps the server log when startup fails and records nothing in state', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })

    const failure = await launchFixture(root, { FIXTURE_MODE: 'crash' }).catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toMatch(/exited during startup|启动期间退出/)
    expect(failure.message).toContain(join(dataDir, 'server.log'))
    expect(await readFile(join(dataDir, 'server.log'), 'utf8')).toContain('fixture crash sentinel')
    await expect(readFile(join(dataDir, 'trainer-state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('rejects a readiness record that does not identify the launched server', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })

    await expect(launchFixture(root, { FIXTURE_MODE: 'wrongready' })).rejects.toThrow(/identity does not match|身份不匹配/)
    await expect(readFile(join(dataDir, 'trainer-state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('stops a server that never becomes ready and keeps its log', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const pidFile = join(dataDir, 'fixture.pid')

    await expect(launchFixture(root, { FIXTURE_MODE: 'hang', FIXTURE_PID_FILE: pidFile }, { startTimeoutMs: 800 }))
      .rejects.toThrow(/timed out|超时/)
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(launcher.pidAlive(pid)).toBe(false)
    expect(await readFile(join(dataDir, 'server.log'), 'utf8')).toContain('fixture hang mode')
  }, 30_000)

  it('recovers a stale launch lock after verifying its PID is dead', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)
    await mkdir(dataDir, { recursive: true })
    const staleLock = { appId: launcher.APP_ID, pid: deadPid(), startedAt: new Date().toISOString() }
    await writeFile(join(dataDir, 'launch.lock'), JSON.stringify(staleLock))

    const result = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(result.reused).toBe(false)
    expect(await spawnCount(dataDir)).toBe(1)
    await expect(readFile(join(dataDir, 'launch.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('waits for a live launcher lock and refuses to bypass it', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    await mkdir(dataDir, { recursive: true })
    const liveLock = { appId: launcher.APP_ID, pid: process.pid, startedAt: new Date().toISOString() }
    await writeFile(join(dataDir, 'launch.lock'), JSON.stringify(liveLock))

    await expect(launchFixture(root, {}, { lockWaitMs: 300 })).rejects.toThrow(/launch is in progress|另一个启动进程/)
    expect(await readFile(join(dataDir, 'launch.lock'), 'utf8')).toContain(String(process.pid))
  }, 30_000)

  it('refuses an unrecognized launch lock without deleting it', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'launch.lock'), '{"pid":123}')

    await expect(launchFixture(root)).rejects.toThrow(/unrecognized launch lock|无法识别的启动锁/)
    expect(await readFile(join(dataDir, 'launch.lock'), 'utf8')).toContain('"pid"')
  }, 30_000)

  it('clears stale state and readiness files, then starts fresh', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)
    const staleRunId = 'run-11111111-1111-1111-1111-111111111111'
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'trainer-state.json'), JSON.stringify({
      appId: launcher.APP_ID, runId: staleRunId, pid: deadPid(),
      port, baseURL: `http://127.0.0.1:${port}`,
    }))
    await writeFile(join(dataDir, 'ready.json'), '{"stale":true}')

    const result = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(result.reused).toBe(false)
    expect(result.runId).not.toBe(staleRunId)
    expect(await spawnCount(dataDir)).toBe(1)
    expect(await fetchHealth(result.url)).toMatchObject({ body: { runId: result.runId } })
  }, 30_000)
})

describe('release launcher stop lifecycle', () => {
  it('stops the recorded server on the RECORDED port even after the config port changed, keeps database and logs, and is idempotent', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: spawnCounter(dataDir) })
    await writeFile(join(dataDir, 'trainer.sqlite'), 'sqlite-marker-bytes')
    await expect(readFile(join(dataDir, 'server.log'), 'utf8')).resolves.toContain('fixture server')

    const editedPort = await freePort()
    await writeConfig(root, { port: editedPort, dataDir })
    const result = await stopFixture(root)
    expect(result).toMatchObject({ stopped: true, pid: first.pid, port })
    await waitForExit(first.pid)
    expect(launcher.pidAlive(first.pid)).toBe(false)
    await expect(readFile(stateFile(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(dataDir, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    // 数据库与日志必须保留（服务端 SQLite 使用 WAL，备份语义归根文档）。
    await expect(readFile(join(dataDir, 'trainer.sqlite'), 'utf8')).resolves.toBe('sqlite-marker-bytes')
    await expect(readFile(join(dataDir, 'server.log'), 'utf8')).resolves.toContain('fixture server')

    const again = await stopFixture(root)
    expect(again).toMatchObject({ stopped: false, noop: 'no-state' })
  }, 30_000)

  it('survives a stop/start loop without removing the persisted database', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    await writeFile(join(dataDir, 'trainer.sqlite'), 'user-data-v1')
    expect(await stopFixture(root)).toMatchObject({ stopped: true, pid: first.pid })
    await waitForExit(first.pid)

    const second = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(second.reused).toBe(false)
    expect(second.pid).not.toBe(first.pid)
    expect(await fetchHealth(second.url)).toMatchObject({ body: { runId: second.runId } })
    expect(await spawnCount(dataDir)).toBe(2)

    expect(await stopFixture(root)).toMatchObject({ stopped: true, pid: second.pid })
    await waitForExit(second.pid)
    await expect(readFile(join(dataDir, 'trainer.sqlite'), 'utf8')).resolves.toBe('user-data-v1')
    await expect(readFile(stateFile(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('refuses to signal a live server whose health identity does not match the recorded state, and preserves the state file', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })

    await launchFixture(root, { FIXTURE_SPAWN_COUNTER: spawnCounter(dataDir) })
    const { tampered } = await tamperStateRunId(dataDir)

    await expect(stopFixture(root)).rejects.toThrow(/does not answer as this record|无法确认它属于这条记录/)
    const state = JSON.parse(await readFile(stateFile(dataDir), 'utf8')) as { pid: number }
    expect(launcher.pidAlive(state.pid)).toBe(true)
    await expect(readFile(stateFile(dataDir), 'utf8')).resolves.toBe(tampered)
  }, 30_000)

  it('refuses an unreadable own state file and preserves it', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    await writeConfig(root, { dataDir })
    await writeRawState(dataDir, {
      appId: launcher.APP_ID, runId: 'not-a-run-id', pid: deadPid(), port: 1, baseURL: 'http://127.0.0.1:1',
    })

    await expect(stopFixture(root)).rejects.toThrow(/state file is unreadable|训练状态文件无法识别/)
    await expect(readFile(stateFile(dataDir), 'utf8')).resolves.toContain('not-a-run-id')
  }, 30_000)

  it('refuses a state file claiming another app and preserves it', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    await writeConfig(root, { dataDir })
    await writeRawState(dataDir, {
      appId: 'someone-else', runId: 'run-33333333-3333-3333-3333-333333333333', pid: deadPid(), port: 1, baseURL: 'http://127.0.0.1:1',
    })

    await expect(stopFixture(root)).rejects.toThrow(/belongs to another app|属于其他应用/)
    await expect(readFile(stateFile(dataDir), 'utf8')).resolves.toContain('someone-else')
  }, 30_000)

  it('cleans a dead recorded state without signaling any process', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const dead = deadPid()
    await writeRawState(dataDir, {
      appId: launcher.APP_ID, runId: 'run-44444444-4444-4444-4444-444444444444',
      pid: dead, port, baseURL: `http://127.0.0.1:${port}`,
    })

    const result = await stopFixture(root)
    expect(result).toMatchObject({ stopped: false, noop: 'already-dead', cleanedStaleState: true, pid: dead, port })
    await expect(readFile(stateFile(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('is a clear no-op without a data directory and creates nothing', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '不存在的 data')
    await writeConfig(root, { dataDir })

    expect(await stopFixture(root)).toMatchObject({ stopped: false, noop: 'no-state' })
    await expect(access(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })

    await mkdir(dataDir, { recursive: true })
    expect(await stopFixture(root)).toMatchObject({ stopped: false, noop: 'no-state' })
  }, 30_000)

  it('yields to a live lifecycle lock instead of racing it, leaving the server untouched', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: spawnCounter(dataDir) })
    const busyLock = { appId: launcher.APP_ID, pid: process.pid, startedAt: new Date().toISOString() }
    await writeFile(join(dataDir, 'launch.lock'), JSON.stringify(busyLock))

    await expect(stopFixture(root, {}, { lockWaitMs: 400 })).rejects.toThrow(/another launch or stop|另一个启动\/停止进程/)
    expect(launcher.pidAlive(first.pid)).toBe(true)
    await expect(readFile(stateFile(dataDir), 'utf8')).resolves.toContain(String(first.pid))
    await expect(fetchHealth(first.url)).resolves.toMatchObject({ body: { pid: first.pid } })
  }, 30_000)

  it('serializes a concurrent stop and launch so exactly one lifecycle owns the server', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    const [stopSettled, launchSettled] = await Promise.allSettled([
      stopFixture(root, {}, { lockWaitMs: 8_000 }),
      launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter }),
    ])
    expect(stopSettled).toMatchObject({ status: 'fulfilled' })
    expect(launchSettled).toMatchObject({ status: 'fulfilled' })
    const stopRes = (stopSettled as PromiseFulfilledResult<StopResult>).value
    const launchRes = (launchSettled as PromiseFulfilledResult<LaunchResult>).value

    // 无论先后顺序：原服务必须已退出，且最多重启一次，绝不双写。
    await waitForExit(first.pid)
    expect(launcher.pidAlive(first.pid)).toBe(false)
    const spawns = await spawnCount(dataDir)
    expect([1, 2]).toContain(spawns)
    if (stopRes.stopped) expect(stopRes.pid).toBe(first.pid)
    if (launchRes.reused) {
      expect(spawns).toBe(1)
      await expect(readFile(stateFile(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(spawns).toBe(2)
      expect(launchRes.pid).not.toBe(first.pid)
    }
  }, 30_000)
})

describe('release launcher launch guards', () => {
  it('refuses to replace a live recorded server it cannot verify and never spawns a second writer, even on another configured port', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    const { tampered } = await tamperStateRunId(dataDir)

    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter }))
      .rejects.toThrow(/does not answer as this record|无法确认它属于这条记录/)
    expect(await spawnCount(dataDir)).toBe(1)
    expect(launcher.pidAlive(first.pid)).toBe(true)
    await expect(readFile(stateFile(dataDir), 'utf8')).resolves.toBe(tampered)

    // 危险场景回归：配置换端口后，旧实现会清状态并在新端口再开一个写库进程。
    const otherPort = await freePort()
    await writeConfig(root, { port: otherPort, dataDir })
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter }))
      .rejects.toThrow(/does not answer as this record|无法确认它属于这条记录/)
    expect(await spawnCount(dataDir)).toBe(1)
    expect(launcher.pidAlive(first.pid)).toBe(true)
    await expect(readFile(stateFile(dataDir), 'utf8')).resolves.toBe(tampered)
  }, 30_000)

  it('refuses reuse when the requested databasePath differs and tells the user to stop first', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter, TRAINER_DB: join(dataDir, 'other.sqlite') }))
      .rejects.toThrow(/does not match this launch|与本次启动不一致/)
    expect(await spawnCount(dataDir)).toBe(1)
    expect(launcher.pidAlive(first.pid)).toBe(true)
    await expect(fetchHealth(first.url)).resolves.toMatchObject({ body: { pid: first.pid } })
  }, 30_000)

  it('refuses reuse of a server from a different release version or git commit, then reuses after the package matches again', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)
    const releasePath = join(root, 'release.json')

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    const upgradedVersion = { appId: launcher.APP_ID, version: '0.9.0-test', gitCommit: 'fixture' }
    await writeFile(releasePath, JSON.stringify(upgradedVersion))
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter }))
      .rejects.toThrow(/version 0\.3\.0-test != 0\.9\.0-test/)

    const upgradedCommit = { appId: launcher.APP_ID, version: '0.3.0-test', gitCommit: 'upgraded' }
    await writeFile(releasePath, JSON.stringify(upgradedCommit))
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter }))
      .rejects.toThrow(/gitCommit fixture != upgraded/)

    const restored = { appId: launcher.APP_ID, version: '0.3.0-test', gitCommit: 'fixture' }
    await writeFile(releasePath, JSON.stringify(restored))
    const again = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(again.reused).toBe(true)
    expect(again.pid).toBe(first.pid)
    expect(await spawnCount(dataDir)).toBe(1)
  }, 30_000)

  it('refuses reuse when the resolved tdxRoot differs from the recorded one', async () => {
    const root = await makeFixture()
    const base = resolve(root, '..')
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    const tdx = join(base, 'tdx-fixture')
    await mkdir(join(tdx, 'vipdoc', 'sh', 'lday'), { recursive: true })
    await mkdir(join(tdx, 'T0002', 'hq_cache'), { recursive: true })
    await writeFile(join(tdx, 'vipdoc', 'sh', 'lday', 'sh600000.day'), 'x')
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(first.tdxRoot).toBeNull()
    const recorded = JSON.parse(await readFile(stateFile(dataDir), 'utf8')) as { tdxRoot?: unknown }
    expect(recorded.tdxRoot).toBeNull()

    await writeConfig(root, { port, dataDir, tdxRoot: tdx })
    await expect(launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter, TDX_ROOT: '' }))
      .rejects.toThrow(/tdxRoot/)

    await writeConfig(root, { port, dataDir })
    const again = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(again.reused).toBe(true)
    expect(again.pid).toBe(first.pid)
  }, 30_000)

  it('reuses a legacy state that predates the optional compatibility fields', async () => {
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    const port = await freePort()
    await writeConfig(root, { port, dataDir })
    const counter = spawnCounter(dataDir)

    const first = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    await writeRawState(dataDir, {
      appId: launcher.APP_ID, runId: first.runId, pid: first.pid, port, baseURL: first.url,
    })
    const again = await launchFixture(root, { FIXTURE_SPAWN_COUNTER: counter })
    expect(again.reused).toBe(true)
    expect(again.pid).toBe(first.pid)
    expect(await spawnCount(dataDir)).toBe(1)
  }, 30_000)
})

describe('release launcher probe hardening', () => {
  it('does not follow redirects when probing health, so a foreign listener cannot move the identity check', async () => {
    let targetHits = 0
    // 目标只回固定纯文本：本用例只关心命中次数与状态码，不涉及身份内容。
    const target = http.createServer((_request, response) => {
      targetHits += 1
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('target-ok')
    })
    await new Promise<void>(resolveListen => target.listen(0, '127.0.0.1', resolveListen))
    const targetAddress = target.address()
    const targetPort = typeof targetAddress === 'object' && targetAddress ? targetAddress.port : 0
    activeClosers.push(() => new Promise(resolveClose => target.close(() => resolveClose())))

    const redirector = http.createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/api/health` })
      response.end()
    })
    await new Promise<void>(resolveListen => redirector.listen(0, '127.0.0.1', resolveListen))
    const redirectAddress = redirector.address()
    const redirectPort = typeof redirectAddress === 'object' && redirectAddress ? redirectAddress.port : 0
    activeClosers.push(() => new Promise(resolveClose => redirector.close(() => resolveClose())))

    // 阳性对照：目标本身可达且返回 200。
    const control = await launcher.probeHealth(targetPort)
    expect(control).toMatchObject({ responded: true, refused: false, status: 200 })
    expect(targetHits).toBe(1)

    const probe = await launcher.probeHealth(redirectPort)
    expect(probe.responded).toBe(false)
    expect(probe.refused).toBe(false)
    expect(targetHits).toBe(1)
  }, 30_000)

  it('only accepts health identity over HTTP 200: the same body on a 500 never confirms', async () => {
    // 直接以 500 状态运行夹具服务：健康端点返回 200 身份语义由所有成功
    // launch 用例覆盖，这里证明 500 + 同样的身份内容不会通过确认。
    const root = await makeFixture()
    const dataDir = join(root, '数 据 dir')
    await mkdir(dataDir, { recursive: true })
    const port = await freePort()
    const readyFile = join(dataDir, 'ready.json')
    const runId = 'run-66666666-6666-6666-6666-666666666666'
    const child = spawn(process.execPath, [join(root, 'server', 'dist', 'index.js')], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PORT: String(port),
        TRAINER_RUN_ID: runId,
        TRAINER_READY_FILE: readyFile,
        FIXTURE_HEALTH_STATUS: '500',
      },
      stdio: 'ignore',
    })
    activePids.add(child.pid)
    // 夹具在监听后才写 ready 文件，轮询等待而不是立刻读取。
    let ready: { pid: number, port: number }
    for (let attempt = 0; ; attempt++) {
      try {
        ready = JSON.parse(await readFile(readyFile, 'utf8')) as { pid: number, port: number }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 50) throw error
        await delay(100)
      }
    }
    expect(ready.port).toBe(port)
    expect(await launcher.confirmOwnedServer({ runId, pid: ready.pid, port })).toBe(false)
  }, 30_000)

  it('openURL survives a failing opener instead of crashing the launcher', async () => {
    const failingSpawn = () => {
      const fake = new EventEmitter() as EventEmitter & { unref(): void }
      fake.unref = () => {}
      // 模拟真实 spawn 行为：ENOENT 以异步 'error' 事件到达。
      // Regression: without an 'error' listener this escapes as an uncaught
      // exception and kills the launcher after the server already started.
      queueMicrotask(() => fake.emit('error', Object.assign(new Error('spawn fake ENOENT'), { code: 'ENOENT' })))
      return fake
    }
    await expect(launcher.openURL('http://127.0.0.1:9/', failingSpawn as never)).resolves.toBe(false)
  }, 30_000)
})
