// REC-01 v2紧凑存储：web/src/recording/compactStorage.ts
// 实现 docs/engineering/recording-v2-contract.md「录制与持久化迁移」的增量持久化：
// header（compactSessions）与不可变追加记录（compactRecords，keyPath [sessionId,kind,index]）分离，
// 同库（trainer-recordings version 2）保留旧 v1 sessions，loadLegacy 供迁移接线按需读取原始值。
// 一次 save 只 put 新增条目 + header，单事务原子提交，事务 complete 后才推进本地游标/revision；
// 输入条目按调用者不可变契约处理，只做浅数组切片，不深复制全部历史。
// 本单元不导入 codec/validation：结构校验与 v1→v2 迁移转换属后续独立任务。
import { RECORDING_DB_NAME, RECORDING_STORE_NAME } from './storage'
import type {
  CompactCheckpoint,
  CompactRecordingFile,
  CompactResources,
} from './compactTypes'
import type {
  RecordingEvent,
  RecordingFile,
  RecordingFileAppInfo,
  RecordingFileEnvironment,
  RecordingGap,
  RecordingSummary,
} from './types'

/**
 * v2 存储端口：save 幂等增量提交，load 重组紧凑文件（不展开行情），list 合并新旧摘要。
 * remove 可选以兼容旧自定义 storage 实现；生产（IndexedDB）与内存实现必须支持——
 * 删除目标会话全部持久数据（compact header+记录行与旧 v1 行），幂等，失败拒绝。
 */
export interface CompactRecordingStorage {
  save(file: CompactRecordingFile): Promise<void>
  load(id: string): Promise<CompactRecordingFile | null>
  list(): Promise<RecordingSummary[]>
  remove?(id: string): Promise<void>
}

export const RECORDING_DB_VERSION = 2
export const COMPACT_SESSIONS_STORE = 'compactSessions'
export const COMPACT_RECORDS_STORE = 'compactRecords'

const RESOURCE_KINDS = ['series', 'drawings', 'trainingMeta', 'accounts', 'trades', 'contexts'] as const
type ResourceKind = (typeof RESOURCE_KINDS)[number]
type ResourceEntry = CompactResources[ResourceKind][number]
type CompactRecordKind = 'event' | 'checkpoint' | ResourceKind

const RESOURCE_LABELS: Record<ResourceKind, string> = {
  series: '行情版本',
  drawings: '画线版本',
  trainingMeta: '训练元信息',
  accounts: '账户',
  trades: '成交',
  contexts: '上下文',
}

interface CompactCounts {
  events: number
  checkpoints: number
  series: number
  drawings: number
  trainingMeta: number
  accounts: number
  trades: number
  contexts: number
}

/** compactSessions 行：会话元信息 + gaps/complete/counts + revision + 最后提交批次身份 */
interface CompactSessionHeader {
  format: 'trainer-session'
  schemaVersion: 2
  sessionId: string
  createdAt: string
  app: RecordingFileAppInfo
  environment: RecordingFileEnvironment
  trainingKey: string | null
  gaps: RecordingGap[]
  complete: boolean
  counts: CompactCounts
  revision: number
  batchId: string
}

/** compactRecords 行：keyPath [sessionId, kind, index]，value 为对应表内原始条目 */
interface CompactRecordRow {
  sessionId: string
  kind: CompactRecordKind
  index: number
  value: RecordingEvent | CompactCheckpoint | ResourceEntry
}

/** 实例内已提交状态：上次 load/提交时的条目引用与游标（header.counts/revision），用于前缀核对与批次计算 */
interface CommittedSession {
  header: CompactSessionHeader
  events: RecordingEvent[]
  checkpoints: CompactCheckpoint[]
  resources: CompactResources
}

interface PendingBatch {
  countsBefore: CompactCounts
  countsAfter: CompactCounts
  events: RecordingEvent[]
  checkpoints: CompactCheckpoint[]
  resourceEntries: Array<{ kind: ResourceKind; value: ResourceEntry }>
  /** gaps/complete/元信息相对已提交 header 是否变化（空批次但 header 变化仍需写 header） */
  headerChanged: boolean
}

type HeaderDecision =
  | { op: 'write'; header: CompactSessionHeader; rows: CompactRecordRow[] }
  | { op: 'noop' }
  | { op: 'verifyAdopt' }

type SaveOutcome = { op: 'write'; header: CompactSessionHeader } | { op: 'noop' } | { op: 'adopt'; header: CompactSessionHeader }

function zeroCounts(): CompactCounts {
  return { events: 0, checkpoints: 0, series: 0, drawings: 0, trainingMeta: 0, accounts: 0, trades: 0, contexts: 0 }
}

