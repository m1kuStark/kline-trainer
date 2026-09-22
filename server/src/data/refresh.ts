// 统一日线刷新协调器：手动按钮、启动检查、窗口激活与内部调用共用。
// 单飞行任务：同一来源同一时刻最多一个扫描任务，重复触发复用（joined=true）。
// 流程：扫描目录与日线（稳定读取）→ 目录扫描（只读）→ 权息扫描（只读）→ 发布屏障 →
// 单事务整批提交（目录＋权息＋文件快照＋成功日志＋批次标识）；任一步失败任务置 failed
// （中文可行动原因），上一份完整批次原样保留。目录扫描不完整（failures 非空）同样整批失败。
// 迟到写入屏障：看门狗超时或任务被结束后，任何迟到的异步步骤都不得再写库；新任务可安全开始。
// 任务状态只在内存，服务重启自然回到 idle，绝不从库里恢复出 running。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AppConfig } from '../config.js'
import { applyCatalogChanges, scanCatalogChanges, type CatalogChanges } from '../tdx/catalog.js'
import { applyAdjustmentChanges, scanAdjustmentChanges, type AdjustmentChanges } from '../tdx/adjustment-cache.js'
import { selectSource } from './selection.js'
import { createTdxSource } from './tdxSource.js'
import { appendFailureLog, applyScanResult, loadRefreshLog, loadScanBaseline, publishBatchVersion, type RefreshLogEntry, type RefreshOutcome } from './snapshot.js'
import type { DailySource, ScanOutcome } from './source.js'

/** 单次刷新任务的看门狗超时（毫秒） */
export const REFRESH_TIMEOUT_MS = 120_000

export type RefreshState = 'idle' | 'running' | 'unchanged' | 'updated' | 'failed'

export interface DataRefreshStart {
  taskId: string
  state: 'running'
  joined: boolean
}

export interface DataSourceInfoPayload {
  kind: 'tdx' | 'online' | 'none'
  name: string
  available: boolean
}

export interface DataStatusPayload {
  state: RefreshState
  needsUpdate: boolean
  /** 中文一句话，可直接展示 */
  reason: string
  source: DataSourceInfoPayload
  tdx: { available: boolean; root: string | null }
  online: { configured: boolean; provider: string | null }
  sourceMaxDate: string | null
  lastCheckedAt: string | null
  lastResult: {
    finishedAt: string
    outcome: RefreshOutcome
    added: number
    removed: number
    revised: number
    message: string
  } | null
  revisionWarning: string | null
}

export interface CreateRefreshCoordinatorOptions {
  /** 测试可注入极短超时；默认 REFRESH_TIMEOUT_MS */
  timeoutMs?: number
  /** 测试注入：替换默认 TDX 来源（包装真实扫描、在扫描后变更夹具） */
  tdxSource?: DailySource
  /** 测试注入：发布屏障前最后一次 await，用于把看门狗超时插到目录/权息扫描之后 */
  beforePublish?: () => Promise<void>
}

interface RunningTask { id: string }

