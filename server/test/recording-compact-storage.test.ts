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
  FakeIndexedDb,
  flushStorageOp,
  installCompactIdbStub,
  restoreCompactIdbStub,
  settleMacrotask,
  settleOpen,
} from './helpers/compact-idb'

// REC-V2-STORAGE：增量持久化测试。手动驱动最小异步 IDB stub（见 helpers/compact-idb.ts），
// 验证真实数据行为：重组深等、只写新增条目、revision 冲突、abort 无 partial、旧 v1 保留。

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

describe('MemoryCompactStorage 增量语义', () => {
  it('首次保存后 load 深等，未保存的会话返回 null', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-mem')
    await storage.save(file)
    await expect(storage.load('s-mem')).resolves.toEqual(file)
    await expect(storage.load('no-such')).resolves.toBeNull()
  })

  it('追加 1 事件 + 1 checkpoint 只增新条目，revision 精确推进', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-mem')
    await storage.save(file)
    expect(storage.storedRecordCount('s-mem')).toBe(4)
    expect(storage.revisionOf('s-mem')).toBe(1)

    const appended = withAppend(file, makeEvent(2), makeCheckpoint(2))
    await storage.save(appended)
    expect(storage.storedRecordCount('s-mem')).toBe(6)
    expect(storage.revisionOf('s-mem')).toBe(2)
    await expect(storage.load('s-mem')).resolves.toEqual(appended)
  })

  it('同 file 再次 save 幂等：revision 与记录数不变', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-mem')
    await storage.save(file)
    await storage.save(file)
    expect(storage.revisionOf('s-mem')).toBe(1)
    expect(storage.storedRecordCount('s-mem')).toBe(4)
  })

  it('已提交前缀被缩短时拒绝保存，状态不受影响', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-mem')
    await storage.save(file)
    const shortened: CompactRecordingFile = { ...file, events: [] }
    await expect(storage.save(shortened)).rejects.toThrow('缩短')
    expect(storage.revisionOf('s-mem')).toBe(1)
    expect(storage.storedRecordCount('s-mem')).toBe(4)
    await expect(storage.load('s-mem')).resolves.toEqual(file)
  })

  it('已提交前缀同长不同内容时拒绝保存（不能只比长度）', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-mem')
    await storage.save(file)
    const tamperedEvent: RecordingEvent = { ...file.events[0]!, elapsedMs: 999 }
    const tampered: CompactRecordingFile = { ...file, events: [tamperedEvent] }
    await expect(storage.save(tampered)).rejects.toThrow('不一致')
    expect(storage.revisionOf('s-mem')).toBe(1)
    expect(storage.storedRecordCount('s-mem')).toBe(4)
  })

  it('failWith 注入失败时不推进游标，重试完整成功', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-mem')
    await storage.save(file)
    const appended = withAppend(file, makeEvent(2), makeCheckpoint(2))

    storage.failWith(new Error('注入保存故障'))
    await expect(storage.save(appended)).rejects.toThrow('注入保存故障')
    expect(storage.revisionOf('s-mem')).toBe(1)
    expect(storage.storedRecordCount('s-mem')).toBe(4)

    storage.failWith(null)
    await storage.save(appended)
    expect(storage.revisionOf('s-mem')).toBe(2)
    expect(storage.storedRecordCount('s-mem')).toBe(6)
    await expect(storage.load('s-mem')).resolves.toEqual(appended)
  })

  it('save 后就地更新 gaps/app 不改已持久镜像，下次 save 才作为 header 批次提交', async () => {
    const storage = new MemoryCompactStorage()
    const file = makeCompactFile('s-snap')
    file.gaps.push({ afterSeq: 1, resumedAtSeq: null })
    await storage.save(file)
    const savedView = await storage.load('s-snap')

    // 原地更新但未 save：持久镜像必须保持保存瞬间状态（与生产 IDB put 结构化克隆语义一致）
    file.gaps[0]!.resumedAtSeq = 5
    file.app.version = 'mutated'
    await expect(storage.load('s-snap')).resolves.toEqual(savedView)

    // 再次 save 才把就地变化作为 header-only 批次写入
    await storage.save(file)
    expect(storage.revisionOf('s-snap')).toBe(2)
    const committed = await storage.load('s-snap')
    expect(committed!.gaps).toEqual([{ afterSeq: 1, resumedAtSeq: 5 }])
    expect(committed!.app.version).toBe('mutated')
  })

  it('list 返回按 createdAt 排序的摘要', async () => {
    const storage = new MemoryCompactStorage()
    const later = { ...makeCompactFile('b'), createdAt: '2026-01-02T00:00:00.000Z' }
    await storage.save(later)
    await storage.save(makeCompactFile('a'))
    await expect(storage.list()).resolves.toEqual([
      { sessionId: 'a', trainingKey: 'k-1', createdAt: '2026-01-01T00:00:00.000Z', eventCount: 1 },
      { sessionId: 'b', trainingKey: 'k-1', createdAt: '2026-01-02T00:00:00.000Z', eventCount: 1 },
    ])
  })
})

