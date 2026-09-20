import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
export type RunMode = 'journey' | 'dev' | 'verify'
export interface RunManifest {
  schemaVersion: 1
  runId: string
  mode: RunMode
  root: string
  runDir: string
  manifestPath: string
  databasePath: string
  webDir: string
  serverDir: string
  artifactsDir: string
  readyFile: string
  tdxRoot?: string
  baseURL?: string
  port?: number
  commit: string
  createdAt: string
}

function contained(root: string, path: string) {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(fromRoot)
}

async function existingAncestor(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await existingAncestor(dirname(path)), path.slice(dirname(path).length + 1))
  }
}

async function assertOwned(root: string, path: string, label: string) {
  const canonicalRoot = await realpath(root)
  const canonicalPath = await existingAncestor(path)
  if (!contained(root, path) || !contained(canonicalRoot, canonicalPath)
    || relative(root, path) !== relative(canonicalRoot, canonicalPath)) {
    throw new Error(`${label} is outside its owned runtime directory (including symlinks)`)
  }
}

function validateManifest(value: unknown, path?: string): asserts value is RunManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid runtime manifest')
  const run = value as RunManifest
  if (run.schemaVersion !== 1 || !/^run-[0-9a-f-]{36}$/.test(run.runId)
    || !['journey', 'dev', 'verify'].includes(run.mode)
    || typeof run.root !== 'string' || !isAbsolute(run.root)
    || typeof run.commit !== 'string' || !run.commit
    || typeof run.createdAt !== 'string' || !Number.isFinite(Date.parse(run.createdAt))) {
    throw new Error('Invalid runtime manifest schema')
  }
  const directory = join(run.root, '.runs', run.runId)
  const paths = {
    runDir: directory, manifestPath: join(directory, 'manifest.json'),
    databasePath: join(directory, 'trainer.sqlite'), webDir: join(directory, 'web'),
    serverDir: join(directory, 'server'), artifactsDir: join(directory, 'artifacts'), readyFile: join(directory, 'ready.json'),
  }
  for (const [name, expected] of Object.entries(paths)) {
    if ((run as unknown as Record<string, unknown>)[name] !== expected) throw new Error(`Invalid runtime ${name}: output must belong to this run`)
  }
  if (path && resolve(path) !== run.manifestPath) throw new Error('Runtime manifestPath does not match the file being read')
  if (run.tdxRoot !== undefined && (typeof run.tdxRoot !== 'string' || !isAbsolute(run.tdxRoot))) throw new Error('Invalid runtime tdxRoot')
  if (run.port !== undefined && (!Number.isInteger(run.port) || run.port < 1 || run.port > 65535)) throw new Error('Invalid runtime port')
  if ((run.baseURL === undefined) !== (run.port === undefined)
    || (run.port !== undefined && run.baseURL !== `http://127.0.0.1:${run.port}`)) throw new Error('Invalid runtime baseURL')
}

async function validatePaths(run: RunManifest) {
  await assertOwned(run.root, run.runDir, 'runDir')
  for (const key of ['manifestPath', 'databasePath', 'webDir', 'serverDir', 'artifactsDir', 'readyFile'] as const) {
    await assertOwned(run.runDir, run[key], key)
  }
}