/** E＝今天之前最近的工作日（跳过周六周日即可；节假日休市可能误报，由文案兜底）。 */
export function lastWeekdayBeforeToday(now: Date = new Date()): string {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  do {
    cursor.setDate(cursor.getDate() - 1)
  } while (cursor.getDay() === 0 || cursor.getDay() === 6)
  const year = cursor.getFullYear()
  const month = `${cursor.getMonth() + 1}`.padStart(2, '0')
  const day = `${cursor.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createDataRefreshCoordinator(
  database: DatabaseSync,
  config: AppConfig,
  options: CreateRefreshCoordinatorOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? REFRESH_TIMEOUT_MS
  const tdxSource = options.tdxSource ?? createTdxSource(config.tdxRoot)
  let running: RunningTask | null = null
  let lastState: Exclude<RefreshState, 'running'> = 'idle'

  function complete(taskId: string, state: RefreshState, entry: RefreshLogEntry | null): void {
    if (running?.id !== taskId) return
    running = null
    if (entry && state !== 'running') lastState = state as Exclude<RefreshState, 'running'>
  }

  function entryToLastResult(entry: RefreshLogEntry): NonNullable<DataStatusPayload['lastResult']> {
    return {
      finishedAt: entry.finishedAt,
      outcome: entry.outcome,
      added: entry.added,
      removed: entry.removed,
      revised: entry.revised,
      message: entry.message,
    }
  }

  async function runTask(taskId: string, source: DailySource): Promise<void> {
    let timedOut = false
    // 迟到写入屏障：超时或任务已结束（含新任务接管）后，任何迟到步骤一律不得再写库。
    // 检查与整批事务之间没有任何 await（node:sqlite 同步执行），事件循环不会插入其他写入。
    const barrierOpen = (): boolean => !timedOut && running?.id === taskId
    const watchdog = setTimeout(() => {
      timedOut = true
      const entry: RefreshLogEntry = {
        finishedAt: new Date().toISOString(),
        outcome: 'failed',
        added: 0,
        removed: 0,
        revised: 0,
        sourceKind: source.kind,
        sourceMaxDate: null,
        message: `扫描超时（超过 ${Math.round(timeoutMs / 1000)} 秒），已保留原有数据与快照，请检查磁盘状态后重试`,
      }
      try {
        appendFailureLog(database, entry)
      } finally {
        complete(taskId, 'failed', entry)
      }
    }, timeoutMs)
    watchdog.unref()

    try {
      const previous = loadScanBaseline(database)
      const outcome = await source.scan(previous)
      if (!barrierOpen()) return
      let catalogChanges: CatalogChanges | null = null
      let adjustmentChanges: AdjustmentChanges | null = null
      if (source.kind === 'tdx') {
        if (!config.tdxRoot) throw new Error('未检测到通达信数据目录，无法刷新股票目录与权息缓存')
        try {
          catalogChanges = await scanCatalogChanges(database, config.tdxRoot)
        } catch (error) {
          throw new Error(`刷新股票目录失败：${errorMessage(error)}。请检查通达信数据目录后重试`)
        }
        if (catalogChanges.failures.length > 0) {
          // 目录扫描不完整＝本批不可发布：整体按失败处理，保留上一份完整批次，绝不发布半批
          throw new Error(`刷新股票目录失败：${catalogChanges.failures.map(item => item.message).join('；')}。本次不发布任何变更，请检查磁盘状态后重试`)
        }
        if (!barrierOpen()) return
        try {
          adjustmentChanges = await scanAdjustmentChanges(database, config.tdxRoot)
        } catch (error) {
          throw new Error(`刷新权息缓存失败：无法读取 ${join(config.tdxRoot, 'T0002', 'hq_cache', 'gbbq')} —— ${errorMessage(error)}。请确认通达信已完成盘后数据下载后重试`)
        }
        if (!barrierOpen()) return
      }
      if (options.beforePublish) await options.beforePublish()
      if (!barrierOpen()) return

      const finishedAt = new Date().toISOString()
      const resultOutcome: RefreshOutcome = outcome.baseline || outcome.added > 0 || outcome.removed > 0 || outcome.revised > 0
        ? 'updated'
        : 'unchanged'
      const entry: RefreshLogEntry = {
        finishedAt,
        outcome: resultOutcome,
        added: outcome.added,
        removed: outcome.removed,
        revised: outcome.revised,
        sourceKind: source.kind,
        sourceMaxDate: outcome.sourceMaxDate,
        message: describeOutcome(outcome),
      }
      // 发布屏障：目录、权息、文件快照、成功日志与批次标识在同一事务内一次性生效；
      // 任一环节失败整体回滚，上一份完整批次原样保留。
      const batchId = randomUUID()
      database.exec('BEGIN IMMEDIATE')
      try {
        if (catalogChanges) applyCatalogChanges(database, catalogChanges)
        if (adjustmentChanges) applyAdjustmentChanges(database, adjustmentChanges)
        applyScanResult(database, outcome, entry)
        publishBatchVersion(database, batchId)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      complete(taskId, resultOutcome, entry)
    } catch (error) {
      if (!barrierOpen()) return
      const entry: RefreshLogEntry = {
        finishedAt: new Date().toISOString(),
        outcome: 'failed',
        added: 0,
        removed: 0,
        revised: 0,
        sourceKind: source.kind,
        sourceMaxDate: null,
        message: `${errorMessage(error)}（已保留原有数据与快照，可重试）`,
      }
      try {
        appendFailureLog(database, entry)
      } finally {
        complete(taskId, 'failed', entry)
      }
    } finally {
      clearTimeout(watchdog)
    }
  }

  function describeOutcome(outcome: ScanOutcome): string {
    const until = outcome.sourceMaxDate ? `，数据截至 ${outcome.sourceMaxDate}` : ''
    if (outcome.baseline) return `已完成首次数据扫描并建立基线：共 ${outcome.totalStocks} 只股票${until}`
    if (outcome.added > 0 || outcome.removed > 0 || outcome.revised > 0) {
      return `更新完成：新增 ${outcome.added} 只、移除 ${outcome.removed} 只、疑似历史修订 ${outcome.revised} 只${until}`
    }
    return `检查完成：与上次快照一致，暂无新数据${until}`
  }

  async function start(): Promise<DataRefreshStart | null> {
    // 同步占位，防并发重复建任务；无可用来源时回滚占位并返回 null（由路由映射 409）
    if (running) return { taskId: running.id, state: 'running', joined: true }
    const taskId = randomUUID()
    running = { id: taskId }
    const selection = await selectSource(tdxSource)
    if (!selection.source) {
      running = null
      return null
    }
    void runTask(taskId, selection.source)
    return { taskId, state: 'running', joined: false }
  }

  async function getStatus(): Promise<DataStatusPayload> {
    const selection = await selectSource(tdxSource)
    const { last, lastSuccess } = loadRefreshLog(database)
    const state: RefreshState = running ? 'running' : lastState
    const source: DataSourceInfoPayload = selection.source
      ? { kind: selection.source.kind, name: selection.source.name, available: true }
      : { kind: 'none', name: '无可用数据源', available: false }

    let needsUpdate: boolean
    let reason: string
    if (!selection.source) {
      needsUpdate = false
      reason = '未检测到可用数据源：通达信数据目录不可用，且未配置在线数据源'
    } else if (lastSuccess?.sourceMaxDate == null) {
      needsUpdate = true
      reason = '尚未完成首次数据扫描，建议执行一次“更新日线”'
    } else {
      const expected = lastWeekdayBeforeToday()
      const sourceMaxDate = lastSuccess.sourceMaxDate
      if (sourceMaxDate < expected) {
        needsUpdate = true
        reason = `本地日线数据截至 ${sourceMaxDate}，落后于最近交易日 ${expected}，建议更新（若当日为节假日休市，属正常现象）`
      } else {
        needsUpdate = false
        reason = `当前数据已达到最新（截至 ${sourceMaxDate}）`
      }
    }

    const revisionWarning = lastSuccess && lastSuccess.revised > 0
      ? `检测到 ${lastSuccess.revised} 只股票历史日线疑似修订，已有训练按旧数据口径继续，建议核对`
      : null

    return {
      state,
      needsUpdate,
      reason,
      source,
      tdx: { available: selection.tdxAvailable, root: config.tdxRoot },
      online: { configured: selection.onlineConfigured, provider: selection.onlineProvider },
      sourceMaxDate: lastSuccess?.sourceMaxDate ?? null,
      lastCheckedAt: last?.finishedAt ?? null,
      lastResult: last ? entryToLastResult(last) : null,
      revisionWarning,
    }
  }

  return { start, getStatus }
}

export type DataRefreshCoordinator = ReturnType<typeof createDataRefreshCoordinator>