describe('IndexedDbCompactStorage 连接生命周期', () => {
  it('初次 open 失败后不缓存 rejected promise，下一次操作重新 open 并成功', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()

    const first = storage.list()
    await settleMacrotask()
    expect(idb.openRequests).toHaveLength(1)
    const failed = idb.lastRequest()
    failed.error = new Error('QuotaExceededError')
    failed.onerror?.()
    await expect(first).rejects.toThrow('打开录制会话数据库失败：QuotaExceededError')

    idb.seed('sessions', makeV1File('s-1'))
    const summaries = await flushStorageOp(idb, () => storage.list())
    expect(summaries).toEqual([
      { sessionId: 's-1', trainingKey: 'k', createdAt: '2026-01-01T00:00:00.000Z', eventCount: 3 },
    ])
  })

  it('onblocked 定案拒绝后，迟到的 onsuccess 关闭失效连接，后续操作重新 open', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()

    const first = storage.loadLegacy('any')
    await settleMacrotask()
    const request = idb.lastRequest()
    request.onblocked?.()
    await expect(first).rejects.toThrow('被其他标签页占用')

    request.onsuccess?.()
    expect(request.result?.closed).toBe(true)

    const second = await flushStorageOp(idb, () => storage.loadLegacy('any'))
    expect(idb.openRequests).toHaveLength(2)
  })

  it('close() 关闭当前连接并重置缓存，后续操作重新 open', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    await flushStorageOp(idb, () => storage.list())
    expect(idb.openRequests).toHaveLength(1)

    const db = idb.openRequests[0]!.result!
    storage.close()
    await settleMacrotask()
    expect(db.closed).toBe(true)

    await flushStorageOp(idb, () => storage.list())
    expect(idb.openRequests).toHaveLength(2)
  })

  it('versionchange 关闭连接并清空缓存，后续操作重新 open', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    await flushStorageOp(idb, () => storage.list())

    const db = idb.openRequests[0]!.result!
    db.onversionchange?.()
    expect(db.closed).toBe(true)

    await flushStorageOp(idb, () => storage.list())
    expect(idb.openRequests).toHaveLength(2)
  })

  it('save 仅在事务 complete 后 resolve，complete 前不产生写入', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()

    let settled = false
    const saving = storage.save(makeCompactFile('s-tx')).then(() => {
      settled = true
    })
    await settleMacrotask()
    await settleOpen(idb)
    expect(idb.pendingTransactions).toHaveLength(1)
    expect(settled).toBe(false)
    expect(idb.putCalls).toHaveLength(0)

    idb.completeTransactions()
    await saving
    expect(settled).toBe(true)
    expect(idb.putCalls).toHaveLength(5)
  })
})

