// REC-01 v2紧凑存储测试专用：最小异步 IndexedDB stub（不依赖浏览器与新增依赖）。
// 只实现 compactStorage 用到的表面：open/upgrade、事务 put/get/getAll、IDBKeyRange.bound；
// 写入先缓冲，completeTransactions 才应用、abortTransactions 丢弃，模拟事务原子提交；
// onupgradeneeded/onsuccess/onerror/onblocked 由测试手动触发，驱动方式与 recording-storage.test.ts 一致。

export interface FakeKeyRange {
  lower: unknown
  upper: unknown
  lowerOpen: boolean
  upperOpen: boolean
}

interface FakeStore {
  name: string
  keyPath: string | string[]
  entries: Map<string, { key: unknown; value: unknown }>
}

export class FakeRequest<T = unknown> {
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  result: T | undefined
  error: Error | null = null
}

export class FakeOpenRequest {
  onupgradeneeded: (() => void) | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onblocked: (() => void) | null = null
  error: Error | null = null
  result: FakeDb | null = null
}

export class FakeTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: Error | null = null
  private readonly pendingRequests: FakeRequest[] = []
  private readonly bufferedWrites: Array<{ store: FakeStore; row: { key: unknown; value: unknown } }> = []

  constructor(
    private readonly presentStores: Map<string, FakeStore>,
    private readonly putCalls: Array<{ store: string; key: string }>,
  ) {}

  objectStore(name: string) {
    const store = this.presentStores.get(name)
    if (!store) throw new Error(`测试 stub 中不存在 store：${name}`)
    return {
      put: (value: unknown) => {
        const key = keyValueOf(store.keyPath, value)
        this.bufferedWrites.push({ store, row: { key, value } })
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
          .sort((a, b) => compareKeys(storeKeyOf(a.key), storeKeyOf(b.key)))
        request.result = matched.map(row => row.value)
        this.pendingRequests.push(request)
        return request
      },
    }
  }

  /** 依序触发挂起的请求回调；get 的 onsuccess 里可能再发起新请求，故按下标推进 */
  firePendingRequests(): void {
    for (let i = 0; i < this.pendingRequests.length; i++) this.pendingRequests[i]!.onsuccess?.()
  }

  /** 只统计真正提交（applyWrites）的写入，abort 的缓冲写入不计入 */
  applyWrites(): void {
    for (const { store, row } of this.bufferedWrites) {
      store.entries.set(storeKeyOf(row.key), row)
      this.putCalls.push({ store: store.name, key: storeKeyOf(row.key) })
    }
    this.bufferedWrites.length = 0
  }

  discardWrites(): void {
    this.bufferedWrites.length = 0
  }

  abort(): void {
    // 真实连接的 abort 由存储层调用；此 stub 的中止语义由 abortTransactions 驱动
  }
}

export class FakeDb {
  onversionchange: (() => void) | null = null
  closed = false
  private readonly presentStores: Map<string, FakeStore>
  readonly objectStoreNames: { contains(name: string): boolean }

  constructor(private readonly owner: FakeIndexedDb) {
    // 每个连接可见 sharedStores 的浅快照（entries 共享）；upgrade 建库时同步登记回 shared
    this.presentStores = new Map(owner.sharedStores)
    this.objectStoreNames = { contains: name => this.presentStores.has(name) }
  }

  createObjectStore(name: string, options: { keyPath: string | string[] }): void {
    if (this.presentStores.has(name)) throw new Error(`store 已存在：${name}`)
    const store: FakeStore = { name, keyPath: options.keyPath, entries: new Map() }
    this.presentStores.set(name, store)
    this.owner.sharedStores.set(name, store)
  }

  close(): void {
    this.closed = true
  }

  transaction(_names: string | string[], _mode: string): FakeTransaction {
    if (this.closed) throw new Error('连接已关闭')
    const tx = new FakeTransaction(this.presentStores, this.owner.putCalls)
    this.owner.pendingTransactions.push(tx)
    return tx
  }
}

