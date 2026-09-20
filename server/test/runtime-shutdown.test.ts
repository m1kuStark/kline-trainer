import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stalled = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (args[0] !== 'taskkill') return (actual.execFile as Function)(...args)
      // Simulate Windows process-tree enumeration stalling under host load.
      const callback = args.at(-1) as (error: Error) => void
      stalled.release = () => callback(new Error('simulated taskkill stall'))
    },
  }
})

describe.skipIf(process.platform !== 'win32')('owned server shutdown', () => {
  it('releases a never-ready server even when the external tree killer stalls', async () => {
    const { createRun, startServer } = await import('../../scripts/runtime/run.js')
    const root = await mkdtemp(join(tmpdir(), 'trainer-shutdown-'))
    const run = await createRun(root, 'verify')
    const pidFile = join(run.artifactsDir, 'pid')
    await writeFile(join(run.serverDir, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`)
    const starting = startServer(run, { timeoutMs: 600 }).then(() => 'unexpected success', error => String(error))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([starting, new Promise<string>(resolve => { timer = setTimeout(() => resolve('shutdown stuck'), 7000) })])
      expect(outcome).toMatch(/readiness timed out/i)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      await expect(readFile(join(run.runDir, 'server.lock'))).rejects.toThrow()
    } finally {
      clearTimeout(timer)
      // Always release our real child, including when demonstrating the old bug.
      const pid = Number(await readFile(pidFile, 'utf8'))
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
      stalled.release?.()
      await starting
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
