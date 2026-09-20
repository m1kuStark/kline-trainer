'use strict'
/**
 * A股K线训练器 便携版启动器 / Portable launcher for the packaged release.
 *
 * Runs from the package root with the bundled Node runtime (no third-party
 * modules, CommonJS so it loads without a package.json "type" resolution).
 * Package root is the directory containing this script; --root PATH overrides
 * it for unit fixtures. Everything writable lives in the configured data
 * directory, never inside the (possibly read-only) package.
 */

const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const {
  access, appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile,
} = require('node:fs/promises')
const { homedir } = require('node:os')
const { dirname, isAbsolute, join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const APP_ID = 'a-share-kline-trainer'
const DEFAULT_PORT = 8787
const DATA_DIR_NAME = '.a-share-kline-trainer'
const STATE_FILE = 'trainer-state.json'
const LOCK_FILE = 'launch.lock'
const READY_FILE = 'ready.json'
const SERVER_LOG = 'server.log'
const LAUNCHER_LOG = 'launcher.log'
const READY_TIMEOUT_MS = 30_000
const LOCK_WAIT_MS = 15_000
const STOP_EXIT_TIMEOUT_MS = 5_000

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

// 单机常见通达信安装位置，按顺序探测；首个命中的生效。
// Common single-user TDX installations probed in order.
const TDX_CANDIDATES = ['D:\\MySoftWares\\TDX', 'C:\\new_tdx', 'C:\\通达信']

function usage() {
  return [
    '用法 / Usage: node launcher.cjs [--root PATH] [--config PATH] [--no-open] [--stop]',
    '',
    '  --root PATH    包根目录 / package root (default: the directory holding launcher.cjs)',
    '  --config PATH  配置文件 / config file (default: <root>/trainer.config.json, optional)',
    '  --no-open      不自动打开浏览器 / do not open a browser window',
    '  --stop         停止已记录的训练服务后退出 / stop the recorded trainer, then exit',
    '',
    '停止只针对本启动器记录的服务：先核对状态与 127.0.0.1 健康身份，只结束',
    '验证过的那个 PID；无法验证时拒绝并保留状态文件。数据库与日志始终保留。',
    'Stop only targets the service this launcher recorded (state + health identity',
    'on the recorded 127.0.0.1 port, exact verified PID only); it refuses and keeps',
    'the state file when identity cannot be proven. Database and logs are kept.',
    '',
    '配置字段 / config fields: tdxRoot, port (default 8787), dataDir, databasePath (absolute).',
    '环境变量优先于配置文件 / environment overrides the config file when set:',
    '  TDX_ROOT=<absolute path>  TRAINER_DB=<absolute sqlite path>',
  ].join('\n')
}

function parseArgs(argv) {
  const parsed = { openBrowser: true }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = name => {
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
      if (arg !== `--${name}`) return undefined
      index += 1
      if (index >= argv.length) throw new Error(`缺少参数值 / missing value for ${arg}`)
      return argv[index]
    }
    const root = value('root')
    if (root !== undefined) { parsed.root = root; continue }
    const config = value('config')
    if (config !== undefined) { parsed.configPath = config; continue }
    if (arg === '--no-open') { parsed.openBrowser = false; continue }
    if (arg === '--stop') { parsed.stop = true; continue }
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue }
    throw new Error(`未知参数 / unknown argument: ${arg}\n\n${usage()}`)
  }
  return parsed
}

