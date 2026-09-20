import { afterEach, describe, expect, it } from 'vitest'
import {
  IndexedDbCompactStorage,
  MemoryCompactStorage,
} from '../../web/src/recording/compactStorage'
import type {
  CompactCheckpoint,
  CompactRecordingFile,
  SeriesBaseVersion,
} from '../../web/src/recording/compactTypes'
import type { RecordingEvent, RecordingFile } from '../../web/src/recording/types'
import {
  FakeDb,
  FakeIndexedDb,
  FakeOpenRequest,
  FakeRequest,
  FakeTransaction,
  flushStorageOp,
  restoreCompactIdbStub,
  settleMacrotask,
  settleOpen,
  type FakeKeyRange,
} from './helpers/compact-idb'

// REC-02 会话删除：remove(id) 只删目标会话的 compact header+记录行与旧 v1 行，
// 其他会话原样保留；幂等；失败整体回滚并拒绝；与 save 共用串行队列，
// 在途批次先落盘完成再整体删除，防止排队保存把已删除会话复活。
// IndexedDB 侧沿用 helpers/compact-idb 的手动驱动最小 stub 模式，仅扩展 delete 请求。

const stubOriginals = {
  indexedDB: (globalThis as { indexedDB?: unknown }).indexedDB,
  IDBKeyRange: (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange,
}

afterEach(() => {
  restoreCompactIdbStub(stubOriginals)
})

function makeBars(count: number): Array<Record<string, number | string>> {
  return Array.from({ length: count }, (_, i) => ({
    date: `2020-01-0${i + 1}`,
    open: 10,
    high: 11,
    low: 9,
    close: 10 + i * 0.1,
    volume: 1000 + i,
    amount: 10500 + i,
  }))
}

function makeEvent(seq: number, tag = ''): RecordingEvent {
  return {
    seq,
    opId: `op-${seq}${tag}`,
    segmentId: 'seg-1',
    elapsedMs: seq * 100,
    phase: seq === 1 ? 'started' : 'finished',
    action: 'training.advance',
    source: 'ui',
    outcome: 'accepted',
    params: { day: seq },
    result: { ok: true },
    checkpointId: `cp-${seq}${tag}`,
  }
}

function makeCheckpoint(seq: number, tag = ''): CompactCheckpoint {
  return {
    id: `cp-${seq}${tag}`,
    afterSeq: seq,
    segmentId: 'seg-1',
    capturedAt: `2026-01-01T00:0${seq}:00.000Z`,
    ui: { theme: 'light', tool: null, magnet: 'off', multiSelect: false },
    training: null,
    chart: {
      timeframe: '1D',
      seriesRef: 's-d-1',
      drawingsRef: 'dw-1',
      view: {
        fromTimestamp: 1577836800000,
        toTimestamp: 1577923200000,
        barSpace: 8,
        paneHeights: { candle: 300, volume: 100 },
      },
      costPrice: null,
    },
    contextRef: null,
  }
}

function makeSeriesBase(): SeriesBaseVersion {
  return {
    id: 's-d-1',
    timeframe: '1D',
    asOf: '2020-01-02',
    firstCheckpoint: 0,
    base: null,
    bars: makeBars(2) as SeriesBaseVersion['bars'],
  }
}

/** 4 条资源/记录（1事件+1checkpoint+1行情版本+1画线版本），空去重表 */
function makeCompactFile(sessionId: string): CompactRecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 2,
    sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    trainingKey: 'k-1',
    events: [makeEvent(1)],
    checkpoints: [makeCheckpoint(1)],
    gaps: [],
    complete: false,
    resources: {
      series: [makeSeriesBase()],
      drawings: [{ id: 'dw-1', base: null, items: [] }],
      trainingMeta: [],
      accounts: [],
      trades: [],
      contexts: [],
    },
  }
}

