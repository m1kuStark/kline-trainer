import { afterEach, describe, expect, it } from 'vitest'
import { Recorder } from '../../web/src/recording/recorder'
import {
  IndexedDbRecordingStorage,
  MemoryRecordingStorage,
  RECORDING_STORE_NAME,
} from '../../web/src/recording/storage'
import type { RecordingFile, RecordingStorage, RecorderStatus } from '../../web/src/recording/types'

// REC-HARDEN-1：IndexedDbRecordingStorage 连接生命周期用最小异步事件 stub 驱动，
// 手动触发 onsuccess/onerror/onblocked/事务 complete，不依赖浏览器与新增依赖。

class FakeOpenRequest {
  onupgradeneeded: (() => void) | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onblocked: (() => void) | null = null
  error: Error | null = null
  result: FakeDb | null = null
}

class FakeTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: Error | null = null
  constructor(private readonly data: Map<string, RecordingFile>) {}

  objectStore(_name: string) {
    return {
      put: (file: RecordingFile) => {
        this.data.set(file.sessionId, file)
      },
      get: (id: string) => ({ result: this.data.get(id) }),
      getAll: () => ({ result: [...this.data.values()] }),
    }
  }
}

class FakeDb {
  onversionchange: (() => void) | null = null
  closed = false
  readonly objectStoreNames = { contains: (name: string) => name === RECORDING_STORE_NAME }

  constructor(
    private readonly data: Map<string, RecordingFile>,
    private readonly pending: FakeTransaction[],
  ) {}

  close(): void {
    this.closed = true
  }

  transaction(_name: string, _mode: string): FakeTransaction {
    const tx = new FakeTransaction(this.data)
    this.pending.push(tx)
    return tx
  }
}

class FakeIndexedDb {
  readonly data = new Map<string, RecordingFile>()
  readonly openRequests: FakeOpenRequest[] = []
  readonly pendingTransactions: FakeTransaction[] = []

  open(_name: string, _version?: number): FakeOpenRequest {
    const request = new FakeOpenRequest()
    request.result = new FakeDb(this.data, this.pendingTransactions)
    this.openRequests.push(request)
    return request
  }

  lastRequest(): FakeOpenRequest {
    return this.openRequests.at(-1)!
  }

  completeTransactions(): void {
    for (const tx of this.pendingTransactions.splice(0)) tx.oncomplete?.()
  }
}

const globalScope = globalThis as { indexedDB?: unknown }
const originalIndexedDb = globalScope.indexedDB
let stub: FakeIndexedDb

function installStub(): FakeIndexedDb {
  stub = new FakeIndexedDb()
  globalScope.indexedDB = stub
  return stub
}

afterEach(() => {
  globalScope.indexedDB = originalIndexedDb
})

function settleMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 触发最近一次 open 的 onsuccess，等事务产生后统一 complete，返回该连接 */
async function succeedOpen(idb: FakeIndexedDb): Promise<FakeDb> {
  const request = idb.lastRequest()
  request.onsuccess?.()
  await settleMacrotask()
  idb.completeTransactions()
  return request.result!
}

function makeFile(sessionId: string): RecordingFile {
  return {
    format: 'trainer-session',
    schemaVersion: 1,
    sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    trainingKey: 'k',
    events: [],
    checkpoints: [],
    gaps: [],
    complete: true,
  }
}

function makeRecorder(
  storage: RecordingStorage,
): { recorder: Recorder; statuses: RecorderStatus[] } {
  const statuses: RecorderStatus[] = []
  const recorder = new Recorder(storage, {
    app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: true, chartLibrary: 'klinecharts' },
    environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
    onChange: status => statuses.push(status),
  })
  return { recorder, statuses }
}

