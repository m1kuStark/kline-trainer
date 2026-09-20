import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun } from '../../scripts/runtime/run.js'
import { runtime } from '../../e2e/runtime.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('rejects escaped artifact paths during synchronous config loading before Playwright can delete output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-config-')); roots.push(root)
  const run = await createRun(root, 'journey')
  run.port = 45678; run.baseURL = 'http://127.0.0.1:45678'
  const outsider = join(root, 'personal'); await mkdir(outsider)
  await writeFile(join(outsider, 'sentinel.txt'), 'keep')
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('TRAINER_RUN_MANIFEST', run.manifestPath)
  await writeFile(run.manifestPath, JSON.stringify(run))
  expect(runtime().baseURL).toBe('http://127.0.0.1:45678')
  await writeFile(run.manifestPath, JSON.stringify({ ...run, artifactsDir: outsider }))
  expect(() => runtime()).toThrow(/Unowned runtime artifact/)
  expect(await readFile(join(outsider, 'sentinel.txt'), 'utf8')).toBe('keep')
})