function countOf(file: CompactRecordingFile): CompactCounts {
  return {
    events: file.events.length,
    checkpoints: file.checkpoints.length,
    series: file.resources.series.length,
    drawings: file.resources.drawings.length,
    trainingMeta: file.resources.trainingMeta.length,
    accounts: file.resources.accounts.length,
    trades: file.resources.trades.length,
    contexts: file.resources.contexts.length,
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    const bm = b as Record<string, unknown>
    return ak.every(key => key in bm && deepEqual((a as Record<string, unknown>)[key], bm[key]))
  }
  return false
}

/** 对象键排序的规范化 JSON：跨实例内容一致则串一致，仅用于批次身份 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 批次身份 = base revision + 新增行 + 被保存 header 全部内容（除系统字段 revision/batchId 外
 * 逐项纳入：sessionId/createdAt/app/environment/trainingKey/gaps/complete/counts）的规范化指纹
 * （FNV-1a 32位 + 长度）。仅作快速预筛：采纳路径仍对 header 逐字段深比、记录行逐条深比，
 * 防哈希碰撞掩盖分叉。
 */
function batchIdOf(expectedRevision: number, file: CompactRecordingFile, batch: PendingBatch): string {
  const canonical = stableStringify({
    base: expectedRevision,
    sessionId: file.sessionId,
    createdAt: file.createdAt,
    app: file.app,
    environment: file.environment,
    trainingKey: file.trainingKey,
    gaps: file.gaps,
    complete: file.complete,
    counts: batch.countsAfter,
    events: batch.events,
    checkpoints: batch.checkpoints,
    resources: batch.resourceEntries.map(entry => ({ kind: entry.kind, value: entry.value })),
  })
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${canonical.length}`
}

function countsEqual(a: CompactCounts, b: CompactCounts): boolean {
  return (
    a.events === b.events &&
    a.checkpoints === b.checkpoints &&
    RESOURCE_KINDS.every(kind => a[kind] === b[kind])
  )
}

function assertPrefixNotShortened(label: string, sessionId: string, before: number, after: number): void {
  if (after < before) {
    throw new Error(`会话 ${sessionId} 已提交的${label}被缩短（${after} < ${before}），拒绝保存；已提交前缀不可删除或重排。`)
  }
}

function assertPrefixEntry(
  label: string,
  sessionId: string,
  index: number,
  incoming: unknown,
  committed: unknown,
  sameArray: boolean,
): void {
  if (sameArray || incoming === committed) return
  // 输入条目不可变：引用相同为快路径；重建数组时逐条内容核对，不能只比长度
  if (!deepEqual(incoming, committed)) {
    throw new Error(`会话 ${sessionId} 已提交的${label} #${index} 与提交记录不一致，拒绝保存；已存条目不可就地修改。`)
  }
}

function computeBatch(file: CompactRecordingFile, committed: CommittedSession | null): PendingBatch {
  const after = countOf(file)
  if (!committed) {
    const resourceEntries: PendingBatch['resourceEntries'] = []
    for (const kind of RESOURCE_KINDS) {
      for (const value of file.resources[kind] as readonly ResourceEntry[]) {
        resourceEntries.push({ kind, value })
      }
    }
    return {
      countsBefore: zeroCounts(),
      countsAfter: after,
      events: file.events.slice(),
      checkpoints: file.checkpoints.slice(),
      resourceEntries,
      headerChanged: true,
    }
  }
  const before = committed.header.counts
  assertPrefixNotShortened('事件', file.sessionId, before.events, after.events)
  const eventsSame = file.events === committed.events
  for (let i = 0; i < before.events; i++) {
    assertPrefixEntry('事件', file.sessionId, i, file.events[i], committed.events[i], eventsSame)
  }
  assertPrefixNotShortened('检查点', file.sessionId, before.checkpoints, after.checkpoints)
  const checkpointsSame = file.checkpoints === committed.checkpoints
  for (let i = 0; i < before.checkpoints; i++) {
    assertPrefixEntry('检查点', file.sessionId, i, file.checkpoints[i], committed.checkpoints[i], checkpointsSame)
  }
  const resourceEntries: PendingBatch['resourceEntries'] = []
  for (const kind of RESOURCE_KINDS) {
    assertPrefixNotShortened(RESOURCE_LABELS[kind], file.sessionId, before[kind], after[kind])
    const committedList = committed.resources[kind] as readonly ResourceEntry[]
    const incomingList = file.resources[kind] as readonly ResourceEntry[]
    const sameList = incomingList === committedList
    for (let i = 0; i < before[kind]; i++) {
      assertPrefixEntry(RESOURCE_LABELS[kind], file.sessionId, i, incomingList[i], committedList[i], sameList)
    }
    for (let i = before[kind]; i < incomingList.length; i++) {
      resourceEntries.push({ kind, value: incomingList[i]! })
    }
  }
  const header = committed.header
  const headerChanged =
    !deepEqual(file.gaps, header.gaps) ||
    file.complete !== header.complete ||
    file.trainingKey !== header.trainingKey ||
    file.createdAt !== header.createdAt ||
    !deepEqual(file.app, header.app) ||
    !deepEqual(file.environment, header.environment)
  return {
    countsBefore: { ...before },
    countsAfter: after,
    events: file.events.slice(before.events),
    checkpoints: file.checkpoints.slice(before.checkpoints),
    resourceEntries,
    headerChanged,
  }
}