async function readConfigFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`无法读取配置文件 / cannot read config file ${path}: ${error && error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`配置文件不是有效 JSON / config file is not valid JSON: ${path} (${error && error.message})`)
  }
}

function requireSanePort(value) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`配置端口无效 / config port must be an integer in 1..65535, got ${JSON.stringify(value ?? null)}`)
  }
  return port
}

/**
 * Normalize the optional trainer.config.json plus documented environment
 * overrides. Relative tdxRoot/dataDir paths resolve against the package root;
 * databasePath must be absolute so a relative typo cannot silently point into
 * a read-only package.
 */
function resolveConfig(root, raw, env = {}) {
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`配置文件内容必须是 JSON 对象 / config file must contain a JSON object`)
  }
  const fields = raw ?? {}
  const text = key => (typeof fields[key] === 'string' ? fields[key].trim() : '')
  const config = { port: requireSanePort(fields.port ?? DEFAULT_PORT) }
  const dataDir = text('dataDir')
  config.dataDir = dataDir ? resolve(root, dataDir) : join(homedir(), DATA_DIR_NAME)
  const databasePath = text('databasePath')
  if (databasePath) {
    if (!isAbsolute(databasePath)) {
      throw new Error(`databasePath 必须是绝对路径 / databasePath must be an absolute path: ${databasePath}`)
    }
    config.databasePath = resolve(databasePath)
  } else {
    config.databasePath = join(config.dataDir, 'trainer.sqlite')
  }
  const tdxRoot = text('tdxRoot')
  config.tdxRoot = tdxRoot ? resolve(root, tdxRoot) : null
  const envTdxRoot = typeof env.TDX_ROOT === 'string' ? env.TDX_ROOT.trim() : ''
  if (envTdxRoot) config.tdxRoot = resolve(envTdxRoot)
  const envDatabase = typeof env.TRAINER_DB === 'string' ? env.TRAINER_DB.trim() : ''
  if (envDatabase) {
    if (!isAbsolute(envDatabase)) {
      throw new Error(`TRAINER_DB 必须是绝对路径 / TRAINER_DB must be an absolute path: ${envDatabase}`)
    }
    config.databasePath = resolve(envDatabase)
  }
  return config
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    return !(error && error.code === 'ENOENT')
  }
}

async function isTdxRootPath(root) {
  let hasDaily = false
  for (const market of ['sh', 'sz', 'bj']) {
    const names = await readdir(join(root, 'vipdoc', market, 'lday')).catch(() => null)
    if (names && names.some(name => name.toLowerCase().endsWith('.day'))) hasDaily = true
  }
  return hasDaily && await pathExists(join(root, 'T0002', 'hq_cache'))
}

async function discoverTdxRoot(candidates) {
  for (const candidate of candidates) {
    const root = resolve(candidate)
    if (await isTdxRootPath(root)) return root
  }
  return null
}

/** Validate the fixed release layout; never builds anything. */
async function inspectPackage(root) {
  let release
  try {
    release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
  } catch (error) {
    throw new Error(`缺少有效的 release.json / not a trainer package, missing valid release.json in ${root} (${error && error.message})`)
  }
  if (!release || release.appId !== APP_ID) {
    throw new Error(`release.json appId 应为 "${APP_ID}" / unexpected release.json appId: ${JSON.stringify(release && release.appId)}`)
  }
  const nodePath = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const serverScript = join(root, 'server', 'dist', 'index.js')
  const webDir = join(root, 'web', 'dist')
  const missing = []
  for (const [label, path] of [['runtime node', nodePath], ['server/dist/index.js', serverScript], ['web/dist', webDir]]) {
    if (!(await pathExists(path))) missing.push(label)
  }
  if (missing.length) {
    throw new Error(`安装不完整，缺少 ${missing.join('、')} / incomplete package, missing ${missing.join(', ')}; re-extract the full package: ${root}`)
  }
  return {
    release,
    nodePath,
    serverScript,
    webDir,
    version: typeof release.version === 'string' ? release.version : 'unknown',
    gitCommit: typeof release.gitCommit === 'string' ? release.gitCommit : 'unknown',
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function isTrainerHealth(value) {
  return Boolean(value && typeof value === 'object'
    && value.status === 'ok'
    && typeof value.runId === 'string'
    && Number.isInteger(value.pid))
}

/** True when a probe carries this state's own health identity over HTTP 200. */
function probeMatchesState(probe, state) {
  return Boolean(probe && probe.responded && probe.status === 200 && isTrainerHealth(probe.json)
    && probe.json.runId === state.runId && probe.json.pid === state.pid)
}

/**
 * One /api/health probe against 127.0.0.1 only (port is a validated integer).
 * `refused` marks a definitively free port; everything else is either a
 * response or an unknown listener. redirect:'error' so a foreign loopback
 * listener cannot move the identity check to another host by answering with
 * a redirect; the body only counts as identity on HTTP 200.
 */
async function probeHealth(port, { timeoutMs = 1_200 } = {}) {
  const url = `http://127.0.0.1:${port}/api/health`
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    let json = null
    if (response.status === 200) {
      try { json = await response.json() } catch { json = null }
    }
    return { responded: true, refused: false, status: response.status, json }
  } catch (error) {
    const cause = error && error.cause && error.cause.code
    return { responded: false, refused: cause === 'ECONNREFUSED', reason: `${(error && error.message) || error}${cause ? ` (${cause})` : ''}` }
  }
}

/** Confirm the recorded state still identifies the live healthy server. */
async function confirmOwnedServer(state, { attempts = 3, timeoutMs = 1_200 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (probeMatchesState(await probeHealth(state.port, { timeoutMs }), state)) return true
    if (attempt + 1 < attempts) await delay(250)
  }
  return false
}

