import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { resolveConfig } from 'vite'
import { DatabaseSync } from 'node:sqlite'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
const activeServers: { stop(): Promise<void> }[] = []
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'trainer-runtime-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of activeServers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function projectFixture() {
  const root = await temporaryRoot()
  await mkdir(join(root, 'server'))
  await mkdir(join(root, 'web', 'dist'), { recursive: true })
  await Promise.all([
    cp(resolve('server/src'), join(root, 'server/src'), { recursive: true }),
    cp(resolve('server/tsconfig.json'), join(root, 'server/tsconfig.json')),
    cp(resolve('tsconfig.json'), join(root, 'tsconfig.json')),
    cp(resolve('web/vite.config.ts'), join(root, 'web/vite.config.ts')),
    symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
    writeFile(join(root, 'package.json'), '{"type":"module"}'),
    writeFile(join(root, 'web/index.html'), '<!doctype html><html><body>Isolated fixture</body></html>'),
    writeFile(join(root, 'web/dist/personal-marker.txt'), 'existing production build'),
  ])
  return root
}

describe('isolated runtime configuration', () => {
  it('refuses an identified run without every explicit writable path', async () => {
    vi.stubEnv('TRAINER_RUN_ID', 'test-run')
    vi.stubEnv('TRAINER_DB', '')
    vi.stubEnv('TRAINER_STATIC_DIR', '')
    vi.stubEnv('TRAINER_READY_FILE', '')
    await expect(loadConfig()).rejects.toThrow(/TRAINER_DB/)
  })

  it('does not autodiscover a personal market-data root for an unconfigured isolated run', async () => {
    const root = await temporaryRoot()
    vi.stubEnv('TRAINER_RUN_ID', 'test-run')
    vi.stubEnv('TRAINER_DB', join(root, 'isolated.sqlite'))
    vi.stubEnv('TRAINER_STATIC_DIR', join(root, 'web'))
    vi.stubEnv('TRAINER_READY_FILE', join(root, 'ready.json'))
    vi.stubEnv('TDX_ROOT', '')
    vi.stubEnv('PORT', '0')
    expect(await loadConfig()).toMatchObject({ port: 0, tdxRoot: null })
  })
})