function withAppend(
  file: CompactRecordingFile,
  event: RecordingEvent,
  checkpoint: CompactCheckpoint,
): CompactRecordingFile {
  return {
    ...file,
    events: [...file.events, event],
    checkpoints: [...file.checkpoints, checkpoint],
  }
}

function makeV1File(sessionId: string): RecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 1,
    sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    trainingKey: 'k',
    events: [makeEvent(1), makeEvent(2), makeEvent(3)],
    checkpoints: [],
    gaps: [],
    complete: true,
  }
}

async function saveVia(
  idb: FakeIndexedDb,
  storage: IndexedDbCompactStorage,
  file: CompactRecordingFile,
): Promise<void> {
  await flushStorageOp(idb, () => storage.save(file))
}

async function loadVia(
  idb: FakeIndexedDb,
  storage: IndexedDbCompactStorage,
  id: string,
): Promise<CompactRecordingFile | null> {
  return (await flushStorageOp(idb, () => storage.load(id))) as CompactRecordingFile | null
}

describe('MemoryCompactStorage remove', () => {
  it('删除目标会话并重置本地游标，其他会话原样保留', async () => {
    const storage = new MemoryCompactStorage()
    const target = makeCompactFile('m-del')
    const keep = withAppend(makeCompactFile('m-keep'), makeEvent(2), makeCheckpoint(2))
    await storage.save(target)
    await storage.save(keep)

    await storage.remove('m-del')

    await expect(storage.load('m-del')).resolves.toBeNull()
    await expect(storage.load('m-keep')).resolves.toEqual(keep)
    await expect(storage.list()).resolves.toEqual([
      { sessionId: 'm-keep', trainingKey: 'k-1', createdAt: '2026-01-01T00:00:00.000Z', eventCount: 2 },
    ])
    // 目标的 revision/游标状态整体作废，其他会话游标不受影响
    expect(storage.revisionOf('m-del')).toBeNull()
    expect(storage.storedRecordCount('m-del')).toBe(0)
    expect(storage.revisionOf('m-keep')).toBe(1)
    expect(storage.storedRecordCount('m-keep')).toBe(6)
  })

  it('幂等删除：目标不存在时重复 remove 仍成功', async () => {
    const storage = new MemoryCompactStorage()
    await storage.save(makeCompactFile('m-idem'))
    await storage.remove('m-idem')
    await expect(storage.remove('m-idem')).resolves.toBeUndefined()
    await expect(storage.remove('never-saved')).resolves.toBeUndefined()
    await expect(storage.list()).resolves.toEqual([])
  })

  it('remove 与 save 同队列串行：在途批次不会在删除后复活目标会话', async () => {
    const storage = new MemoryCompactStorage()
    const base = makeCompactFile('m-race')
    await storage.save(base)

    const saving = storage.save(withAppend(base, makeEvent(2), makeCheckpoint(2)))
    const removing = storage.remove('m-race')
    await Promise.all([saving, removing])

    await expect(storage.load('m-race')).resolves.toBeNull()
    expect(storage.revisionOf('m-race')).toBeNull()
    expect(storage.storedRecordCount('m-race')).toBe(0)
    await expect(storage.list()).resolves.toEqual([])
  })

  it('failWith 注入的持久化故障同样作用于 remove：拒绝且目标保留，恢复后删除成功', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('m-fail')
    await storage.save(file)

    storage.failWith(new Error('注入持久化故障'))
    await expect(storage.remove('m-fail')).rejects.toThrow('注入持久化故障')
    await expect(storage.load('m-fail')).resolves.toEqual(file)
    expect(storage.revisionOf('m-fail')).toBe(1)

    storage.failWith(null)
    await storage.remove('m-fail')
    await expect(storage.load('m-fail')).resolves.toBeNull()
    expect(storage.revisionOf('m-fail')).toBeNull()
  })

  it('删除后同 id 再保存按全新会话处理（revision 从 1 重新开始）', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('m-reuse')
    await storage.save(file)
    await storage.remove('m-reuse')

    await storage.save(file)
    expect(storage.revisionOf('m-reuse')).toBe(1)
    expect(storage.storedRecordCount('m-reuse')).toBe(4)
    await expect(storage.load('m-reuse')).resolves.toEqual(file)
  })
})