function statePath(dataDir) { return join(dataDir, STATE_FILE) }
function lockPath(dataDir) { return join(dataDir, LOCK_FILE) }

function assertStateIdentity(value) {
  if (!value || typeof value !== 'object') throw new Error('state is not an object')
  if (typeof value.runId !== 'string' || !/^run-[0-9a-f-]{36}$/.test(value.runId)) throw new Error('state runId is invalid')
  if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('state pid is invalid')
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('state port is invalid')
  if (value.baseURL !== `http://127.0.0.1:${value.port}`) throw new Error('state baseURL does not match the port')
  return value
}

/**
 * Read our own server record. Returns null when absent, {state} when valid,
 * {stale, pid?} for ours-but-broken content (pid is the best-effort recorded
 * value, used to refuse replacing a possibly-live owner), and throws for a
 * file claiming a different appId so foreign data is never cleared.
 */
async function readOwnedState(dataDir) {
  let raw
  try {
    raw = await readFile(statePath(dataDir), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`无法读取服务状态 / cannot read server state ${statePath(dataDir)}: ${error && error.message}`)
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { stale: 'state file is not valid JSON' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { stale: 'state file is not an object' }
  if (value.appId !== APP_ID) {
    throw new Error(`服务状态属于其他应用 (${JSON.stringify(value.appId)})，拒绝处理 / state file belongs to another app: ${statePath(dataDir)}`)
  }
  try {
    return { state: assertStateIdentity(value) }
  } catch (error) {
    return { stale: error.message, pid: Number.isInteger(value.pid) && value.pid >= 1 ? value.pid : null }
  }
}

async function writeStateFile(dataDir, state) {
  const path = statePath(dataDir)
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}

async function clearState(dataDir) {
  await rm(statePath(dataDir), { force: true })
}

function unverifiableOwnerMessage(state) {
  return `已记录的训练服务进程仍在运行（PID ${state.pid}，端口 ${state.port}），但通过 127.0.0.1:${state.port}/api/health 无法确认它属于这条记录（runId/PID 不匹配或健康端点不可达）；`
    + `为避免两个服务写同一个数据库，启动器不会清除该记录，也不会再启动新服务。请先确认并结束该进程（任务管理器中的 PID ${state.pid}）后重试 / `
    + `a recorded trainer process is still alive (PID ${state.pid}, port ${state.port}) but does not answer as this record on 127.0.0.1:${state.port}/api/health `
    + `(runId/PID mismatch or health unreachable); to avoid two writers on one database the launcher will not erase the record or start a second server — `
    + `end that process first (verify PID ${state.pid} in Task Manager), then retry`
}

/**
 * Decide what launch may do with a recorded state: 'reuse' (verified live
 * owner), 'clean' (recorded PID provably dead, or stale content with no live
 * recorded PID), or throw for a live owner that cannot be verified. Never
 * clears a state whose recorded PID is still alive: an unverified live owner
 * may be writing the same database, so replacing it could start a second
 * writer. Callers must run this under the launch lock: a concurrent stop
 * (which takes the same lock to verify and signal) must never be observable
 * mid-kill as "recorded PID alive but health already gone".
 */
async function decideRecordedServer(dataDir) {
  const existing = await readOwnedState(dataDir)
  if (!existing) return { action: 'absent' }
  if (existing.state) {
    if (!pidAlive(existing.state.pid)) return { action: 'clean', state: existing.state }
    if (await confirmOwnedServer(existing.state)) return { action: 'reuse', state: existing.state }
    throw new Error(unverifiableOwnerMessage(existing.state))
  }
  if (existing.pid && pidAlive(existing.pid)) {
    throw new Error(`训练状态文件无法识别（${existing.stale}），但其中记录的进程（PID ${existing.pid}）仍在运行；`
      + `启动器不会覆盖可能仍在运行的服务。请确认后结束该进程，或确认它不是训练器后手动删除状态文件 / `
      + `the state file is unreadable (${existing.stale}) but its recorded process (PID ${existing.pid}) is still alive; `
      + `the launcher will not replace a possibly-live owner — end that process, or delete the state file manually after making sure it is not a trainer`)
  }
  return { action: 'clean' }
}

async function readLockInfo(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Create the launch lock ('wx' exclusive). On an existing lock: recover it
 * after verifying the recorded PID is dead; report it otherwise. Never
 * touches a lock held by a live process.
 */
async function acquireLaunchLock(dataDir) {
  const path = lockPath(dataDir)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const handle = await open(path, 'wx')
      const info = { appId: APP_ID, pid: process.pid, startedAt: new Date().toISOString() }
      await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`)
      await handle.close()
      return { path, owned: true, info }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw new Error(`无法创建启动锁 / cannot create launch lock ${path}: ${error && error.message}`)
      }
      const existing = await readLockInfo(path)
      if (existing && existing.appId === APP_ID && Number.isInteger(existing.pid) && existing.pid >= 1) {
        if (!pidAlive(existing.pid)) {
          await rm(path, { force: true })
          continue
        }
        return { path, owned: false, info: existing }
      }
      return { path, owned: false, info: null }
    }
  }
  throw new Error(`启动锁反复被占用 / launch lock at ${path} kept reappearing`)
}

/**
 * Best-effort browser open; resolves false when the opener is missing or
 * fails. Never throws: a missing browser must not crash the launcher after
 * the server is already up. Argument array only, no shell user input.
 * `spawnImpl` exists so tests can inject a failing opener.
 */
function openURL(url, spawnImpl = spawn) {
  return new Promise(resolveOpened => {
    let settled = false
    const finish = opened => {
      if (settled) return
      settled = true
      resolveOpened(opened)
    }
    let child
    try {
      if (process.platform === 'win32') {
        // Argument array, no shell string: safe for spaces, Chinese and "&" paths.
        child = spawnImpl('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      } else if (process.platform === 'darwin') {
        child = spawnImpl('open', [url], { detached: true, stdio: 'ignore' })
      } else {
        child = spawnImpl('xdg-open', [url], { detached: true, stdio: 'ignore' })
      }
    } catch {
      finish(false)
      return
    }
    // Without this listener a spawn 'error' (e.g. ENOENT) escapes as an
    // uncaught exception and kills the launcher.
    child.once('error', () => finish(false))
    if (typeof child.unref === 'function') child.unref()
    delay(500).then(() => finish(true))
  })
}

/** Stop a child this launcher spawned; never signals unknown processes. */
async function stopOwnedChild(child) {
  if (!child || !child.pid) return
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  } catch { /* already gone */ }
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, delay(3_000)])
}

async function waitForReady({ child, readyFile, runId, port, timeoutMs, logPath }) {
  const deadline = Date.now() + timeoutMs
  const expectedURL = `http://127.0.0.1:${port}`
  let spawnFailure = null
  child.once('error', error => { spawnFailure = error })
  let lastTransient = null
  while (Date.now() < deadline) {
    if (spawnFailure) throw new Error(`无法启动服务进程 / failed to start server process: ${spawnFailure.message}`)
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`服务进程在启动期间退出（code ${child.exitCode ?? child.signalCode}），日志 / server exited during startup, log: ${logPath}`)
    }
    let ready
    try {
      ready = JSON.parse(await readFile(readyFile, 'utf8'))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        await delay(120)
        continue
      }
      throw new Error(`ready 文件损坏 / readiness file is not valid JSON: ${readyFile}`)
    }
    if (!ready || typeof ready !== 'object'
      || ready.runId !== runId || ready.pid !== child.pid
      || ready.port !== port || ready.baseURL !== expectedURL) {
      throw new Error(`ready 身份不匹配 / readiness identity does not match the launched server: ${JSON.stringify(ready)}`)
    }
    const probe = await probeHealth(port, { timeoutMs: 1_000 })
    if (probeMatchesState(probe, { runId, pid: child.pid })) {
      return { baseURL: expectedURL }
    }
    if (probe.responded) {
      throw new Error(`健康检查身份不匹配 / health identity does not match the launched server on ${expectedURL}`)
    }
    lastTransient = probe.reason
    await delay(120)
  }
  await stopOwnedChild(child)
  await rm(readyFile, { force: true }).catch(() => {})
  throw new Error(`启动超时（${Math.round(timeoutMs / 1000)} 秒）未就绪，日志 / readiness timed out, log: ${logPath}${lastTransient ? `; last probe: ${lastTransient}` : ''}`)
}