function buildRows(file: CompactRecordingFile, batch: PendingBatch): CompactRecordRow[] {
  const rows: CompactRecordRow[] = []
  batch.events.forEach((value, offset) => {
    rows.push({ sessionId: file.sessionId, kind: 'event', index: batch.countsBefore.events + offset, value })
  })
  batch.checkpoints.forEach((value, offset) => {
    rows.push({ sessionId: file.sessionId, kind: 'checkpoint', index: batch.countsBefore.checkpoints + offset, value })
  })
  const cursor: Record<ResourceKind, number> = {
    series: batch.countsBefore.series,
    drawings: batch.countsBefore.drawings,
    trainingMeta: batch.countsBefore.trainingMeta,
    accounts: batch.countsBefore.accounts,
    trades: batch.countsBefore.trades,
    contexts: batch.countsBefore.contexts,
  }
  for (const entry of batch.resourceEntries) {
    rows.push({ sessionId: file.sessionId, kind: entry.kind, index: cursor[entry.kind], value: entry.value })
    cursor[entry.kind] += 1
  }
  return rows
}

function buildHeader(
  file: CompactRecordingFile,
  counts: CompactCounts,
  revision: number,
  batchId: string,
): CompactSessionHeader {
  return {
    format: 'trainer-session',
    schemaVersion: 2,
    sessionId: file.sessionId,
    createdAt: file.createdAt,
    app: file.app,
    environment: file.environment,
    trainingKey: file.trainingKey,
    gaps: file.gaps,
    complete: file.complete,
    counts,
    revision,
    batchId,
  }
}

function rowKeyOf(kind: CompactRecordKind, index: number): string {
  return `${kind}\u0000${index}`
}

/**
 * 纯决策（只依赖持久 header，不读记录行）：
 * - 实例未持有会话而持久已存在 → 拒绝（禁止未 load 直接覆盖他人会话）；
 * - revision 匹配 → 写新增 + header（空批次且 header 未变则 no-op）；
 * - revision 恰好 +1 且批次身份（哈希预筛）吻合 → 待读记录行与 header 逐字段核实后采纳
 *   （同一成功批次的重试）；
 * - 其余 → 冲突拒绝，不自动抢锁。
 */
function decideFromHeader(
  persisted: CompactSessionHeader | null,
  committed: CommittedSession | null,
  file: CompactRecordingFile,
  batch: PendingBatch,
  batchId: string,
): HeaderDecision {
  const expectedRevision = committed ? committed.header.revision : 0
  const rows = buildRows(file, batch)
  if (!committed) {
    if (persisted) {
      throw new Error(`会话 ${file.sessionId} 已存在于存储中，但本实例尚未 load；拒绝直接覆盖，请先 load 该会话。`)
    }
    return { op: 'write', header: buildHeader(file, batch.countsAfter, 1, batchId), rows }
  }
  if (!persisted) {
    throw new Error(`存储中已不存在会话 ${file.sessionId}，拒绝基于过期状态继续追加；请重新评估后另存新会话。`)
  }
  if (persisted.revision === expectedRevision) {
    if (rows.length === 0 && !batch.headerChanged) return { op: 'noop' }
    return { op: 'write', header: buildHeader(file, batch.countsAfter, expectedRevision + 1, batchId), rows }
  }
  if (
    persisted.revision === expectedRevision + 1 &&
    persisted.batchId === batchId &&
    countsEqual(persisted.counts, batch.countsAfter)
  ) {
    return { op: 'verifyAdopt' }
  }
  throw new Error(
    `会话 ${file.sessionId} 已被其他实例推进：持久 revision ${persisted.revision}，本实例预期 ${expectedRevision}；` +
      '已保留本实例内存数据，请重新 load 后再保存。',
  )
}

