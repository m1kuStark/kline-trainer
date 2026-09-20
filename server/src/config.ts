import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { discoverTdxRoot, defaultTdxCandidates } from './tdx/discover.js'

export interface AppConfig {
  port: number
  host: string
  databasePath: string
  tdxRoot: string | null
  runId?: string
  staticDirectory?: string
  readyFile?: string
}

export async function loadConfig(): Promise<AppConfig> {
  const runId = process.env.TRAINER_RUN_ID?.trim()
  if (runId) {
    for (const name of ['TRAINER_DB', 'TRAINER_STATIC_DIR', 'TRAINER_READY_FILE']) {
      if (!process.env[name]?.trim() || !isAbsolute(process.env[name]!)) {
        throw new Error(`${name} must be an explicit absolute path for isolated runs`)
      }
    }
  }
  const configuredRoot = process.env.TDX_ROOT?.trim()
  const discovery = configuredRoot
    ? await discoverTdxRoot([configuredRoot])
    : runId ? null : await discoverTdxRoot(defaultTdxCandidates())
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
    databasePath: process.env.TRAINER_DB ?? join(homedir(), '.a-share-kline-trainer', 'trainer.sqlite'),
    tdxRoot: discovery?.root ?? null,
    runId,
    staticDirectory: process.env.TRAINER_STATIC_DIR,
    readyFile: process.env.TRAINER_READY_FILE,
  }
}