// ---- 带 delete 的最小 IndexedDB stub：沿用 compact-idb 的手动驱动事务模式 ----

interface FakeStoreLike {
  name: string
  keyPath: string | string[]
  entries: Map<string, { key: unknown; value: unknown }>
}

function keyValueOf(keyPath: string | string[], value: unknown): unknown {
  const record = value as Record<string, unknown>
  if (typeof keyPath === 'string') return record[keyPath]
  return keyPath.map(part => record[part])
}

function storeKeyOf(key: unknown): string {
  return Array.isArray(key) ? key.map(part => String(part)).join('\u0000') : String(key)
}

function keyInRange(key: unknown, range: FakeKeyRange): boolean {
  const normalized = storeKeyOf(key)
  const lower = storeKeyOf(range.lower)
  const upper = storeKeyOf(range.upper)
  if (range.lowerOpen ? normalized <= lower : normalized < lower) return false
  if (range.upperOpen ? normalized >= upper : normalized > upper) return false
  return true
}

class DeletingTransaction extends FakeTransaction {
  private readonly pendingRequests: FakeRequest[] = []
  private readonly bufferedWrites: Array<{ store: FakeStoreLike; key: unknown; value: unknown }> = []
  private readonly bufferedDeletes: Array<{ store: FakeStoreLike; key: unknown }> = []

  constructor(
    private readonly stores: Map<string, FakeStoreLike>,
    private readonly putCalls: Array<{ store: string; key: string }>,
    private readonly deleteCalls: Array<{ store: string; key: string }>,
  ) {
    super(new Map(), [])
  }

  objectStore(name: string) {
    const store = this.stores.get(name)
    if (!store) throw new Error(`测试 stub 中不存在 store：${name}`)
    return {
      put: (value: unknown) => {
        this.bufferedWrites.push({ store, key: keyValueOf(store.keyPath, value), value })
      },
      get: (key: unknown) => {
        const request = new FakeRequest()
        request.result = store.entries.get(storeKeyOf(key))?.value
        this.pendingRequests.push(request)
        return request
      },
      getAll: (range?: FakeKeyRange) => {
        const request = new FakeRequest()
        const matched = [...store.entries.values()]
          .filter(row => (range ? keyInRange(row.key, range) : true))
          .sort((a, b) => (storeKeyOf(a.key) < storeKeyOf(b.key) ? -1 : 1))
        request.result = matched.map(row => row.value)
        this.pendingRequests.push(request)
        return request
      },
      delete: (key: unknown) => {
        const request = new FakeRequest()
        this.pendingRequests.push(request)
        this.bufferedDeletes.push({ store, key })
        return request
      },
    }
  }

  firePendingRequests(): void {
    for (let i = 0; i < this.pendingRequests.length; i++) this.pendingRequests[i]!.onsuccess?.()
  }

  applyWrites(): void {
    for (const { store, key, value } of this.bufferedWrites) {
      store.entries.set(storeKeyOf(key), { key, value })
      this.putCalls.push({ store: store.name, key: storeKeyOf(key) })
    }
    for (const { store, key } of this.bufferedDeletes) {
      if (key && typeof key === 'object' && 'lower' in (key as FakeKeyRange)) {
        for (const existing of [...store.entries.keys()]) {
          if (keyInRange(existing, key as FakeKeyRange)) store.entries.delete(existing)
        }
      } else {
        store.entries.delete(storeKeyOf(key))
      }
      this.deleteCalls.push({ store: store.name, key: storeKeyOf(key) })
    }
    this.bufferedWrites.length = 0
    this.bufferedDeletes.length = 0
  }

  discardWrites(): void {
    this.bufferedWrites.length = 0
    this.bufferedDeletes.length = 0
  }

  abort(): void {
    // 真实连接的 abort 由存储层调用；此 stub 的中止语义由 abortTransactions 驱动
  }
}