/** header 除系统字段（revision/batchId）外的逐字段深等：采纳路径的权威证据，哈希仅预筛 */
function headerContentEqual(a: CompactSessionHeader, b: CompactSessionHeader): boolean {
  return (
    a.format === b.format &&
    a.schemaVersion === b.schemaVersion &&
    a.sessionId === b.sessionId &&
    a.createdAt === b.createdAt &&
    deepEqual(a.app, b.app) &&
    deepEqual(a.environment, b.environment) &&
    a.trainingKey === b.trainingKey &&
    deepEqual(a.gaps, b.gaps) &&
    a.complete === b.complete &&
    countsEqual(a.counts, b.counts)
  )
}

/**
 * 采纳核实（同一成功批次的重试）：持久 header 与本实例将写出的 header 逐字段深等
 * （空记录批次同样不可绕过），持久记录行与计划新增逐条深比；
 * 一致返回持久 header，否则视为分叉冲突。
 */
function verifyAdopt(
  persisted: CompactSessionHeader,
  plannedHeader: CompactSessionHeader,
  plannedRows: CompactRecordRow[],
  persistedRows: CompactRecordRow[],
): CompactSessionHeader {
  if (!headerContentEqual(persisted, plannedHeader)) {
    throw new Error(
      `会话 ${persisted.sessionId} 的 header 与本实例批次不一致（持久 revision ${persisted.revision}）；` +
        '已保留本实例内存数据，请重新 load 后再保存。',
    )
  }
  const byKey = new Map(persistedRows.map(row => [rowKeyOf(row.kind, row.index), row.value]))
  for (const row of plannedRows) {
    const value = byKey.get(rowKeyOf(row.kind, row.index))
    if (value === undefined || !deepEqual(value, row.value)) {
      throw new Error(
        `会话 ${persisted.sessionId} 的追加内容与本实例批次不一致（持久 revision ${persisted.revision}）；` +
          '已保留本实例内存数据，请重新 load 后再保存。',
      )
    }
  }
  return persisted
}

/** 提交后的实例状态：保留文件条目引用与浅数组（调用者不可变契约），header.gaps 深拷贝以感知就地补 gap */
function committedFrom(file: CompactRecordingFile, header: CompactSessionHeader): CommittedSession {
  return {
    header: { ...header, gaps: structuredClone(header.gaps) },
    events: file.events,
    checkpoints: file.checkpoints,
    resources: file.resources,
  }
}

/** 记录行 kind 全集；六张资源表名与 CompactCounts 键一致，event/checkpoint 之外直接查 counts */
const RECORD_KINDS = ['event', 'checkpoint', ...RESOURCE_KINDS] as const

/** 行条目身份：event 用 opId，其余表用 id；必须为非空字符串，损坏行在此拒绝 */
function entryIdentityOf(kind: CompactRecordKind, value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>)[kind === 'event' ? 'opId' : 'id']
  return typeof id === 'string' && id !== '' ? id : null
}

function countsKeyOf(kind: CompactRecordKind): keyof CompactCounts {
  return kind === 'event' ? 'events' : kind === 'checkpoint' ? 'checkpoints' : kind
}

/**
 * 重组紧凑文件：对每 kind 校验行下标连续 0..counts-1、条目身份合法、行数与 header.counts
 * 精确一致；缺行/多行/重复/未知 kind/非法 id 均明确拒绝，不静默返回部分录制。
 * 行 value 引用直接使用（IDB getAll 已结构化克隆），不深拷贝。
 */