describe('IndexedDbRecordingStorage 连接生命周期', () => {
  it('初次 open 失败后不缓存 rejected promise，下一次 list 重新 open 并成功', async () => {
    const idb = installStub()
    const storage = new IndexedDbRecordingStorage()

    const first = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(1)
    const failed = idb.lastRequest()
    failed.error = new Error('QuotaExceededError')
    failed.onerror?.()
    await expect(first).rejects.toThrow('打开录制会话数据库失败：QuotaExceededError')

    idb.data.set('s-1', makeFile('s-1'))
    const second = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(2)
    await succeedOpen(idb)
    await expect(second).resolves.toEqual([
      { sessionId: 's-1', trainingKey: 'k', createdAt: '2026-01-01T00:00:00.000Z', eventCount: 0 },
    ])
  })

  it('close() 关闭当前连接并重置缓存，后续 list 重新 open 新连接', async () => {
    const idb = installStub()
    const storage = new IndexedDbRecordingStorage()

    const first = storage.list()
    await settleMacrotask()
    const firstDb = await succeedOpen(idb)
    await first
    expect(idb.openRequests).toHaveLength(1)

    storage.close()
    await settleMacrotask()
    expect(firstDb.closed).toBe(true)

    const second = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(2)
    await succeedOpen(idb)
    await second
  })

  it('versionchange 关闭连接并清空缓存，后续 list 重新 open', async () => {
    const idb = installStub()
    const storage = new IndexedDbRecordingStorage()

    const first = storage.list()
    await settleMacrotask()
    const db = await succeedOpen(idb)
    await first

    db.onversionchange?.()
    expect(db.closed).toBe(true)

    const second = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(2)
    await succeedOpen(idb)
    await second
  })

  it('onblocked 定案拒绝后，迟到的 onsuccess 关闭失效连接，后续 list 重新 open', async () => {
    const idb = installStub()
    const storage = new IndexedDbRecordingStorage()

    const first = storage.list()
    await settleMacrotask()
    const request = idb.lastRequest()
    request.onblocked?.()
    await expect(first).rejects.toThrow('被其他标签页占用')

    request.onsuccess?.()
    expect(request.result?.closed).toBe(true)

    const second = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(2)
    await succeedOpen(idb)
    await second
  })

  it('open 未定案时 close() 仍会关闭连接并重置缓存', async () => {
    const idb = installStub()
    const storage = new IndexedDbRecordingStorage()

    void storage.list()
    await settleMacrotask()
    const firstRequest = idb.lastRequest()
    storage.close()

    const second = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(2)
    firstRequest.onsuccess?.()
    await settleMacrotask()
    expect(firstRequest.result?.closed).toBe(true)
    await succeedOpen(idb)
    await second
  })

  it('save 仅在事务 complete 后 resolve；load 复用同一连接不重新 open', async () => {
    const idb = installStub()
    const storage = new IndexedDbRecordingStorage()

    let saveSettled = false
    const saving = storage.save(makeFile('s-1')).then(() => {
      saveSettled = true
    })
    await settleMacrotask()
    idb.lastRequest().onsuccess?.()
    await settleMacrotask()
    expect(idb.pendingTransactions).toHaveLength(1)
    expect(saveSettled).toBe(false)

    idb.completeTransactions()
    await saving
    expect(saveSettled).toBe(true)

    const loading = storage.load('s-1')
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(1)
    idb.completeTransactions()
    await expect(loading).resolves.toMatchObject({ sessionId: 's-1' })
  })
})

describe('Recorder 未初始化时展示真实失败原因', () => {
  it('restore 不存在的会话后 getStatus 与 onChange 均带真实原因', async () => {
    const { recorder, statuses } = makeRecorder(new MemoryRecordingStorage())
    await expect(recorder.restore('no-such-session')).rejects.toThrow('不存在')
    const status = recorder.getStatus()
    expect(status.state).toBe('error')
    expect(status.error).toContain('no-such-session')
    expect(status.error).toContain('存储中不存在该会话')
    expect(status.error).not.toContain('尚未初始化')
    expect(statuses.at(-1)?.error).toBe(status.error)
  })

  it('restore 读取抛错后 getStatus 与 onChange 带存储原始错误', async () => {
    const storage = new MemoryRecordingStorage()
    storage.loadFailure = new Error('存储读取被拒绝')
    const { recorder, statuses } = makeRecorder(storage)
    await expect(recorder.restore('any')).rejects.toThrow('存储读取被拒绝')
    expect(recorder.getStatus().state).toBe('error')
    expect(recorder.getStatus().error).toContain('存储读取被拒绝')
    expect(statuses.at(-1)?.error).toContain('存储读取被拒绝')
  })

  it('无失败记录时未初始化仍提示尚未初始化', () => {
    const { recorder } = makeRecorder(new MemoryRecordingStorage())
    const status = recorder.getStatus()
    expect(status.state).toBe('error')
    expect(status.error).toContain('尚未初始化')
  })
})