async function reuseResult(state, { dataDir, tdxRoot, openBrowser: shouldOpen }) {
  let openedBrowser = false
  if (shouldOpen) openedBrowser = await openURL(state.baseURL)
  return {
    reused: true,
    url: state.baseURL,
    port: state.port,
    pid: state.pid,
    runId: state.runId,
    dataDir,
    logPath: join(dataDir, SERVER_LOG),
    tdxRoot,
    openedBrowser,
  }
}

function assertPortMatchesRunning(state, config) {
  if (state.port !== config.port) {
    throw new Error(`之前的训练服务仍运行在端口 ${state.port}（PID ${state.pid}），而配置要求端口 ${config.port}；`
      + `为避免两个服务写同一个数据库，请先运行 Stop.cmd 停止旧服务或将端口改回 ${state.port} / `
      + `a previous trainer still runs on port ${state.port} (PID ${state.pid}) while the config asks for ${config.port}; `
      + `run Stop.cmd first, or set the port back, to avoid two writers on one database`)
  }
}

/**
 * A reused server must be the SAME release asking for the SAME database as
 * this launch; anything else would either mix releases or put two writers on
 * one database. Semantics: reuse means "the service recorded in this
 * dataDir, from this release, with this config" — not necessarily the same
 * copy of the package on disk. States written before these fields existed
 * (version/gitCommit/databasePath/tdxRoot absent) are tolerated: they carry
 * nothing comparable. tdxRoot only gates reuse, never stop.
 */