function assemble(header: CompactSessionHeader, rows: CompactRecordRow[]): CompactRecordingFile {
  const byKind = new Map<CompactRecordKind, Map<number, unknown>>(RECORD_KINDS.map(kind => [kind, new Map()]))
  for (const row of rows) {
    const bucket = byKind.get(row.kind)
    if (!bucket) {
      throw new Error(`会话 ${header.sessionId} 持久记录损坏：存在未知 kind「${String(row.kind)}」的记录行，拒绝加载。`)
    }
    if (entryIdentityOf(row.kind, row.value) === null) {
      throw new Error(
        `会话 ${header.sessionId} 持久记录损坏：${row.kind} #${row.index} 的条目缺少合法 id/opId，拒绝加载。`,
      )
    }
    if (!Number.isSafeInteger(row.index) || row.index < 0) {
      throw new Error(
        `会话 ${header.sessionId} 持久记录损坏：${row.kind} 行下标 ${String(row.index)} 非法，拒绝加载。`,
      )
    }
    if (bucket.has(row.index)) {
      throw new Error(`会话 ${header.sessionId} 持久记录损坏：${row.kind} #${row.index} 出现重复行，拒绝加载。`)
    }
    bucket.set(row.index, row.value)
  }
  for (const kind of RECORD_KINDS) {
    const bucket = byKind.get(kind)!
    const count = header.counts[countsKeyOf(kind)]
    if (bucket.size !== count) {
      throw new Error(
        `会话 ${header.sessionId} 持久记录损坏：${kind} 行数 ${bucket.size} 与 header.counts ${count} 不一致，拒绝加载。`,
      )
    }
    for (let index = 0; index < count; index++) {
      if (!bucket.has(index)) {
        throw new Error(
          `会话 ${header.sessionId} 持久记录损坏：${kind} 缺少下标 ${index} 的记录行（counts=${count}），拒绝加载。`,
        )
      }
    }
  }
  const events: RecordingEvent[] = []
  const checkpoints: CompactCheckpoint[] = []
  const resources: CompactResources = {
    series: [],
    drawings: [],
    trainingMeta: [],
    accounts: [],
    trades: [],
    contexts: [],
  }
  for (let index = 0; index < header.counts.events; index++) {
    events.push(byKind.get('event')!.get(index) as RecordingEvent)
  }
  for (let index = 0; index < header.counts.checkpoints; index++) {
    checkpoints.push(byKind.get('checkpoint')!.get(index) as CompactCheckpoint)
  }
  for (const kind of RESOURCE_KINDS) {
    const list = resources[kind] as unknown[]
    const bucket = byKind.get(kind)!
    for (let index = 0; index < header.counts[kind]; index++) {
      list.push(bucket.get(index))
    }
  }
  return {
    format: 'trainer-session',
    schemaVersion: 2,
    sessionId: header.sessionId,
    createdAt: header.createdAt,
    app: header.app,
    environment: header.environment,
    trainingKey: header.trainingKey,
    events,
    checkpoints,
    gaps: header.gaps,
    complete: header.complete,
    resources,
  }
}

function describeDbError(error: DOMException | null): string {
  return error?.message ?? '未知错误'
}

function sessionRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, ''], [id, '\uffff'])
}

function openCompactDb(onVersionChange: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB，无法持久化录制会话。'))
      return
    }
    let settled = false
    const request = indexedDB.open(RECORDING_DB_NAME, RECORDING_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // 保留旧 v1 sessions；全新库也建出以支持 loadLegacy/list
      if (!db.objectStoreNames.contains(RECORDING_STORE_NAME)) {
        db.createObjectStore(RECORDING_STORE_NAME, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(COMPACT_SESSIONS_STORE)) {
        db.createObjectStore(COMPACT_SESSIONS_STORE, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(COMPACT_RECORDS_STORE)) {
        db.createObjectStore(COMPACT_RECORDS_STORE, { keyPath: ['sessionId', 'kind', 'index'] })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        onVersionChange(db)
      }
      if (settled) {
        // onblocked 已定案拒绝后迟到的 success：连接立即关闭，避免泄漏
        db.close()
        return
      }
      settled = true
      resolve(db)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(new Error(`打开录制会话数据库失败：${describeDbError(request.error)}`))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('录制会话数据库被其他标签页占用，请关闭本站点其他标签页后重试。'))
    }
  })
}

function requestValue<T>(request: IDBRequest<T>, failPrefix: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(`${failPrefix}：${describeDbError(request.error)}`))
  })
}

function transactionSettled(tx: IDBTransaction, failPrefix: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error(`${failPrefix}：${describeDbError(tx.error)}`))
    tx.onabort = () => reject(new Error(`保存录制会话被中止：${describeDbError(tx.error)}`))
  })
}

function getRow<T>(db: IDBDatabase, storeName: string, key: IDBValidKey, failPrefix: string): Promise<T | undefined> {
  const tx = db.transaction([storeName], 'readonly')
  const value = requestValue(tx.objectStore(storeName).get(key) as IDBRequest<T | undefined>, failPrefix)
  const done = transactionSettled(tx, failPrefix)
  return Promise.all([value, done]).then(([result]) => result)
}

/**
 * 单事务 save：读 header 决策 → 需要时读记录行核实采纳 → 写新增行 + header。
 * 决策拒绝时不改写任何条目并中止事务；resolve 仅发生在事务 complete 之后。
 */
