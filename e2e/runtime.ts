import { readFileSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RunManifest } from '../scripts/runtime/run'

export function runtime(): RunManifest {
  const path = process.env.TRAINER_RUN_MANIFEST
  if (!path) throw new Error('Start tests with npm run journey; each run needs its own runtime manifest.')
  const run = JSON.parse(readFileSync(path, 'utf8')) as RunManifest
  if (run.schemaVersion !== 1 || !/^run-[0-9a-f-]{36}$/.test(run.runId)
    || run.root !== realpathSync.native(process.cwd()) || !run.baseURL || run.manifestPath !== resolve(path)) {
    throw new Error('Journey manifest is not ready or belongs to another working directory')
  }
  // Playwright deletes outputDir BEFORE globalSetup. Bound its paths synchronously here.
  const runDir = join(run.root, '.runs', run.runId)
  const outputs = { runDir, manifestPath: join(runDir, 'manifest.json'), artifactsDir: join(runDir, 'artifacts') }
  for (const [key, expected] of Object.entries(outputs)) {
    if (run[key as keyof RunManifest] !== expected) throw new Error('Unowned runtime artifact path')
    const actual = realpathSync.native(expected), local = relative(realpathSync.native(run.root), actual)
    if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Unowned runtime manifest path')
    // A junction into another run is also invalid, even within the repository.
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('Runtime artifact junction aliases another path')
  }
  return run
}

export function evidencePath(name: string): string {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('Evidence name must be a filename')
  const directory = join(runtime().artifactsDir, 'screenshots')
  mkdirSync(directory, { recursive: true })
  return join(directory, name)
}
