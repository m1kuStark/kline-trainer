import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const control = vi.hoisted(() => ({
  stallTaskkill: false,
  release: undefined as (() => void) | undefined,
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (args[0] !== 'taskkill' || !control.stallTaskkill) return (actual.execFile as Function)(...args)
      const callback = args.at(-1) as (error: Error | null) => void
      control.release = () => callback(new Error('simulated taskkill stall'))
    },
  }
})

const roots: string[] = []

async function waitUntil(probe: () => Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe().catch(() => false)) return
    if (Date.now() > deadline) throw new Error('timed out waiting for fixture')
    await delay(25)
  }
}

describe('generic command cancellation', () => {
  afterEach(async () => {
    control.stallTaskkill = false
    control.release?.()
    control.release = undefined
    vi.unstubAllEnvs()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('returns a bounded cleanup error when Windows taskkill stalls', async () => {
    if (process.platform !== 'win32') return
    const { createRun, runNode } = await import('../../scripts/runtime/run.js')
    const root = await mkdtemp(join(tmpdir(), 'trainer-cancel-'))
    roots.push(root)
    const run = await createRun(root, 'verify')
    const pidFile = join(root, 'child.pid')
    const controller = new AbortController()
    const reason = new Error('cancel requested')
    control.stallTaskkill = true
    const running = runNode(run, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('child alive'); setInterval(() => {}, 1000)`], 'cancel.log', { signal: controller.signal })
    running.catch(() => {})
    let pid: number | undefined
    try {
      await waitUntil(async () => {
        pid = Number(await readFile(pidFile, 'utf8'))
        return Number.isInteger(pid) && pid > 0 && (await readFile(join(run.artifactsDir, 'cancel.log'), 'utf8')).includes('child alive')
      })
      controller.abort(reason)
      const outcome = await Promise.race([
        running.then(() => 'resolved' as const, error => error as Error),
        delay(18_000).then(() => 'unbounded' as const),
      ])
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toMatch(/cleanup incomplete/i)
      expect((outcome as Error).cause).toBe(reason)
      expect(await readFile(join(run.artifactsDir, 'cancel.log'), 'utf8')).toContain('cleanup incomplete')
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
      control.stallTaskkill = false
      control.release?.()
      control.release = undefined
    }
  }, 20_000)
})