function assertReuseCompatible(state, { config, layout, tdxRoot }) {
  const problems = []
  if (typeof state.databasePath === 'string' && !samePath(state.databasePath, config.databasePath)) {
    problems.push(`databasePath ${state.databasePath} != ${config.databasePath}`)
  }
  if (typeof state.version === 'string' && state.version !== layout.version) {
    problems.push(`version ${state.version} != ${layout.version}`)
  }
  if (typeof state.gitCommit === 'string' && state.gitCommit !== layout.gitCommit) {
    problems.push(`gitCommit ${state.gitCommit} != ${layout.gitCommit}`)
  }
  if ((typeof state.tdxRoot === 'string' || state.tdxRoot === null)
    && !samePath(state.tdxRoot ?? '', tdxRoot ?? '')) {
    problems.push(`tdxRoot ${state.tdxRoot ?? '(none)'} != ${tdxRoot ?? '(none)'}`)
  }
  if (!problems.length) return
  throw new Error(`已记录的训练服务（端口 ${state.port}，PID ${state.pid}）与本次启动不一致（${problems.join('; ')}）；`
    + `为避免新旧版本混用或两个服务写同一个数据库，请先运行 Stop.cmd 停止旧服务再启动 / `
    + `the recorded trainer (port ${state.port}, PID ${state.pid}) does not match this launch (${problems.join('; ')}); `
    + `run Stop.cmd to stop it first — never mix releases or run two writers on one database`)
}

/**
 * Launch (or reuse) the trainer server. Returns a result summary; throws
 * actionable errors. Options: root, configPath, openBrowser, env,
 * tdxCandidates, startTimeoutMs, lockWaitMs.
 */