/** 连接对象：存储 open() 拿到的是 FakeDb，delete 能力须挂在连接的 transaction 上 */
class DeletingConnection extends FakeDb {
  private readonly present: Map<string, FakeStoreLike>

  constructor(private readonly deletingOwner: DeletingIndexedDb) {
    super(deletingOwner)
    this.present = new Map(deletingOwner.sharedStores)
  }

  override createObjectStore(name: string, options: { keyPath: string | string[] }): void {
    if (this.present.has(name)) throw new Error(`store 已存在：${name}`)
    const store: FakeStoreLike = { name, keyPath: options.keyPath, entries: new Map() }
    this.present.set(name, store)
    this.deletingOwner.sharedStores.set(name, store)
  }

  override transaction(_names: string | string[], _mode: string): DeletingTransaction {
    if (this.closed) throw new Error('连接已关闭')
    const tx = new DeletingTransaction(this.present, this.deletingOwner.putCalls, this.deletingOwner.deleteCalls)
    this.deletingOwner.pendingTransactions.push(tx)
    return tx
  }
}

class DeletingIndexedDb extends FakeIndexedDb {
  readonly deleteCalls: Array<{ store: string; key: string }> = []

  override open(): FakeOpenRequest {
    const request = new FakeOpenRequest()
    request.result = new DeletingConnection(this)
    this.openRequests.push(request)
    return request
  }
}