function saveInTransaction(
  db: IDBDatabase,
  sessionId: string,
  decide: (persisted: CompactSessionHeader | null) => HeaderDecision,
  verifyAdoptRows: (persisted: CompactSessionHeader, persistedRows: CompactRecordRow[]) => CompactSessionHeader,
): Promise<SaveOutcome> {
  return new Promise<SaveOutcome>((resolve, reject) => {
    const tx = db.transaction([COMPACT_SESSIONS_STORE, COMPACT_RECORDS_STORE], 'readwrite')
    const headers = tx.objectStore(COMPACT_SESSIONS_STORE)
    const records = tx.objectStore(COMPACT_RECORDS_STORE)
    let settled = false
    const settleResolve = (outcome: SaveOutcome) => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }
    const settleReject = (error: Error) => {
      if (!settled) {
        settled = true
        try {
          tx.abort()
        } catch {
          // 事务可能已定案，忽略二次中止
        }
        reject(error)
      }
    }
    tx.oncomplete = () => {
      if (!settled) {
        settled = true
        // 理论上不可达：所有路径都已先定案；防御占位
        resolve({ op: 'noop' })
      }
    }
    tx.onerror = () => settleReject(new Error(`保存录制会话失败：${describeDbError(tx.error)}`))
    tx.onabort = () => settleReject(new Error(`保存录制会话被中止：${describeDbError(tx.error)}`))

    const headerRequest = headers.get(sessionId) as IDBRequest<CompactSessionHeader | undefined>
    headerRequest.onsuccess = () => {
      let decision: HeaderDecision
      try {
        decision = decide(headerRequest.result ?? null)
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (decision.op === 'write') {
        for (const row of decision.rows) records.put(row)
        headers.put(decision.header)
        tx.oncomplete = () => settleResolve({ op: 'write', header: decision.header })
      } else if (decision.op === 'verifyAdopt') {
        const persisted = headerRequest.result as CompactSessionHeader
        const rowsRequest = records.getAll(sessionRange(sessionId)) as IDBRequest<CompactRecordRow[]>
        rowsRequest.onsuccess = () => {
          try {
            const header = verifyAdoptRows(persisted, rowsRequest.result ?? [])
            tx.oncomplete = () => settleResolve({ op: 'adopt', header })
          } catch (error) {
            settleReject(error instanceof Error ? error : new Error(String(error)))
          }
        }
      } else {
        tx.oncomplete = () => settleResolve({ op: 'noop' })
      }
    }
  })
}

/**
 * 单事务删除目标会话全部数据：compact 记录行（按 session 区间）、compact header 与旧 v1 行。
 * 目标不存在时各 delete 静默完成（幂等）；任一请求失败整体回滚并拒绝，不残留半删状态。
 */