describe('runtime namespaces', () => {
  it('allocates concurrent manifests and ignores inherited writable paths', async () => {
    const { createRun, readRun, runEnv } = await import('../../scripts/runtime/run.js')
    const root = await temporaryRoot()
    vi.stubEnv('TRAINER_DB', join(root, 'personal.sqlite'))
    vi.stubEnv('TRAINER_STATIC_DIR', join(root, 'production-dist'))
    vi.stubEnv('PORT', '8787')
    const [one, two] = await Promise.all([createRun(root, 'journey'), createRun(root, 'journey')])
    expect(one.runDir).not.toBe(two.runDir)
    expect(one.databasePath).not.toBe(two.databasePath)
    expect(one.webDir).not.toBe(two.webDir)
    expect(await readRun(one.manifestPath)).toEqual(one)
    expect(runEnv(one)).toMatchObject({
      TRAINER_DB: join(one.runDir, 'trainer.sqlite'), TRAINER_STATIC_DIR: join(one.runDir, 'web'),
      PORT: '0', HOST: '127.0.0.1', OPEN_BROWSER: '0', TRAINER_RUN_ID: one.runId,
    })
    one.port = 43123
    one.baseURL = 'http://127.0.0.1:43123'
    expect(runEnv(one).TRAINER_BASE_URL).toBe('http://127.0.0.1:43123')
  })

  it('rejects manifests whose writable paths escape their run directory', async () => {
    const { createRun, readRun } = await import('../../scripts/runtime/run.js')
    const root = await temporaryRoot()
    const run = await createRun(root, 'verify')
    await writeFile(run.manifestPath, JSON.stringify({ ...run, databasePath: join(root, 'personal.sqlite') }))
    await expect(readRun(run.manifestPath)).rejects.toThrow(/databasePath/)
  })

  it('rejects a junction that aliases a run output to an external directory', async () => {
    const { createRun, readRun } = await import('../../scripts/runtime/run.js')
    const root = await temporaryRoot()
    const run = await createRun(root, 'verify')
    const external = await temporaryRoot()
    await rm(run.webDir, { recursive: true, force: true })
    await symlink(external, run.webDir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readRun(run.manifestPath)).rejects.toThrow(/webDir|outside|symlink/i)
  })

  it('rejects a run directory junction that aliases a different run namespace', async () => {
    const { createRun, readRun, startServer } = await import('../../scripts/runtime/run.js')
    const root = await temporaryRoot()
    const one = await createRun(root, 'verify')
    const two = await createRun(root, 'verify')
    await rm(one.runDir, { recursive: true, force: true })
    await symlink(two.runDir, one.runDir, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(two.manifestPath, JSON.stringify(one))
    await expect(readRun(one.manifestPath)).rejects.toThrow(/manifestPath|runDir|outside|symlink/i)
    await expect(startServer(one)).rejects.toThrow(/runDir|outside|symlink/i)
  })

  it('keeps unscoped journey builds out of the production asset directory', async () => {
    vi.stubEnv('TRAINER_STATIC_DIR', '')
    const config = await resolveConfig({ configFile: resolve('web/vite.config.ts'), mode: 'journey' }, 'build')
    expect(resolve(config.root, config.build.outDir)).toBe(resolve('web/dist-journey'))
    expect(config.server.strictPort).toBe(true)
  })
})

describe('runtime processes', () => {
  it('retries a transient health connection failure within the owned startup deadline', async () => {
    const { createRun, startServer } = await import('../../scripts/runtime/run.js')
    const run = await createRun(await temporaryRoot(), 'verify')
    await writeFile(join(run.serverDir, 'index.js'), `
      const fs = require('node:fs');
      const server = require('node:http').createServer((req,res) => {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({status:'ok',runId:process.env.TRAINER_RUN_ID,pid:process.pid}));
      });
      server.listen(0,'127.0.0.1',()=>{
        const port=server.address().port;
        fs.writeFileSync(process.env.TRAINER_READY_FILE,JSON.stringify({runId:process.env.TRAINER_RUN_ID,pid:process.pid,port,baseURL:'http://127.0.0.1:'+port}));
      });
      process.on('message',()=>server.close(()=>process.exit(0)));
    `)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }),
    )
    try {
      const server = await startServer(run, { timeoutMs: 2000 })
      activeServers.push(server)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect((await fetch(`${run.baseURL}/api/health`)).status).toBe(200)
    } finally { fetchSpy.mockRestore() }
  })

  it('rejects another process readiness record before contacting its service', async () => {
    const { createRun, startServer } = await import('../../scripts/runtime/run.js')
    const run = await createRun(await temporaryRoot(), 'verify')
    const script = `const fs = require('node:fs'); fs.writeFileSync(process.env.TRAINER_READY_FILE, JSON.stringify({runId: 'wrong-run', pid: process.pid, port: 1, baseURL: 'http://127.0.0.1:1'})); process.on('message', () => process.exit(0));`
    await writeFile(join(run.serverDir, 'index.js'), script)
    await expect(startServer(run)).rejects.toThrow(/readiness identity/)
    await expect(readFile(run.readyFile)).rejects.toThrow()
  })

  it('cancels an owned child command and preserves its failure log', async () => {
    const { createRun, runNode } = await import('../../scripts/runtime/run.js')
    const run = await createRun(await temporaryRoot(), 'verify')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      await expect(runNode(run, ['-e', 'console.log("child alive");setInterval(() => {},1000)'], 'cancel.log', { signal: controller.signal })).rejects.toThrow(/abort/i)
      expect(await readFile(join(run.artifactsDir, 'cancel.log'), 'utf8')).toContain('child alive')
    } finally { clearTimeout(timer) }
  }, 15_000)

  it('builds and serves two concurrent runs without replacing production assets or sharing ports/databases', async () => {
    const { createRun, buildRun, startServer, readRun } = await import('../../scripts/runtime/run.js')
    const root = await projectFixture()
    const runs = await Promise.all([createRun(root, 'journey'), createRun(root, 'dev')])
    await Promise.all(runs.map((run, i) => buildRun(run, i === 0 ? 'journey' : 'production')))
    for (const run of runs) {
      expect(await readFile(join(run.webDir, 'index.html'), 'utf8')).toContain('Isolated fixture')
      expect(await readFile(join(run.serverDir, 'index.js'), 'utf8')).toContain('Fastify')
    }
    expect(await readFile(join(root, 'web/dist/personal-marker.txt'), 'utf8')).toBe('existing production build')
    const servers = await Promise.all(runs.map(async run => {
      const server = await startServer(run)
      activeServers.push(server)
      return server
    }))
    expect(servers[0].run.port).toBeGreaterThan(0)
    expect(servers[0].run.port).not.toBe(servers[1].run.port)
    for (const { run } of servers) {
      expect(await (await fetch(`${run.baseURL}/api/health`)).json()).toMatchObject({ status: 'ok', runId: run.runId })
      expect(await (await fetch(run.baseURL!)).text()).toContain('Isolated fixture')
      expect((await readFile(run.databasePath)).length).toBeGreaterThan(0)
      expect((await readRun(run.manifestPath)).port).toBe(run.port)
    }
    const databases = runs.map(run => new DatabaseSync(run.databasePath))
    try {
      databases[0].prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('isolation-probe', 'first run only')
      expect(databases[1].prepare('SELECT value FROM settings WHERE key = ?').get('isolation-probe')).toBeUndefined()
    } finally { for (const database of databases) database.close() }
    await servers[0].stop()
    await expect(fetch(`${runs[0].baseURL}/api/health`)).rejects.toThrow()
    expect((await fetch(`${runs[1].baseURL}/api/health`)).status).toBe(200)
  }, 60_000)

  it('fails promptly on early server exit and retains its diagnostic log', async () => {
    const { createRun, startServer } = await import('../../scripts/runtime/run.js')
    const run = await createRun(await temporaryRoot(), 'verify')
    await writeFile(join(run.serverDir, 'index.js'), 'console.error("startup sentinel"); process.exit(9)')
    await expect(startServer(run)).rejects.toThrow(/exited.*9|startup sentinel/)
    expect(await readFile(join(run.artifactsDir, 'server.log'), 'utf8')).toContain('startup sentinel')
  })

  it('terminates a server that never becomes ready', async () => {
    const { createRun, startServer } = await import('../../scripts/runtime/run.js')
    const run = await createRun(await temporaryRoot(), 'verify')
    const pidFile = join(run.artifactsDir, 'child.pid')
    await writeFile(join(run.serverDir, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    await expect(startServer(run, { timeoutMs: 600 })).rejects.toThrow(/timed out/i)
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)
})

describe('runtime CLI', () => {
  it('builds an isolated journey through the CLI and returns its manifest', async () => {
    const { runRuntime } = await import('../../scripts/runtime.js')
    const { readRun } = await import('../../scripts/runtime/run.js')
    const root = await projectFixture()
    const manifestPath = await runRuntime(root, ['build-journey'])
    const run = await readRun(manifestPath)
    expect(run.mode).toBe('journey')
    expect(await readFile(join(run.webDir, 'index.html'), 'utf8')).toContain('Isolated fixture')
    expect(await readFile(join(root, 'web/dist/personal-marker.txt'), 'utf8')).toBe('existing production build')
  }, 30_000)

  it('retains evidence and releases the server when the browser command fails', async () => {
    const { runRuntime } = await import('../../scripts/runtime.js')
    const { readRun } = await import('../../scripts/runtime/run.js')
    const { SNAPSHOT_FILES } = await import('../../scripts/runtime/snapshot.js')
    const root = await projectFixture()
    const source = join(root, 'source-tdx')
    for (const path of SNAPSHOT_FILES) {
      const destination = join(source, path)
      await mkdir(resolve(destination, '..'), { recursive: true })
      const bytes = Buffer.alloc(path.endsWith('.day') ? 32 : 8)
      if (path.endsWith('.day')) bytes.writeUInt32LE(20260901)
      await writeFile(destination, bytes)
    }
    vi.stubEnv('TDX_ROOT', source)
    await expect(runRuntime(root, ['journey', '--unknown-trainer-option'])).rejects.toThrow(/Command exited/)
    const [id] = await readdir(join(root, '.runs'))
    const run = await readRun(join(root, '.runs', id, 'manifest.json'))
    expect(await readFile(join(run.artifactsDir, 'journey.log'), 'utf8')).toContain('unknown option')
    await expect(readFile(run.readyFile)).rejects.toThrow()
    await expect(fetch(`${run.baseURL}/api/health`)).rejects.toThrow()
  }, 30_000)
})
