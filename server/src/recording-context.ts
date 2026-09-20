import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { AppConfig } from './config.js'
import { HttpError, feeConfigOf, t1Enabled } from './train/engine.js'
import { COMMISSION_MIN, COMMISSION_RATE, LOT_SIZE, STAMP_TAX_RATE } from './train/account.js'

interface AppInfo {
  version: string
  gitCommit: string
  dirty: boolean
}

// 运行架构以进程 cwd 固定在 worktree 根启动（源码与构建产物一致的项目根），版本与 git 状态按 cwd 定位；
// 不用 import.meta.url 上推两级：隔离构建产物位于 .runs/<run>/server/ 下，上推会把根推成 .runs，
// package.json 读取落空导致版本 unknown。
export function resolveProjectRoot(): string {
  return process.cwd()
}

// 录制上下文只暴露包版本与仓库提交状态；git 读取用参数数组、无用户输入，
// 失败时回退 unknown/false，绝不返回本机路径、环境变量或密钥材料。
export function readAppInfo(rootDirectory: string = resolveProjectRoot()): AppInfo {
  let version = 'unknown'
  try {
    const parsed = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8')) as { version?: string }
    version = typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown'
  } catch { /* version stays unknown */ }
  let gitCommit = 'unknown'
  let dirty = false
  // Portable packages have no .git directory. The packaging step writes this
  // immutable build identity, keeping exported recordings traceable offline.
  try {
    const release = JSON.parse(readFileSync(join(rootDirectory, 'release.json'), 'utf8')) as Record<string, unknown>
    if (release.appId === 'a-share-kline-trainer' && release.version === version
      && typeof release.gitCommit === 'string' && /^[a-f\d]{40}$/.test(release.gitCommit)) {
      return { version, gitCommit: release.gitCommit, dirty: false }
    }
  } catch { /* source checkouts and old packages use Git detection below */ }
  try {
    const gitOptions: ExecFileSyncOptionsWithStringEncoding = { cwd: rootDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim()
    dirty = execFileSync('git', ['status', '--porcelain'], gitOptions).trim().length > 0
  } catch { /* commit stays unknown, dirty stays false */ }
  return { version, gitCommit, dirty }
}

interface RecordingTrainingRow {
  start_date: string
  current_date: string | null
  adjust_mode: string
}

interface PositionEventRow {
  seq: number
  date: string
  kind: string
  shares_delta: number
  cash_delta: number
  cost_delta: number | null
}

// 录制观察端点：返回录制时实际生效的规则、版本与已入账权息事件。
// 只读；不访问 TDX 文件、不触碰 /api/kline、不下发任何推进日之后的数据。
export async function registerRecordingContextRoutes(app: FastifyInstance, config: AppConfig, database: DatabaseSync): Promise<void> {
  void config
  const appInfo = readAppInfo()
  app.get('/api/trainings/:id/recording-context', async request => {
    const { id } = request.params as { id: string }
    const trainingId = Number(id)
    // 严格十进制正整数字符串：拒绝 Number() 宽松解析会接受的 1e0、0x1、1.0、01、+1 等形式。
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(trainingId)) throw new HttpError(400, 'id 必须是正整数')
    // current_date 在 SQLite 里是 CURRENT_DATE 关键字，选择列表中必须加引号才是列名（engine.ts 走 SELECT * 故未踩坑）。
    const training = database.prepare(
      'SELECT start_date, "current_date" AS current_date, adjust_mode FROM trainings WHERE id = ?',
    ).get(trainingId) as unknown as RecordingTrainingRow | undefined
    if (!training) throw new HttpError(404, `训练 ${trainingId} 不存在`)
    const cutoff = training.current_date ?? training.start_date
    const events = database.prepare(`
      SELECT seq, date, kind, shares_delta, cash_delta, cost_delta
      FROM position_events
      WHERE training_id = ? AND date <= ?
      ORDER BY date, seq
    `).all(trainingId, cutoff) as unknown as PositionEventRow[]
    return {
      app: {
        version: appInfo.version,
        gitCommit: appInfo.gitCommit,
        dirty: appInfo.dirty,
        chartLibrary: '10.0.3',
      },
      rules: {
        // 费用/T+1 每次请求读取 settings 当前值，是"实际观察到的规则"，不是创建时的冻结快照（见 TRAIN-01）。
        feesEnabled: feeConfigOf(database).enabled,
        tPlusOne: t1Enabled(database),
        lotSize: LOT_SIZE,
        commissionRate: COMMISSION_RATE,
        minimumCommission: COMMISSION_MIN,
        stampDutyRate: STAMP_TAX_RATE,
        execution: 'same-day-raw-close',
        weightBasis: 'total-equity',
        adjustMode: training.adjust_mode,
        observedAt: new Date().toISOString(),
      },
      positionEvents: events.map(event => ({
        seq: event.seq,
        date: event.date,
        kind: event.kind,
        sharesDelta: event.shares_delta,
        cashDelta: event.cash_delta,
        costDelta: event.cost_delta,
      })),
    }
  })
}