describe('IndexedDbCompactStorage 增量与冲突', () => {
  it('初次 save 只 put 新条目与 header，load 重组出深等紧凑文件', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    const file = makeCompactFile('s-inc')
    await saveVia(idb, storage, file)

    // 1事件+1checkpoint+1行情版本+1画线版本 = 4 行记录 + 1 header
    expect(idb.putCalls).toHaveLength(5)
    expect(idb.putCalls.filter(p => p.store === 'compactRecords')).toHaveLength(4)
    expect(idb.putCalls.filter(p => p.store === 'compactSessions')).toHaveLength(1)

    await expect(loadVia(idb, storage, 's-inc')).resolves.toEqual(file)
    await expect(loadVia(idb, storage, 'missing')).resolves.toBeNull()
  })

  it('追加 1 事件 + 1 checkpoint 只 put 新增条目与 header，旧条目不重复写', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    const file = makeCompactFile('s-inc')
    await saveVia(idb, storage, file)

    const putsBefore = idb.putCalls.length
    const appended = withAppend(file, makeEvent(2), makeCheckpoint(2))
    await saveVia(idb, storage, appended)
    expect(idb.putCalls.length - putsBefore).toBe(3)

    expect(idb.putCalls.filter(p => p.key === 's-inc\u0000event\u00000')).toHaveLength(1)
    expect(idb.putCalls.filter(p => p.key === 's-inc\u0000checkpoint\u00000')).toHaveLength(1)
    expect(idb.putCalls.filter(p => p.key === 's-inc\u0000series\u00000')).toHaveLength(1)
    expect(idb.putCalls.filter(p => p.key === 's-inc\u0000drawings\u00000')).toHaveLength(1)

    await expect(loadVia(idb, storage, 's-inc')).resolves.toEqual(appended)
  })

  it('load 后原样再次 save 幂等：不产生写入，持久内容不变', async () => {
    const idb = installCompactIdbStub()
    const first = new IndexedDbCompactStorage()
    const file = makeCompactFile('s-noop')
    await saveVia(idb, first, file)

    const second = new IndexedDbCompactStorage()
    const loaded = await loadVia(idb, second, 's-noop')
    const putsBefore = idb.putCalls.length
    await saveVia(idb, second, loaded!)
    expect(idb.putCalls.length).toBe(putsBefore)

    const third = new IndexedDbCompactStorage()
    await expect(loadVia(idb, third, 's-noop')).resolves.toEqual(file)
  })

  it('中途事务 abort 无 partial 状态，重试重新提交完整批次', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    const file = makeCompactFile('s-abort')

    const first = storage.save(file)
    await settleMacrotask()
    await settleOpen(idb)
    idb.abortTransactions(new Error('模拟事务中止'))
    await expect(first).rejects.toThrow('保存录制会话被中止')

    expect(idb.recordCount('compactSessions')).toBe(0)
    expect(idb.recordCount('compactRecords')).toBe(0)
    expect(idb.putCalls).toHaveLength(0)

    const putsBefore = idb.putCalls.length
    const second = storage.save(file)
    await flushStorageOp(idb, () => second)
    // 游标未提前推进：重试重新写全部 4 行 + header
    expect(idb.putCalls.length - putsBefore).toBe(5)
    await expect(loadVia(idb, storage, 's-abort')).resolves.toEqual(file)
  })

  it('本实例未 load 时对已存在会话 save 直接拒绝，不产生写入', async () => {
    const idb = installCompactIdbStub()
    const first = new IndexedDbCompactStorage()
    await saveVia(idb, first, makeCompactFile('s-own'))

    const putsBefore = idb.putCalls.length
    const second = new IndexedDbCompactStorage()
    await expect(saveVia(idb, second, makeCompactFile('s-own'))).rejects.toThrow('尚未 load')
    expect(idb.putCalls.length).toBe(putsBefore)
  })

  it('双实例同 revision 等长不同内容冲突拒绝；完全相同批次采纳为 no-op', async () => {
    const idb = installCompactIdbStub()
    const a = new IndexedDbCompactStorage()
    const base = makeCompactFile('s-fork')
    await saveVia(idb, a, base)

    const b = new IndexedDbCompactStorage()
    await loadVia(idb, b, 's-fork')
    const c = new IndexedDbCompactStorage()
    const loadedC = await loadVia(idb, c, 's-fork')

    const appendedA = withAppend(base, makeEvent(2, 'a'), makeCheckpoint(2, 'a'))
    await saveVia(idb, a, appendedA)

    const appendedB = withAppend(base, makeEvent(2, 'b'), makeCheckpoint(2, 'b'))
    await expect(saveVia(idb, b, appendedB)).rejects.toThrow('已被其他实例推进')

    // C 的条目来自自身 load 克隆，内容与 A 完全相同：识别为同一成功批次，不写即采纳
    const putsBefore = idb.putCalls.length
    const appendedSame = withAppend(loadedC!, makeEvent(2, 'a'), makeCheckpoint(2, 'a'))
    await saveVia(idb, c, appendedSame)
    expect(idb.putCalls.length).toBe(putsBefore)

    await expect(loadVia(idb, b, 's-fork')).resolves.toEqual(appendedA)
  })

  it('旧 v1 会话保留：list 同 id 优先 v2，loadLegacy 返回原始值', async () => {
    const idb = installCompactIdbStub()
    const v1Mix = makeV1File('mix')
    const v1Only = makeV1File('v1-only')
    v1Only.createdAt = '2026-02-01T00:00:00.000Z'
    idb.seed('sessions', v1Mix)
    idb.seed('sessions', v1Only)

    const storage = new IndexedDbCompactStorage()
    await saveVia(idb, storage, makeCompactFile('mix'))

    const listPending = storage.list()
    await flushStorageOp(idb, () => listPending)
    await expect(listPending).resolves.toEqual([
      { sessionId: 'mix', trainingKey: 'k-1', createdAt: '2026-01-01T00:00:00.000Z', eventCount: 1 },
      { sessionId: 'v1-only', trainingKey: 'k', createdAt: '2026-02-01T00:00:00.000Z', eventCount: 3 },
    ])

    const legacyPending = storage.loadLegacy('mix')
    await flushStorageOp(idb, () => legacyPending)
    await expect(legacyPending).resolves.toEqual(v1Mix)

    await expect(loadVia(idb, storage, 'mix')).resolves.toEqual(makeCompactFile('mix'))
    // 旧库未被删除或改写
    expect(idb.recordCount('sessions')).toBe(2)
  })
})