async function launch(options = {}) {
  const root = resolve(options.root ?? __dirname)
  const env = options.env ?? process.env
  const layout = await inspectPackage(root)
  const configPath = options.configPath ? resolve(options.configPath) : join(root, 'trainer.config.json')
  const config = resolveConfig(root, await readConfigFile(configPath), env)
  const dataDir = config.dataDir
  try {
    try {
      await mkdir(dataDir, { recursive: true })
      await mkdir(dirname(config.databasePath), { recursive: true })
    } catch (error) {
      throw new Error(`数据目录不可写 / data directory is not writable: ${dataDir} (${error && error.message})`)
    }

    const tdxRoot = config.tdxRoot
      ? (await isTdxRootPath(config.tdxRoot) ? config.tdxRoot : null)
      : await discoverTdxRoot(options.tdxCandidates ?? TDX_CANDIDATES)
    if (config.tdxRoot && !tdxRoot) {
      throw new Error(`配置的 tdxRoot 不是有效的通达信目录（需要 vipdoc\\<市场>\\lday 下有 .day 文件且存在 T0002\\hq_cache）：${config.tdxRoot} / `
        + `configured tdxRoot does not look like a TDX installation: ${config.tdxRoot}`)
    }

    // Every reuse/cleanup decision runs under the same single-flight lock
    // stop() uses, so a concurrent stop can never be observed mid-kill.
    // Deciding outside the lock once read the state with a live PID and then
    // failed health confirmation after the stop's SIGKILL, rejecting a
    // legitimate stop as an "unverifiable owner" (and a pre-lock reuse could
    // hand back a server the stop was already killing). A bounded retry loop
    // re-evaluates state after waiting out a contender instead of recursing.
    for (let round = 0; ; round++) {
      if (round >= 4) {
        throw new Error('启动竞争多次发生，请稍后重试 / repeated launch contention on the same data directory; try again shortly')
      }

      // 1) Single-flight lock so two clicks cannot spawn two DB writers and
      //    launch cannot race a concurrent stop's verify-and-kill.
      const lock = await acquireLaunchLock(dataDir)
      if (!lock.owned) {
        if (!lock.info) {
          throw new Error(`存在无法识别的启动锁 ${lock.path}；确认没有其他训练器窗口后可手动删除该文件 / `
            + `unrecognized launch lock; delete the file manually if no other trainer window is open`)
        }
        const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS)
        let released = false
        while (Date.now() < deadline) {
          if (!(await pathExists(lock.path))) {
            released = true
            break
          }
          await delay(150)
        }
        if (!released) {
          throw new Error(`另一个启动/停止进程仍在进行（PID ${lock.info.pid}）／ another launch or stop is in progress (PID ${lock.info.pid})`)
        }
        // The owner released its lock without leaving a reusable server
        // (its start failed, or it was a stop); loop around and decide
        // again under our own lock acquisition.
        await delay(150)
        continue
      }

      try {
        // 2) Under the lock: reuse only our own recorded server (state file
        //    + live PID + matching health identity), clean provably dead
        //    records, refuse live-but-unverifiable owners.
        const existing = await decideRecordedServer(dataDir)
        if (existing.action === 'reuse') {
          assertPortMatchesRunning(existing.state, config)
          assertReuseCompatible(existing.state, { config, layout, tdxRoot })
          return await reuseResult(existing.state, { dataDir, tdxRoot, openBrowser: options.openBrowser ?? true })
        }
        if (existing.action === 'clean') await clearState(dataDir)

        // 3) Stable port only: refuse a foreign occupant, never kill, never auto-change.
        const occupancy = await probeHealth(config.port, { timeoutMs: 1_200 })
        if (!occupancy.refused) {
          if (occupancy.responded && isTrainerHealth(occupancy.json)) {
            throw new Error(`端口 ${config.port} 上有训练器服务（PID ${occupancy.json.pid}）但没有对应的启动状态，可能来自旧版本或手动启动；`
              + `请先关闭该进程或更换端口 / port ${config.port} is served by a trainer process without launcher state (PID ${occupancy.json.pid}); close it or choose another port`)
          }
          throw new Error(`端口 ${config.port} 已被其他程序占用；启动器不会更换端口或结束其他进程 / `
            + `port ${config.port} is occupied; the launcher will not change ports or kill other processes`)
        }

        // 4) Start the detached server: no IPC, hidden window, logs in dataDir.
        const runId = `run-${randomUUID()}`
        const readyFile = join(dataDir, READY_FILE)
        const logPath = join(dataDir, SERVER_LOG)
        await rm(readyFile, { force: true })
        const log = await open(logPath, 'a')
        let child
        try {
          await log.write(`\n[${new Date().toISOString()}] launcher v${layout.version} (${layout.gitCommit}) `
            + `starting run ${runId} on port ${config.port} with database ${config.databasePath}\n`)
          child = spawn(layout.nodePath, [layout.serverScript], {
            cwd: root,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', log.fd, log.fd],
            env: {
              ...env,
              TRAINER_RUN_ID: runId,
              TRAINER_DB: config.databasePath,
              TRAINER_STATIC_DIR: layout.webDir,
              TRAINER_READY_FILE: readyFile,
              TDX_ROOT: tdxRoot ?? '',
              HOST: '127.0.0.1',
              PORT: String(config.port),
              OPEN_BROWSER: '0',
            },
          })
          child.unref()
          try {
            const { baseURL } = await waitForReady({
              child, readyFile, runId, port: config.port,
              timeoutMs: options.startTimeoutMs ?? READY_TIMEOUT_MS, logPath,
            })
            const state = {
              appId: APP_ID,
              runId,
              pid: child.pid,
              port: config.port,
              baseURL,
              startedAt: new Date().toISOString(),
              version: layout.version,
              gitCommit: layout.gitCommit,
              databasePath: config.databasePath,
              tdxRoot: tdxRoot ?? null,
            }
            await writeStateFile(dataDir, state)
            let openedBrowser = false
            if (options.openBrowser ?? true) {
              try {
                openURL(baseURL)
                openedBrowser = true
              } catch { /* user can open the URL manually */ }
            }
            return {
              reused: false,
              url: baseURL,
              port: config.port,
              pid: child.pid,
              runId,
              dataDir,
              logPath,
              tdxRoot,
              openedBrowser,
            }
          } catch (error) {
            // Startup failure: keep the log for diagnosis, stop only our own child.
            await stopOwnedChild(child)
            await rm(readyFile, { force: true }).catch(() => {})
            throw error
          }
        } finally {
          await log.close().catch(() => {})
        }
      } finally {
        if (lock.owned) await rm(lock.path, { force: true }).catch(() => {})
      }
    }
  } catch (error) {
    if (error && typeof error === 'object') error.dataDir = dataDir
    throw error
  }
}

