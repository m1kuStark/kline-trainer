import { computed, ref } from 'vue'
import { fetchDataStatus, postDataRefresh, type DataRefreshResult, type DataStatus } from './api'

// ===== 日线数据状态：响应式单例 store =====
// 节流口径（用户拍板）：应用启动立即检查一次；窗口回到前台（focus/visibilitychange）
// 距上次检查 ≥60s 才再检查；页面隐藏时不检查也不轮询；发现 state=running 后以约 1s
// 间隔轮询 GET /api/data/status 直到非 running（上限 120s）。手动更新走 POST
// /api/data/refresh（绕过节流，服务端会合并任务），随后进入同样的轮询。

/** 前台激活后再次检查的最小间隔（60s 节流） */
export const DATA_CHECK_THROTTLE_MS = 60_000
/** running 状态轮询间隔（约 1s） */
const DATA_POLL_INTERVAL_MS = 1_000
/** 轮询上限：超过 120s 放弃（等下次前台激活重新接管） */
const DATA_POLL_TIMEOUT_MS = 120_000

/** 最近一次 /api/data/status 的结果（null＝尚未检查过） */
export const dataStatus = ref<DataStatus | null>(null)
/** 正在进行的一次状态检查（含轮询中的单次请求） */
export const dataChecking = ref(false)
/** POST /api/data/refresh 请求本身进行中 */
export const dataRefreshing = ref(false)
/** 轮询循环激活中（等待任务从 running 走向终态） */
export const dataPolling = ref(false)
/** 手动刷新失败时透出的中文原因（如 409 无可用来源） */
export const dataRefreshError = ref('')
/** 最近一次到达的终态结果（供训练页小按钮做"✓"轻提示） */
export const dataRefreshOutcome = ref<Extract<DataRefreshResult['outcome'], 'updated' | 'unchanged' | 'failed'> | null>(null)
/** 每次终态到达自增，训练页 watch 它触发闪烁 */
export const dataOutcomeSeq = ref(0)

/** 更新进行中（任一信号命中即可：refresh 在途 / 轮询循环激活 / 服务端报 running） */
export const dataUpdating = computed(() => dataRefreshing.value || dataPolling.value || dataStatus.value?.state === 'running')

let lastCheckStartedAt = 0
let checkSeq = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollDeadline = 0
// 区分"单次轮询请求在途"与"隐藏暂停"：两者 pollTimer 都为空，只有暂停态允许 startPolling 重新调度
let pollInFlight = false

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** 清理轮询循环与未决请求标记（App 卸载时调用，监听器由 App 成对移除） */
export function cancelDataWatchers(): void {
  checkSeq++
  clearTimeout(pollTimer)
  pollTimer = undefined
  dataPolling.value = false
  dataChecking.value = false
}

/** 启动立即检查一次（force 绕过 60s 节流）；App onMounted 调用 */
export async function checkDataStatus(options?: { force?: boolean }): Promise<void> {
  if (isHidden()) return
  if (!options?.force && Date.now() - lastCheckStartedAt < DATA_CHECK_THROTTLE_MS) return
  lastCheckStartedAt = Date.now()
  const seq = ++checkSeq
  dataChecking.value = true
  try {
    const result = await fetchDataStatus()
    if (seq !== checkSeq) return
    dataStatus.value = result
    if (result.state === 'running') startPolling()
  } catch {
    // 状态检查失败保持静默（不打扰训练），下次前台激活按节流重试
  } finally {
    if (seq === checkSeq) dataChecking.value = false
  }
}

/** 前台激活入口（focus / visibilitychange→visible）：60s 节流内不重复检查，running 任务恢复轮询 */
export function onDataActive(): void {
  if (isHidden()) return
  if (dataStatus.value?.state === 'running') { startPolling(); return }
  void checkDataStatus()
}

function startPolling(): void {
  if (pollTimer !== undefined || pollInFlight) return
  if (!dataPolling.value) {
    dataPolling.value = true
    pollDeadline = Date.now() + DATA_POLL_TIMEOUT_MS
  }
  schedulePoll()
}

function schedulePoll(): void {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(() => { pollTimer = undefined; void pollOnce() }, DATA_POLL_INTERVAL_MS)
}

async function pollOnce(): Promise<void> {
  pollInFlight = true
  try {
    // 页面隐藏时暂停轮询；回到前台由 onDataActive 重新接管
    if (isHidden()) return
    // 超过 120s 上限：停止轮询，等下次激活重新检查
    if (Date.now() >= pollDeadline) { dataPolling.value = false; return }
    const seq = ++checkSeq
    dataChecking.value = true
    try {
      const result = await fetchDataStatus()
      if (seq !== checkSeq) return
      dataStatus.value = result
      if (result.state === 'running') { schedulePoll(); return }
      dataPolling.value = false
      onDataFinished(result)
    } catch {
      // 单次轮询失败不放弃，继续按间隔轮询直到上限
      if (seq === checkSeq) schedulePoll()
    } finally {
      if (seq === checkSeq) dataChecking.value = false
    }
  } finally {
    pollInFlight = false
  }
}

function onDataFinished(result: DataStatus): void {
  const outcome = result.lastResult?.outcome ?? (result.state === 'failed' ? 'failed' : null)
  if (outcome !== 'updated' && outcome !== 'unchanged' && outcome !== 'failed') return
  dataRefreshOutcome.value = outcome
  dataOutcomeSeq.value++
}

/** 手动更新：POST /api/data/refresh（绕过节流；服务端合并已有任务），成功后进入同样的轮询 */
export async function refreshDataNow(): Promise<void> {
  if (dataRefreshing.value || dataPolling.value) return
  dataRefreshing.value = true
  dataRefreshError.value = ''
  lastCheckStartedAt = Date.now()
  try {
    const started = await postDataRefresh()
    if (started.state === 'running') {
      startPolling()
    } else {
      // 服务端直接返回终态（罕见）：补一次状态检查同步 UI
      void checkDataStatus({ force: true })
    }
  } catch (error) {
    // 409 等：把服务端中文 message 行内展示（Launcher 小字区，不用 alert）
    dataRefreshError.value = error instanceof Error ? error.message : '更新失败：无法连接本地服务'
  } finally {
    dataRefreshing.value = false
  }
}