describe('header 批次身份与采纳核实', () => {
  /** 双实例同 revision load 后仅改 header 某一字段分叉：先写者落盘，后写者必须拒绝且 0 写入 */
  async function expectHeaderForkRejected(
    sessionId: string,
    mutate: (file: CompactRecordingFile, tag: string) => CompactRecordingFile,
  ): Promise<void> {
    const idb = installCompactIdbStub()
    const a = new IndexedDbCompactStorage()
    const base = makeCompactFile(sessionId)
    await saveVia(idb, a, base)
    const b = new IndexedDbCompactStorage()
    const loadedB = (await loadVia(idb, b, sessionId))!
    const c = new IndexedDbCompactStorage()
    const loadedC = (await loadVia(idb, c, sessionId))!

    await saveVia(idb, b, mutate(loadedB, 'left'))

    const putsBefore = idb.putCalls.length
    await expect(saveVia(idb, c, mutate(loadedC, 'right'))).rejects.toThrow(
      /已被其他实例推进|批次不一致/,
    )
    expect(idb.putCalls.length).toBe(putsBefore)

    // 磁盘保留先写者，后写者的分叉内容未落盘
    const fresh = new IndexedDbCompactStorage()
    await expect(loadVia(idb, fresh, sessionId)).resolves.toEqual(mutate(loadedB, 'left'))
  }

  it('仅 app 版本分叉（空记录批次）：后写者拒绝，磁盘保留先写者', async () => {
    await expectHeaderForkRejected('s-fork-app', (file, tag) => ({
      ...file,
      app: { ...file.app, version: tag },
    }))
  })

  it('仅 environment 分叉（空记录批次）：后写者拒绝，磁盘保留先写者', async () => {
    await expectHeaderForkRejected('s-fork-env', (file, tag) => ({
      ...file,
      environment: { ...file.environment, dpr: tag === 'left' ? 2 : 3 },
    }))
  })

  it('仅 createdAt 分叉（空记录批次）：后写者拒绝，磁盘保留先写者', async () => {
    await expectHeaderForkRejected('s-fork-created', (file, tag) => ({
      ...file,
      createdAt: tag === 'left' ? '2026-03-01T00:00:00.000Z' : '2026-04-01T00:00:00.000Z',
    }))
  })

  it('相同 header-only 批次（空记录行）另一实例重试：采纳成功、0 写入', async () => {
    const idb = installCompactIdbStub()
    const a = new IndexedDbCompactStorage()
    const base = makeCompactFile('s-hdr-adopt')
    await saveVia(idb, a, base)
    const b = new IndexedDbCompactStorage()
    const loadedB = (await loadVia(idb, b, 's-hdr-adopt'))!

    const changed = { ...loadedB, app: { ...loadedB.app, version: 'left' } }
    await saveVia(idb, a, changed)

    const putsBefore = idb.putCalls.length
    await saveVia(idb, b, changed)
    expect(idb.putCalls.length).toBe(putsBefore)

    const fresh = new IndexedDbCompactStorage()
    await expect(loadVia(idb, fresh, 's-hdr-adopt')).resolves.toEqual(changed)
  })
})

interface StoredCompactRow {
  sessionId: string
  kind: string
  index: number
  value: unknown
}