/**
 * Stop the trainer recorded in the configured dataDir. Same config resolution
 * as launch, but targeting is always the RECORDED port, so editing the config
 * port cannot hide a running service. Serialized with launch through the same
 * launch lock. Signals only the exact recorded PID after proving identity
 * (state appId/runId/pid plus a live HTTP 200 /api/health match on
 * 127.0.0.1); never kills a process tree, never kills by port. No state is a
 * clear no-op; a dead recorded PID is cleaned without signaling; invalid or
 * live-but-unverifiable state is an actionable refusal that preserves the
 * file. Database, WAL sidecar files and logs are always kept. Success also
 * waits (bounded) for the recorded port to refuse connections again, so an
 * immediately following Start.cmd does not hit a lingering listener.
 * Options: root, configPath, env, lockWaitMs, exitTimeoutMs, portDrainTimeoutMs.
 */
async function stop(options = {}) {
  const root = resolve(options.root ?? __dirname)
  const env = options.env ?? process.env
  const configPath = options.configPath ? resolve(options.configPath) : join(root, 'trainer.config.json')
  const config = resolveConfig(root, await readConfigFile(configPath), env)
  const dataDir = config.dataDir
  try {
    // No dataDir means launch never got as far as creating one: nothing to stop.
    if (!(await pathExists(dataDir))) return { stopped: false, noop: 'no-state', dataDir }

    // Serialize against launch and other stops; bounded wait, then refuse.
    const lockDeadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS)
    for (;;) {
      const lock = await acquireLaunchLock(dataDir)
      if (lock.owned) {
        try {
          return await stopRecorded(dataDir, options)
        } finally {
          await rm(lock.path, { force: true }).catch(() => {})
        }
      }
      if (!lock.info) {
        throw new Error(`存在无法识别的启动锁 ${lock.path}；确认没有其他训练器窗口后可手动删除该文件 / `
          + `unrecognized launch lock; delete the file manually if no other trainer window is open`)
      }
      if (Date.now() >= lockDeadline) {
        throw new Error(`另一个启动/停止进程仍在进行（PID ${lock.info.pid}），停止操作已让位以免竞争 / `
          + `another launch or stop is in progress (PID ${lock.info.pid}); stop yielded to avoid racing it`)
      }
      await delay(150)
    }
  } catch (error) {
    if (error && typeof error === 'object') error.dataDir = error.dataDir ?? dataDir
    throw error
  }
}