function removeInTransaction(db: IDBDatabase, id: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([COMPACT_SESSIONS_STORE, COMPACT_RECORDS_STORE, RECORDING_STORE_NAME], 'readwrite')
    let settled = false
    const settleReject = (error: Error) => {
      if (!settled) {
        settled = true
        try {
          tx.abort()
        } catch {
          // 事务可能已定案，忽略二次中止
        }
        reject(error)
      }
    }
    tx.oncomplete = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    tx.onerror = () => settleReject(new Error(`删除录制会话失败：${describeDbError(tx.error)}`))
    tx.onabort = () => settleReject(new Error(`删除录制会话被中止：${describeDbError(tx.error)}`))
    try {
      tx.objectStore(COMPACT_RECORDS_STORE).delete(sessionRange(id))
      tx.objectStore(COMPACT_SESSIONS_STORE).delete(id)
      tx.objectStore(RECORDING_STORE_NAME).delete(id)
    } catch (error) {
      settleReject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function toLegacySummary(file: RecordingFile): RecordingSummary {
  return {
    sessionId: file.sessionId,
    trainingKey: file.trainingKey,
    createdAt: file.createdAt,
    eventCount: file.events.length,
  }
}

function toCompactSummary(header: CompactSessionHeader): RecordingSummary {
  return {
    sessionId: header.sessionId,
    trainingKey: header.trainingKey,
    createdAt: header.createdAt,
    eventCount: header.counts.events,
  }
}

/**
 * 生产 IndexedDB 增量存储。连接生命周期与 v1 一致：open 失败不缓存 rejected、
 * close/versionchange 清缓存、blocked 后迟到 success 关闭失效连接；save 串行化本实例，
 * 事务 complete 后才更新已提交游标；load 缓存 expectedRevision 供 save 事务比对。
 * 持久会话被其他实例推进时拒绝保存并保留内存数据，不自动抢锁或覆盖。
 */
export class IndexedDbCompactStorage implements CompactRecordingStorage {
  private dbPromise: Promise<IDBDatabase> | null = null
  private readonly sessions = new Map<string, CommittedSession>()
  private saveQueue: Promise<unknown> = Promise.resolve()

  static get supported(): boolean {
    return typeof indexedDB !== 'undefined'
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = this.startOpen()
    return this.dbPromise
  }

  private startOpen(): Promise<IDBDatabase> {
    const opening = openCompactDb(() => {
      // versionchange 关闭连接后缓存同步失效，下次访问重新打开
      if (this.dbPromise === opening) this.dbPromise = null
    })
    // 打开失败不缓存 rejected promise，下次访问重新尝试
    void opening.catch(() => {
      if (this.dbPromise === opening) this.dbPromise = null
    })
    return opening
  }

  async save(file: CompactRecordingFile): Promise<void> {
    const run = this.saveQueue.then(() => this.runSave(file))
    this.saveQueue = run.catch(() => {})
    return run
  }

  /** 与 save 共用串行队列：在途批次先落盘完成再整体删除，排队保存不会把已删会话复活 */
  async remove(id: string): Promise<void> {
    const run = this.saveQueue.then(() => this.runRemove(id))
    this.saveQueue = run.catch(() => {})
    return run
  }

  private async runRemove(id: string): Promise<void> {
    const db = await this.open()
    await removeInTransaction(db, id)
    // 事务 complete 成功后才丢弃目标的本地游标/revision 缓存；其他会话缓存不受影响
    this.sessions.delete(id)
  }

  private async runSave(file: CompactRecordingFile): Promise<void> {
    const committed = this.sessions.get(file.sessionId) ?? null
    const batch = computeBatch(file, committed) // 前缀违规直接拒绝，不动任何状态
    const batchId = batchIdOf(committed ? committed.header.revision : 0, file, batch)
    const plannedRows = buildRows(file, batch)
    const db = await this.open()
    const outcome = await saveInTransaction(
      db,
      file.sessionId,
      persisted => decideFromHeader(persisted, committed, file, batch, batchId),
      // 核实闭包：持久 header 逐字段深等 + 记录行逐条深比，哈希（batchId）仅预筛
      (persisted, persistedRows) =>
        verifyAdopt(
          persisted,
          buildHeader(file, batch.countsAfter, persisted.revision, persisted.batchId),
          plannedRows,
          persistedRows,
        ),
    )
    // 仅在事务 complete 成功后推进本地游标；no-op 与采纳均以持久 header 为准
    if (outcome.op === 'write' || outcome.op === 'adopt') {
      this.sessions.set(file.sessionId, committedFrom(file, outcome.header))
    }
  }

  async load(id: string): Promise<CompactRecordingFile | null> {
    const db = await this.open()
    const tx = db.transaction([COMPACT_SESSIONS_STORE, COMPACT_RECORDS_STORE], 'readonly')
    const headerPending = requestValue(
      tx.objectStore(COMPACT_SESSIONS_STORE).get(id) as IDBRequest<CompactSessionHeader | undefined>,
      '读取录制会话失败',
    )
    const rowsPending = requestValue(
      tx.objectStore(COMPACT_RECORDS_STORE).getAll(sessionRange(id)) as IDBRequest<CompactRecordRow[]>,
      '读取录制会话失败',
    )
    const done = transactionSettled(tx, '读取录制会话失败')
    const [header, rows] = await Promise.all([headerPending, rowsPending, done])
    if (!header) return null
    const file = assemble(header, rows)
    // 缓存已提交状态与 expectedRevision，供后续 save 事务比对
    this.sessions.set(id, committedFrom(file, header))
    return file
  }

  async list(): Promise<RecordingSummary[]> {
    const db = await this.open()
    const tx = db.transaction([COMPACT_SESSIONS_STORE, RECORDING_STORE_NAME], 'readonly')
    const headersPending = requestValue(
      tx.objectStore(COMPACT_SESSIONS_STORE).getAll() as IDBRequest<CompactSessionHeader[]>,
      '读取录制会话列表失败',
    )
    const legacyPending = requestValue(
      tx.objectStore(RECORDING_STORE_NAME).getAll() as IDBRequest<RecordingFile[]>,
      '读取录制会话列表失败',
    )
    const done = transactionSettled(tx, '读取录制会话列表失败')
    const [headers, legacy] = await Promise.all([headersPending, legacyPending, done])
    const byId = new Map<string, RecordingSummary>()
    for (const file of legacy) byId.set(file.sessionId, toLegacySummary(file))
    // 同 id 优先 v2；旧 v1 记录保留不删
    for (const header of headers) byId.set(header.sessionId, toCompactSummary(header))
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** 读取旧 v1 sessions 原始值；迁移语义校验与 codec 转换由后续接线负责，此处原样返回 */
  async loadLegacy(id: string): Promise<RecordingFile | null> {
    const db = await this.open()
    const file = await getRow<RecordingFile>(db, RECORDING_STORE_NAME, id, '读取录制会话失败')
    return file ?? null
  }

  close(): void {
    if (!this.dbPromise) return
    const opening = this.dbPromise
    this.dbPromise = null
    void opening.then(db => db.close()).catch(() => {})
  }
}

/**
 * 持久镜像 header 快照：clone 可变部分（app/environment/gaps），保证保存瞬间语义——
 * save 完成后调用者就地更新（如 resume 补 gaps[i].resumedAtSeq）不得改写已持久镜像
 * （生产 IDB put 本就结构化克隆，此处对齐）。事件/资源条目按调用者不可变契约共享，不做全历史深拷贝。
 */
function persistedHeaderSnapshot(header: CompactSessionHeader): CompactSessionHeader {
  return {
    ...header,
    app: structuredClone(header.app),
    environment: structuredClone(header.environment),
    gaps: structuredClone(header.gaps),
  }
}

/**
 * 内存实现：语义与 IndexedDbCompactStorage 一致（未 load 拒覆盖、revision 比对、幂等 no-op），
 * 供测试与无持久化环境使用。failWith 注入保存故障；revisionOf/storedRecordCount 供测试观察增量。
 */
export class MemoryCompactStorage implements CompactRecordingStorage {
  private readonly persisted = new Map<string, { header: CompactSessionHeader; rows: CompactRecordRow[] }>()
  private readonly sessions = new Map<string, CommittedSession>()
  private saveQueue: Promise<unknown> = Promise.resolve()
  private saveFailure: Error | null = null
  loadFailure: Error | null = null

  failWith(error: Error | null): void {
    this.saveFailure = error
  }

  /** 测试观察：该会话当前持久 revision（不存在为 null） */
  revisionOf(sessionId: string): number | null {
    return this.persisted.get(sessionId)?.header.revision ?? null
  }

  /** 测试观察：该会话持久化记录行数 */
  storedRecordCount(sessionId: string): number {
    return this.persisted.get(sessionId)?.rows.length ?? 0
  }

  async save(file: CompactRecordingFile): Promise<void> {
    const run = this.saveQueue.then(() => this.runSave(file))
    this.saveQueue = run.catch(() => {})
    return run
  }

  /** 与 save 共用串行队列；failWith 注入的持久化故障同样作用于删除，目标状态保持原样 */
  async remove(id: string): Promise<void> {
    const run = this.saveQueue.then(() => this.runRemove(id))
    this.saveQueue = run.catch(() => {})
    return run
  }

  private runRemove(id: string): void {
    if (this.saveFailure) throw this.saveFailure
    this.persisted.delete(id)
    this.sessions.delete(id)
  }

  private runSave(file: CompactRecordingFile): void {
    if (this.saveFailure) throw this.saveFailure
    const committed = this.sessions.get(file.sessionId) ?? null
    const batch = computeBatch(file, committed)
    const batchId = batchIdOf(committed ? committed.header.revision : 0, file, batch)
    const persisted = this.persisted.get(file.sessionId) ?? null
    const decision = decideFromHeader(persisted?.header ?? null, committed, file, batch, batchId)
    if (decision.op === 'noop') return
    if (decision.op === 'write') {
      const rows = persisted ? [...persisted.rows, ...decision.rows] : decision.rows
      this.persisted.set(file.sessionId, { header: persistedHeaderSnapshot(decision.header), rows })
      this.sessions.set(file.sessionId, committedFrom(file, decision.header))
      return
    }
    const header = verifyAdopt(
      persisted!.header,
      buildHeader(file, batch.countsAfter, persisted!.header.revision, persisted!.header.batchId),
      buildRows(file, batch),
      persisted!.rows,
    )
    this.sessions.set(file.sessionId, committedFrom(file, header))
  }

  async load(id: string): Promise<CompactRecordingFile | null> {
    if (this.loadFailure) throw this.loadFailure
    const persisted = this.persisted.get(id)
    if (!persisted) return null
    const file = assemble(persisted.header, persisted.rows)
    this.sessions.set(id, committedFrom(file, persisted.header))
    return structuredClone(file)
  }

  async list(): Promise<RecordingSummary[]> {
    return [...this.persisted.values()]
      .map(entry => toCompactSummary(entry.header))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}