function installDeletingIdbStub(): DeletingIndexedDb {
  const idb = new DeletingIndexedDb()
  ;(globalThis as { indexedDB?: unknown }).indexedDB = idb
  ;(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = {
    bound: (lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false): FakeKeyRange =>
      ({ lower, upper, lowerOpen, upperOpen }),
  }
  return idb
}

interface StoredCompactRow {
  sessionId: string
  kind: string
  index: number
  value: unknown
}

function recordStoreEntries(idb: DeletingIndexedDb): Map<string, { key: unknown; value: unknown }> {
  return idb.sharedStores.get('compactRecords')!.entries
}

function storedRowSessions(idb: DeletingIndexedDb): string[] {
  return [...new Set([...recordStoreEntries(idb).values()].map(entry => (entry.value as StoredCompactRow).sessionId))]
}

describe('IndexedDbCompactStorage remove', () => {
  it('单事务删除目标 compact header+记录行与旧 v1 行，其他会话与旧库原样保留', async () => {
    const idb = installDeletingIdbStub()
    const storage = new IndexedDbCompactStorage()
    const keep = withAppend(makeCompactFile('r-keep'), makeEvent(2), makeCheckpoint(2))
    await saveVia(idb, storage, makeCompactFile('r-del'))
    await saveVia(idb, storage, keep)
    idb.seed('sessions', makeV1File('r-del'))
    idb.seed('sessions', makeV1File('r-legacy-keep'))

    const deleteCallsBefore = idb.deleteCalls.length
    await flushStorageOp(idb, () => storage.remove('r-del'))

    // compact 侧只剩 keep 的 header 与 6 行记录，目标行全部消失
    expect(idb.recordCount('compactSessions')).toBe(1)
    expect(storedRowSessions(idb)).toEqual(['r-keep'])
    expect(recordStoreEntries(idb).size).toBe(6)
    // 旧 v1：目标行删除，无关旧会话保留
    expect(idb.recordCount('sessions')).toBe(1)
    // 删除经由 readwrite 事务发出（可观察的 delete 调用）
    expect(idb.deleteCalls.length).toBeGreaterThan(deleteCallsBefore)

    await expect(loadVia(idb, storage, 'r-del')).resolves.toBeNull()
    await expect(loadVia(idb, storage, 'r-keep')).resolves.toEqual(keep)
    const list = await flushStorageOp(idb, () => storage.list())
    // 目标消失；保留 compact 会话与无关旧 v1 会话
    expect(list.map(summary => summary.sessionId).sort()).toEqual(['r-keep', 'r-legacy-keep'])
  })

  it('幂等删除：目标不存在（或已删除）时 remove 仍成功', async () => {
    const idb = installDeletingIdbStub()
    const storage = new IndexedDbCompactStorage()
    await saveVia(idb, storage, makeCompactFile('r-idem'))

    await flushStorageOp(idb, () => storage.remove('r-idem'))
    await expect(flushStorageOp(idb, () => storage.remove('r-idem'))).resolves.toBeUndefined()
    await expect(flushStorageOp(idb, () => storage.remove('never-saved'))).resolves.toBeUndefined()
    expect(idb.recordCount('compactSessions')).toBe(0)
    expect(recordStoreEntries(idb).size).toBe(0)
  })

  it('删除事务中止时无 partial 状态，重试成功', async () => {
    const idb = installDeletingIdbStub()
    const storage = new IndexedDbCompactStorage()
    const file = makeCompactFile('r-abort')
    await saveVia(idb, storage, file)

    const removing = storage.remove('r-abort')
    await settleMacrotask()
    idb.abortTransactions(new Error('模拟删除中止'))
    await expect(removing).rejects.toThrow('删除录制会话')

    expect(idb.recordCount('compactSessions')).toBe(1)
    expect(recordStoreEntries(idb).size).toBe(4)
    await expect(loadVia(idb, storage, 'r-abort')).resolves.toEqual(file)

    await flushStorageOp(idb, () => storage.remove('r-abort'))
    expect(idb.recordCount('compactSessions')).toBe(0)
    expect(recordStoreEntries(idb).size).toBe(0)
    await expect(loadVia(idb, storage, 'r-abort')).resolves.toBeNull()
  })

  it('remove 排在在途 save 之后执行：先落盘完成再整体删除，已提交批次不复活', async () => {
    const idb = installDeletingIdbStub()
    const storage = new IndexedDbCompactStorage()
    const base = makeCompactFile('r-race')
    await saveVia(idb, storage, base)

    const saving = storage.save(withAppend(base, makeEvent(2), makeCheckpoint(2)))
    await settleMacrotask()
    const removing = storage.remove('r-race')
    await settleMacrotask()
    // remove 串行在 save 之后：此刻只有 save 的一个事务挂起
    expect(idb.pendingTransactions).toHaveLength(1)

    idb.completeTransactions()
    await settleMacrotask()
    idb.completeTransactions()
    await removing
    await saving

    expect(idb.recordCount('compactSessions')).toBe(0)
    expect(recordStoreEntries(idb).size).toBe(0)
    await expect(loadVia(idb, storage, 'r-race')).resolves.toBeNull()
    await expect(flushStorageOp(idb, () => storage.list())).resolves.toEqual([])
  })

  it('删除后重开实例 load 目标返回 null，其他会话完整可读', async () => {
    const idb = installDeletingIdbStub()
    const storage = new IndexedDbCompactStorage()
    const keep = withAppend(makeCompactFile('r-keep'), makeEvent(2), makeCheckpoint(2))
    await saveVia(idb, storage, makeCompactFile('r-del'))
    await saveVia(idb, storage, keep)
    await flushStorageOp(idb, () => storage.remove('r-del'))

    const fresh = new IndexedDbCompactStorage()
    await expect(loadVia(idb, fresh, 'r-del')).resolves.toBeNull()
    await expect(loadVia(idb, fresh, 'r-keep')).resolves.toEqual(keep)
  })

  it('首次操作即 remove：先完成 open/upgrade，再执行删除', async () => {
    const idb = installDeletingIdbStub()
    const storage = new IndexedDbCompactStorage()

    const opensBefore = idb.openRequests.length
    const pending = storage.remove('r-cold')
    await settleMacrotask()
    expect(idb.openRequests.length).toBe(opensBefore + 1)
    await settleOpen(idb)
    idb.completeTransactions()
    await expect(pending).resolves.toBeUndefined()
  })
})