function recordStoreEntries(idb: FakeIndexedDb): Map<string, { key: unknown; value: unknown }> {
  return idb.sharedStores.get('compactRecords')!.entries
}

function storedRowKey(sessionId: string, kind: string, index: number): string {
  return [sessionId, kind, index].join('\u0000')
}

function findStoredRow(
  idb: FakeIndexedDb,
  sessionId: string,
  kind: string,
  index: number,
): StoredCompactRow | null {
  for (const entry of recordStoreEntries(idb).values()) {
    const row = entry.value as StoredCompactRow
    if (row.sessionId === sessionId && row.kind === kind && row.index === index) return row
  }
  return null
}

/** 直接改写持久行，模拟磁盘上的存储损坏 */
function deleteStoredRow(idb: FakeIndexedDb, sessionId: string, kind: string, index: number): void {
  expect(findStoredRow(idb, sessionId, kind, index)).not.toBeNull()
  recordStoreEntries(idb).delete(storedRowKey(sessionId, kind, index))
}

function reindexStoredRow(
  idb: FakeIndexedDb,
  sessionId: string,
  kind: string,
  from: number,
  to: number,
): void {
  const row = findStoredRow(idb, sessionId, kind, from)!
  row.index = to
  recordStoreEntries(idb).delete(storedRowKey(sessionId, kind, from))
  recordStoreEntries(idb).set(storedRowKey(sessionId, kind, to), {
    key: [sessionId, kind, to],
    value: row,
  })
}

function addStoredRow(
  idb: FakeIndexedDb,
  sessionId: string,
  kind: string,
  index: number,
  value: unknown,
): void {
  recordStoreEntries(idb).set(storedRowKey(sessionId, kind, index), {
    key: [sessionId, kind, index],
    value: { sessionId, kind, index, value },
  })
}

function storedHeader(idb: FakeIndexedDb, sessionId: string): { counts: Record<string, number> } {
  return idb.sharedStores.get('compactSessions')!.entries.get(sessionId)!.value as {
    counts: Record<string, number>
  }
}

describe('load 损坏检测', () => {
  it('记录行缺失时 load 明确拒绝，不静默返回部分录制', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    const file = withAppend(makeCompactFile('s-corrupt'), makeEvent(2), makeCheckpoint(2))
    await saveVia(idb, storage, file)

    deleteStoredRow(idb, 's-corrupt', 'event', 1)
    await expect(loadVia(idb, storage, 's-corrupt')).rejects.toThrow('损坏')
  })

  it('header counts 与实际行数不一致（counts 偏大）时 load 拒绝', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    await saveVia(idb, storage, makeCompactFile('s-corrupt'))

    storedHeader(idb, 's-corrupt').counts.events = 2
    await expect(loadVia(idb, storage, 's-corrupt')).rejects.toThrow('损坏')
  })

  it('行下标不连续（0 与 2 缺 1）时 load 拒绝', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    const file = withAppend(makeCompactFile('s-corrupt'), makeEvent(2), makeCheckpoint(2))
    await saveVia(idb, storage, file)

    reindexStoredRow(idb, 's-corrupt', 'event', 1, 2)
    await expect(loadVia(idb, storage, 's-corrupt')).rejects.toThrow('损坏')
  })

  it('超出 counts 的多余行时 load 拒绝', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    await saveVia(idb, storage, makeCompactFile('s-corrupt'))

    addStoredRow(idb, 's-corrupt', 'event', 1, makeEvent(2))
    await expect(loadVia(idb, storage, 's-corrupt')).rejects.toThrow('损坏')
  })

  it('未知 kind 行时 load 拒绝', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    await saveVia(idb, storage, makeCompactFile('s-corrupt'))

    addStoredRow(idb, 's-corrupt', 'bogus', 0, { id: 'x' })
    await expect(loadVia(idb, storage, 's-corrupt')).rejects.toThrow('损坏')
  })

  it('行条目缺少合法 id/opId 时 load 拒绝', async () => {
    const idb = installCompactIdbStub()
    const storage = new IndexedDbCompactStorage()
    await saveVia(idb, storage, makeCompactFile('s-corrupt'))

    const row = findStoredRow(idb, 's-corrupt', 'event', 0)!
    row.value = { ...(row.value as Record<string, unknown>), opId: '' }
    await expect(loadVia(idb, storage, 's-corrupt')).rejects.toThrow('损坏')
  })
})