export async function saveRun(run: RunManifest): Promise<void> {
  validateManifest(run)
  await validatePaths(run)
  const temporary = `${run.manifestPath}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' })
  await rename(temporary, run.manifestPath)
}

export async function readRun(path: string): Promise<RunManifest> {
  const run: unknown = JSON.parse(await readFile(path, 'utf8'))
  validateManifest(run, await realpath(path))
  await validatePaths(run)
  return run
}

export async function createRun(root: string, mode: RunMode, options: { tdxRoot?: string } = {}): Promise<RunManifest> {
  root = await realpath(resolve(root))
  const runId = `run-${randomUUID()}`
  const runDir = join(root, '.runs', runId)
  await mkdir(join(root, '.runs'), { recursive: true })
  await assertOwned(root, join(root, '.runs'), '.runs')
  await mkdir(runDir)
  const commit = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }).then(result => result.stdout.trim(), () => 'unversioned')
  const run: RunManifest = {
    schemaVersion: 1, runId, mode, root, runDir, manifestPath: join(runDir, 'manifest.json'),
    databasePath: join(runDir, 'trainer.sqlite'), webDir: join(runDir, 'web'), serverDir: join(runDir, 'server'),
    artifactsDir: join(runDir, 'artifacts'), readyFile: join(runDir, 'ready.json'),
    ...(options.tdxRoot ? { tdxRoot: resolve(options.tdxRoot) } : {}), commit, createdAt: new Date().toISOString(),
  }
  await Promise.all([run.webDir, run.serverDir, run.artifactsDir].map(path => mkdir(path)))
  await saveRun(run)
  return run
}

export function runEnv(run: RunManifest): NodeJS.ProcessEnv {
  validateManifest(run)
  return {
    ...process.env, TRAINER_RUN_MANIFEST: run.manifestPath, TRAINER_RUN_ID: run.runId,
    TRAINER_DB: run.databasePath, TRAINER_STATIC_DIR: run.webDir, TRAINER_READY_FILE: run.readyFile,
    TRAINER_BASE_URL: run.baseURL ?? '',
    TRAINER_VERIFY_DIR: run.artifactsDir,
    TDX_ROOT: run.tdxRoot ?? '', OPEN_BROWSER: '0', HOST: '127.0.0.1', PORT: '0',
  }
}

async function stopChild(child: ChildProcess, done: Promise<unknown>, runId?: string) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (runId && child.connected) {
    child.send({ type: 'trainer:shutdown', runId }, () => {})
    await Promise.race([done, delay(3000)])
  }
  if (child.exitCode === null && child.signalCode === null) {
    if (runId) {
      // The isolated server is one Node process (OPEN_BROWSER=0). Killing it
      // directly avoids Windows taskkill's potentially unbounded tree scan.
      // Generic commands below still need tree cleanup for their descendants.
      child.kill('SIGKILL')
    } else if (process.platform === 'win32') {
      await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    } else child.kill('SIGTERM')
    await Promise.race([done, delay(3000)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  if (runId) {
    const closed = await Promise.race([done.then(() => true), delay(3000).then(() => false)])
    if (!closed) throw new Error(`Owned server ${child.pid} did not close after forced shutdown`)
  } else await done
}

/** Execute only this worktree's installed Node entry points, without a command shell. */
export async function runNode(run: RunManifest, args: string[], logName: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  validateManifest(run)
  await validatePaths(run)
  if (!/^[a-zA-Z0-9_.-]+\.log$/.test(logName)) throw new Error('Invalid runtime log filename')
  options.signal?.throwIfAborted()
  const logPath = join(run.artifactsDir, logName)
  const log = await open(logPath, 'a')
  const child = spawn(process.execPath, args, { cwd: run.root, env: runEnv(run), windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
  let spawnError: Error | undefined
  child.once('error', error => { spawnError = error })
  const done = new Promise<number | null>(resolveDone => child.once('close', code => resolveDone(code)))
  const abort = () => { void stopChild(child, done) }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (options.signal?.aborted) abort()
    const code = await done
    options.signal?.throwIfAborted()
    if (spawnError) throw spawnError
    if (code !== 0) throw new Error(`Command exited with ${code}; see ${logPath}`)
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await log.close()
  }
}

export async function buildRun(run: RunManifest, mode: 'journey' | 'production', options: { signal?: AbortSignal } = {}): Promise<void> {
  await runNode(run, [join(run.root, 'node_modules/typescript/bin/tsc'), '-p', 'server/tsconfig.json', '--outDir', run.serverDir], 'build-server.log', options)
  await runNode(run, [join(run.root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'web/vite.config.ts', '--mode', mode], 'build-web.log', options)
}

export async function startServer(run: RunManifest, options: { timeoutMs?: number } = {}): Promise<{ run: RunManifest; stop(): Promise<void> }> {
  validateManifest(run)
  await validatePaths(run)
  const lockPath = join(run.runDir, 'server.lock')
  const lock = await open(lockPath, 'wx')
  await lock.close()
  let child: ChildProcess | undefined
  let done: Promise<unknown> = Promise.resolve()
  let stopPromise: Promise<void> | undefined
  let log: Awaited<ReturnType<typeof open>> | undefined
  const stop = () => stopPromise ??= (async () => {
    if (child) await stopChild(child, done, run.runId)
    await log?.close()
    await rm(run.readyFile, { force: true })
    await rm(lockPath, { force: true })
  })()
  try {
    await rm(run.readyFile, { force: true })
    log = await open(join(run.artifactsDir, 'server.log'), 'a')
    child = spawn(process.execPath, [join(run.serverDir, 'index.js')], {
      cwd: run.root, env: runEnv(run), windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc'],
    })
    let failure: Error | undefined
    let exited = false
    child.once('error', error => { failure = error })
    done = new Promise<void>(resolveDone => child!.once('close', (code, signal) => {
      exited = true
      failure ??= new Error(`Server exited with ${code ?? signal}; see ${join(run.artifactsDir, 'server.log')}`)
      resolveDone()
    }))
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    let lastConnectionError: string | undefined
    while (Date.now() < deadline) {
      if (failure || exited) throw failure ?? new Error('Server exited before readiness')
      let ready: { runId?: unknown; pid?: unknown; baseURL?: unknown; port?: unknown } | undefined
      try { ready = JSON.parse(await readFile(run.readyFile, 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (ready) {
        if (ready.runId !== run.runId || ready.pid !== child.pid || typeof ready.port !== 'number'
          || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535
          || ready.baseURL !== `http://127.0.0.1:${ready.port}`) {
          throw new Error('Server readiness identity does not match the child process')
        }
        let response: Response
        try {
          response = await fetch(`${ready.baseURL}/api/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) })
        } catch (error) {
          // Readiness identity has already pinned this URL to our own child.
          // Windows loopback can reset/refuse a connection briefly at startup;
          // retry only transport failures within the original startup deadline.
          const cause = (error as { cause?: { code?: string } })?.cause?.code
          const transient = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause ?? '')
            || (error as { name?: string })?.name === 'TimeoutError'
          if (!transient) throw error
          lastConnectionError = `${String(error)}${cause ? ` (${cause})` : ''}`
          await Promise.race([done, delay(25)])
          continue
        }
        const health = await response.json() as { status?: unknown; runId?: unknown; pid?: unknown }
        if (!response.ok || health.status !== 'ok' || health.runId !== run.runId || health.pid !== child.pid) {
          throw new Error('Server health identity does not match the child process')
        }
        if (failure || exited) throw failure ?? new Error('Server exited during readiness')
        run.port = ready.port
        run.baseURL = ready.baseURL as string
        await saveRun(run)
        return { run, stop }
      }
      await Promise.race([done, delay(25)])
    }
    throw new Error(`Server readiness timed out${lastConnectionError ? `; last health error: ${lastConnectionError}` : ''}; see ${join(run.artifactsDir, 'server.log')}`)
  } catch (error) {
    await stop()
    throw error
  }
}
