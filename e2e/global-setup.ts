import { readRun } from '../scripts/runtime/run'

// The parent runtime owns server creation/teardown. Never connect to an arbitrary fixed port.
export default async function globalSetup(): Promise<void> {
  const path = process.env.TRAINER_RUN_MANIFEST
  if (!path) throw new Error('Use npm run journey to build and launch an isolated runtime.')
  const run = await readRun(path)
  const response = await fetch(`${run.baseURL}/api/health`, { signal: AbortSignal.timeout(5000) })
  const health = await response.json() as { runId?: string; status?: string }
  if (!response.ok || health.status !== 'ok' || health.runId !== run.runId) {
    throw new Error('Journey server identity does not match this run; refusing unknown service.')
  }
}