export class FakeIndexedDb {
  /** v1 世界：sessions store 先于 v2 存在；compact store 由 upgrade 建出 */
  readonly sharedStores = new Map<string, FakeStore>([
    ['sessions', { name: 'sessions', keyPath: 'sessionId', entries: new Map() }],
  ])
  readonly openRequests: FakeOpenRequest[] = []
  readonly pendingTransactions: FakeTransaction[] = []
  readonly putCalls: Array<{ store: string; key: string }> = []

  open(_name: string, _version?: number): FakeOpenRequest {
    const request = new FakeOpenRequest()
    request.result = new FakeDb(this)
    this.openRequests.push(request)
    return request
  }

  lastRequest(): FakeOpenRequest {
    return this.openRequests.at(-1)!
  }

  seed(storeName: string, value: unknown): void {
    const store = this.sharedStores.get(storeName)
    if (!store) throw new Error(`stub 未创建 store：${storeName}`)
    const key = keyValueOf(store.keyPath, value)
    store.entries.set(storeKeyOf(key), { key, value })
  }

  recordCount(storeName: string): number {
    return this.sharedStores.get(storeName)?.entries.size ?? 0
  }

  completeTransactions(): void {
    for (const tx of this.pendingTransactions.splice(0)) {
      tx.firePendingRequests()
      tx.applyWrites()
      tx.oncomplete?.()
    }
  }

  /** 显式 abort 语义：只触发 onabort，缓冲写入全部丢弃 */
  abortTransactions(error: Error): void {
    for (const tx of this.pendingTransactions.splice(0)) {
      tx.firePendingRequests()
      tx.discardWrites()
      tx.error = error
      tx.onabort?.()
    }
  }
}

const globalScope = globalThis as { indexedDB?: unknown; IDBKeyRange?: unknown }

/** 安装全局 indexedDB 与 IDBKeyRange stub，返回 FakeIndexedDb 供测试驱动 */
export function installCompactIdbStub(): FakeIndexedDb {
  const idb = new FakeIndexedDb()
  globalScope.indexedDB = idb
  globalScope.IDBKeyRange = {
    bound: (lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false): FakeKeyRange =>
      ({ lower, upper, lowerOpen, upperOpen }),
  }
  return idb
}

export function restoreCompactIdbStub(originals: { indexedDB: unknown; IDBKeyRange: unknown }): void {
  globalScope.indexedDB = originals.indexedDB
  globalScope.IDBKeyRange = originals.IDBKeyRange
}

export async function settleMacrotask(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 触发最近一次 open 的 upgrade + success，返回连接 */
export async function settleOpen(idb: FakeIndexedDb): Promise<FakeDb> {
  const request = idb.lastRequest()
  request.onupgradeneeded?.()
  request.onsuccess?.()
  await settleMacrotask()
  return request.result!
}

/** 驱动一次存储操作到事务 complete：open（仅当本次真正发起）→ upgrade/success → 事务请求与写入 → complete。
 * start 为 thunk：open 请求可能在调用内同步创建，须先记录基线再执行。 */
export async function flushStorageOp(
  idb: FakeIndexedDb,
  start: () => Promise<unknown>,
): Promise<unknown> {
  const opensBefore = idb.openRequests.length
  const pending = start()
  await settleMacrotask()
  if (idb.openRequests.length > opensBefore) await settleOpen(idb)
  idb.completeTransactions()
  return await pending
}

function keyValueOf(keyPath: string | string[], value: unknown): unknown {
  const record = value as Record<string, unknown>
  if (typeof keyPath === 'string') return record[keyPath]
  return keyPath.map(part => record[part])
}

function storeKeyOf(key: unknown): string {
  return Array.isArray(key) ? key.map(part => String(part)).join('\u0000') : String(key)
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function keyInRange(key: unknown, range: FakeKeyRange): boolean {
  const normalized = storeKeyOf(key)
  const lower = storeKeyOf(range.lower)
  const upper = storeKeyOf(range.upper)
  if (range.lowerOpen ? normalized <= lower : normalized < lower) return false
  if (range.upperOpen ? normalized >= upper : normalized > upper) return false
  return true
}