/** Lock-held part of stop(): verify, signal the exact PID, confirm exit. */
async function stopRecorded(dataDir, options) {
  const existing = await readOwnedState(dataDir)
  if (!existing) return { stopped: false, noop: 'no-state', dataDir }
  if (existing.stale) {
    throw new Error(`训练状态文件无法识别（${existing.stale}），停止器拒绝猜测；文件已保留。确认没有训练器在运行后可手动删除 trainer-state.json / `
      + `the state file is unreadable (${existing.stale}); refusing to guess — the file is kept. Delete trainer-state.json manually after making sure no trainer is running`)
  }
  const state = existing.state
  if (!pidAlive(state.pid)) {
    // Dead own record: clean it without signaling anything.
    await clearState(dataDir)
    await rm(join(dataDir, READY_FILE), { force: true }).catch(() => {})
    return { stopped: false, noop: 'already-dead', cleanedStaleState: true, dataDir, pid: state.pid, port: state.port }
  }
  if (!(await confirmOwnedServer(state))) {
    throw new Error(unverifiableOwnerMessage(state))
  }
  try {
    process.kill(state.pid, 'SIGKILL')
  } catch (error) {
    throw new Error(`无法结束已通过身份核验的训练服务进程（PID ${state.pid}）：${error && error.message}；状态文件已保留 / `
      + `failed to signal the identity-verified trainer process (PID ${state.pid}): ${error && error.message}; the state file is kept`)
  }
  const exitDeadline = Date.now() + (options.exitTimeoutMs ?? STOP_EXIT_TIMEOUT_MS)
  while (pidAlive(state.pid)) {
    if (Date.now() >= exitDeadline) {
      throw new Error(`已向 PID ${state.pid} 发送结束信号但它未在限时内退出；状态文件已保留，数据库与日志未改动 / `
        + `signaled PID ${state.pid} but it did not exit within the time limit; the state file is kept and database/logs are untouched`)
    }
    await delay(100)
  }
  // 进程已死，但刚被结束的监听端口可能短暂滞留；等端口真正可拒绝后再报
  // 成功，这样紧随的 Start.cmd 不会撞上未释放的端口。超限也照常报告成功
  // （PID 已死是停止的契约），只是提示紧随启动可能需要重试。
  const drainDeadline = Date.now() + (options.portDrainTimeoutMs ?? 3_000)
  let drained = false
  while (Date.now() < drainDeadline) {
    if ((await probeHealth(state.port, { timeoutMs: 500 })).refused) {
      drained = true
      break
    }
    await delay(100)
  }
  await clearState(dataDir)
  await rm(join(dataDir, READY_FILE), { force: true }).catch(() => {})
  return {
    stopped: true,
    pid: state.pid,
    port: state.port,
    url: state.baseURL,
    runId: state.runId,
    dataDir,
    logPath: join(dataDir, SERVER_LOG),
    portDrained: drained,
  }
}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`[参数错误 / bad arguments] ${error.message}`)
    process.exitCode = 1
    return
  }
  if (parsed.help) {
    console.log(usage())
    return
  }
  try {
    if (parsed.stop) {
      const result = await stop(parsed)
      if (result.stopped) {
        console.log(`训练服务已停止（PID ${result.pid}，端口 ${result.port}）。数据库与日志保留在 ${result.dataDir} / server stopped; database and logs kept`)
      } else if (result.noop === 'already-dead') {
        console.log(`记录的服务进程（PID ${result.pid}）已不存在，已清理过期状态 / the recorded process is gone; stale state cleaned`)
      } else {
        console.log('没有已记录的训练服务，无需停止 / no recorded trainer to stop')
        console.log('若你手动删除过状态文件而训练窗口仍在运行，请在任务管理器中结束对应的 node 进程 / if a trainer runs without its state file, end its node process via Task Manager')
      }
      return
    }
    const result = await launch(parsed)
    if (result.reused) {
      console.log(`训练服务已在运行，直接复用 / reusing the running server: ${result.url}`)
      console.log('如修改过 trainer.config.json 或更换了新版本包，请先运行 Stop.cmd 停止旧服务再启动。/ Config or package changes apply after running Stop.cmd first.')
    } else {
      console.log(`训练服务已启动 / server started: ${result.url}`)
      console.log(`数据目录 / data directory: ${result.dataDir}`)
      console.log(`行情目录 / market data (tdxRoot): ${result.tdxRoot ?? '未找到通达信目录，可在 trainer.config.json 配置 tdxRoot / not found; set tdxRoot in trainer.config.json'}`)
      console.log(`服务进程 PID: ${result.pid}   日志 / log: ${result.logPath}`)
      console.log('再次运行 Start.cmd 会复用当前服务并打开浏览器；停止服务请运行 Stop.cmd（关闭浏览器不会停止服务）。/ Run Start.cmd again to reopen the browser; run Stop.cmd to stop the server (closing the browser does not stop it).')
    }
    if (parsed.openBrowser && !result.openedBrowser) {
      console.log('浏览器未能自动打开，请手动访问上面的地址 / could not open a browser; visit the URL above manually')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[${parsed.stop ? '停止失败 / stop failed' : '启动失败 / launch failed'}] ${message}`)
    process.exitCode = 1
    const dataDir = error && typeof error === 'object' ? error.dataDir : null
    if (typeof dataDir === 'string') {
      await appendFile(join(dataDir, LAUNCHER_LOG), `[${new Date().toISOString()}] ${message}\n`).catch(() => {})
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
}

module.exports = {
  APP_ID,
  DATA_DIR_NAME,
  DEFAULT_PORT,
  LOCK_FILE,
  READY_FILE,
  SERVER_LOG,
  STATE_FILE,
  TDX_CANDIDATES,
  acquireLaunchLock,
  assertStateIdentity,
  clearState,
  confirmOwnedServer,
  decideRecordedServer,
  discoverTdxRoot,
  inspectPackage,
  isTdxRootPath,
  launch,
  lockPath,
  main,
  openURL,
  parseArgs,
  pidAlive,
  probeHealth,
  probeMatchesState,
  readConfigFile,
  readOwnedState,
  resolveConfig,
  statePath,
  stop,
  usage,
  writeStateFile,
}
