// REC-FILE-V2：gzip文件封装（web/src/recording/recordingFile.ts）
// 读：magic识别gzip、流式计数解压、fatal UTF-8、v1迁移/v2校验；写：先校验再默认gzip。
// 预算测试通过内部stream helper注入更小阈值，不构造真实大文件。
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  RECORDING_FILE_BUDGETS,
  inflateGzipWithBudget,
  readRecordingFile,
  readRecordingFileWithBudgets,
  writeRecordingFile,
  writeRecordingFileWithBudgets,
} from '../../web/src/recording/recordingFile'
import { CompactBuilder, CompactReader } from '../../web/src/recording/compactCodec'
import { validateRecording } from '../../web/src/recording/validation'
import type { Bar, TrainingSnapshot } from '../../web/src/api'
import type { Drawing } from '../../web/src/drawingState'
import type { ChartCapture, RecordingCheckpoint, RecordingFile } from '../../web/src/recording/types'
import type { CompactRecordingFile } from '../../web/src/recording/compactTypes'

function dateStr(offset: number): string {
  return new Date(Date.UTC(2020, 0, 1 + offset)).toISOString().slice(0, 10)
}

function makeBars(count: number, offset0 = 0, closeBase = 10): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    date: dateStr(offset0 + i),
    open: closeBase,
    high: closeBase + 1,
    low: closeBase - 1,
    close: closeBase + (offset0 + i) * 0.1,
    volume: 1000 + i,
    amount: 10500 + i,
  }))
}

function makeTraining(overrides: Partial<TrainingSnapshot['training']> = {}): TrainingSnapshot {
  return {
    training: {
      id: 7,
      tier: '6M',
      code: '600000',
      name: '浦发银行',
      market: 'SH',
      startDate: '2025-12-01',
      plannedEnd: '2026-06-01',
      currentDate: '2026-03-05',
      status: 'running',
      settleDate: null,
      earlySettle: false,
      blind: false,
      adjustMode: 'forward',
      initialCash: 100000,
      createdAt: '2026-01-01T08:00:00.000Z',
      ...overrides,
    },
    account: {
      cash: 95000,
      shares: 500,
      availableShares: 500,
      costPrice: 10,
      marketValue: 5000,
      equity: 100000,
    },
    trades: [],
  }
}

function makeChart(bars: Bar[], drawings: Drawing[] = [], timeframe: ChartCapture['timeframe'] = '1D'): ChartCapture {
  return {
    timeframe,
    bars,
    drawings,
    view: { fromTimestamp: 1, toTimestamp: 2, barSpace: 8, paneHeights: { candle_pane: 300 } },
    costPrice: null,
  }
}

let checkpointSeq = 0

function makeCheckpoint(
  parts: {
    training?: TrainingSnapshot | null
    chart?: ChartCapture | null
    context?: Record<string, unknown> | null
    afterSeq?: number
    segmentId?: string
  } = {},
): RecordingCheckpoint {
  checkpointSeq += 1
  return {
    id: `cp-${checkpointSeq}`,
    afterSeq: parts.afterSeq ?? 0,
    segmentId: parts.segmentId ?? `seg-${checkpointSeq}`,
    capturedAt: `2026-03-05T10:00:${String(checkpointSeq % 60).padStart(2, '0')}.${String(checkpointSeq).padStart(3, '0')}Z`,
    training: parts.training ?? null,
    chart: parts.chart ?? null,
    ui: { theme: 'dark', tool: null, magnet: 'strong', multiSelect: false },
    context: (parts.context ?? null) as RecordingCheckpoint['context'],
  }
}

const HEADER = {
  format: 'trainer-session' as const,
  sessionId: 'sess-file-1',
  createdAt: '2026-03-05T09:00:00.000Z',
  app: { version: '0.0.0-test', gitCommit: 'test-commit', dirty: false, chartLibrary: 'klinecharts' },
  environment: { timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 }, dpr: 1 },
  trainingKey: '600000|2025-12-01',
  gaps: [{ afterSeq: 2, resumedAtSeq: 3 }],
  complete: false as const,
}

function makeEvents(firstCpId: string, secondCpId: string): RecordingFile['events'] {
  return [
    { seq: 1, opId: 'op-1', segmentId: 'seg-1', elapsedMs: 0, phase: 'started', action: 'training.create', source: 'ui' },
    { seq: 2, opId: 'op-1', segmentId: 'seg-1', elapsedMs: 10, phase: 'finished', action: 'training.create', source: 'ui', outcome: 'accepted', result: { ok: true }, checkpointId: firstCpId },
    { seq: 3, opId: 'op-2', segmentId: 'seg-2', elapsedMs: 20, phase: 'started', action: 'chart.load', source: 'chart' },
    { seq: 4, opId: 'op-2', segmentId: 'seg-2', elapsedMs: 30, phase: 'finished', action: 'chart.load', source: 'chart', outcome: 'accepted', checkpointId: secondCpId },
  ]
}

/** 小型v2紧凑fixture（实际走CompactBuilder产出），含unicode与画线/context */
function buildCompactFile(): { file: CompactRecordingFile; checkpoints: RecordingCheckpoint[] } {
  const builder = new CompactBuilder()
  const drawing: Drawing = {
    id: 'dw-1',
    name: 'segment',
    paneId: 'candle_pane',
    points: [{ timestamp: 1, value: 2 }],
    extendData: { 备注: '浦发银行→沪指⚠️', emoji: '🀄"引"' },
  }
  const cp0 = makeCheckpoint({
    afterSeq: 0,
    segmentId: 'seg-0',
    chart: makeChart(makeBars(4), [drawing]),
    context: { 权息: '10派3（含税）' },
  })
  const cp1 = makeCheckpoint({ afterSeq: 2, segmentId: 'seg-1', training: makeTraining(), chart: makeChart(makeBars(5)) })
  const trade = { seq: 1, date: '2026-03-05', side: 'buy' as const, price: 10, shares: 100, amount: 1000, fee: 1 }
  const cp2 = makeCheckpoint({
    afterSeq: 4,
    segmentId: 'seg-2',
    training: { ...makeTraining(), trades: [trade] },
    context: { 嵌套: [1, 2, { ok: true }] },
  })
  const checkpoints = [cp0, cp1, cp2]
  const file: CompactRecordingFile = {
    ...HEADER,
    schemaVersion: 2,
    events: makeEvents(cp0.id, cp1.id),
    checkpoints: checkpoints.map(cp => builder.capture(cp)),
    resources: builder.getResources(),
  }
  return { file, checkpoints }
}

/** 合法v1 fixture；totalCheckpoints>2000 时仅迁移预算（20000）可通过 */
function buildV1File(totalCheckpoints: number): RecordingFile {
  const drawing: Drawing = { id: 'dw-v1', name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1, value: 2 }] }
  const cp0 = makeCheckpoint({
    afterSeq: 0,
    segmentId: 'seg-0',
    chart: makeChart(makeBars(4), [drawing]),
    context: { 权息: '10派3' },
  })
  const cp1 = makeCheckpoint({ afterSeq: 2, segmentId: 'seg-1', training: makeTraining(), chart: makeChart(makeBars(5)) })
  const rest = Array.from({ length: Math.max(0, totalCheckpoints - 2) }, () =>
    makeCheckpoint({ afterSeq: 4, segmentId: 'seg-2' }),
  )
  return { ...HEADER, schemaVersion: 1, events: makeEvents(cp0.id, cp1.id), checkpoints: [cp0, cp1, ...rest], complete: false }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function gzipOf(data: string): Promise<Uint8Array> {
  return collect(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip')))
}

async function gzipOfBytes(data: Uint8Array): Promise<Uint8Array> {
  return collect(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip')))
}

/** 分块源流：记录已读字节数与cancel次数，用于证明解压越界时提前取消 */
function trackedChunks(bytes: Uint8Array, chunkSize: number): {
  stream: ReadableStream<Uint8Array>
  cancelCount: () => number
  readBytes: () => number
} {
  let cancels = 0
  let read = 0
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, bytes.length)
      read += end - offset
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
    },
    cancel() {
      cancels += 1
    },
  })
  return { stream, cancelCount: () => cancels, readBytes: () => read }
}

async function gzipMagic(blob: Blob): Promise<[number, number]> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  return [head[0] as number, head[1] as number]
}

/** 测试时限包装：超时以明确错误失败并在finally清理定时器；悬挂的底层promise不持有事件循环，不会拖住Vitest进程 */
async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}：${ms}ms 内未完成，疑似解压取消死锁`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('writeRecordingFile/readRecordingFile 往返', () => {
  it('write默认gzip（1f 8b开头），read逐checkpoint深等且资源一致', async () => {
    const { file, checkpoints } = buildCompactFile()
    const blob = await writeRecordingFile(file)
    expect(await gzipMagic(blob)).toEqual([0x1f, 0x8b])

    const read = await readRecordingFile(blob)
    expect(read.schemaVersion).toBe(2)
    expect(read.sessionId).toBe(file.sessionId)
    expect(read.createdAt).toBe(file.createdAt)
    expect(read.app).toEqual(file.app)
    expect(read.environment).toEqual(file.environment)
    expect(read.trainingKey).toBe(file.trainingKey)
    expect(read.events).toEqual(file.events)
    expect(read.gaps).toEqual(file.gaps)
    expect(read.complete).toBe(file.complete)
    expect(read.resources).toEqual(file.resources)

    const reader = new CompactReader(read)
    for (let i = 0; i < checkpoints.length; i += 1) {
      expect(reader.checkpointAt(i)).toEqual(checkpoints[i])
    }
  })

  it('unicode内容（context/画线extendData/训练名）压缩与明文往返无损', async () => {
    const { file, checkpoints } = buildCompactFile()
    const gzRead = await readRecordingFile(await writeRecordingFile(file))
    const plainRead = await readRecordingFile(await writeRecordingFile(file, false))
    for (const read of [gzRead, plainRead]) {
      const reader = new CompactReader(read)
      expect(reader.checkpointAt(0).context).toEqual({ 权息: '10派3（含税）' })
      expect(reader.checkpointAt(0).chart?.drawings[0]?.extendData).toEqual(checkpoints[0].chart?.drawings[0]?.extendData)
      expect(reader.checkpointAt(1).training?.training.name).toBe('浦发银行')
      expect(reader.checkpointAt(2).context).toEqual({ 嵌套: [1, 2, { ok: true }] })
    }
  })

  it('未压缩v2 JSON可读且内容一致', async () => {
    const { file, checkpoints } = buildCompactFile()
    const blob = await writeRecordingFile(file, false)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await blob.arrayBuffer()))
    expect(text).toContain('"schemaVersion":2')
    const read = await readRecordingFile(blob)
    expect(read.schemaVersion).toBe(2)
    expect(read.events).toEqual(file.events)
    expect(read.resources).toEqual(file.resources)
    const reader = new CompactReader(read)
    for (let i = 0; i < checkpoints.length; i += 1) {
      expect(reader.checkpointAt(i)).toEqual(checkpoints[i])
    }
  })

  it('v1 JSON（2001检查点）迁移为v2且保持全部数据', async () => {
    const v1 = buildV1File(2001)
    // 证明fixture确实超出旧默认2000：迁移必须走 maxCheckpoints:20000 预算
    expect(() => validateRecording(v1)).toThrow(/超过上限 2000/)
    const blob = new Blob([JSON.stringify(v1)], { type: 'application/json' })
    const read = await readRecordingFile(blob)
    expect(read.schemaVersion).toBe(2)
    expect(read.events).toEqual(v1.events)
    expect(read.gaps).toEqual(v1.gaps)
    expect(read.complete).toBe(v1.complete)
    const reader = new CompactReader(read)
    for (let i = 0; i < v1.checkpoints.length; i += 1) {
      expect(reader.checkpointAt(i)).toEqual(v1.checkpoints[i])
    }
  })
})

describe('识别与异常输入', () => {
  it('gzip识别只看magic，与Blob类型无关（双向）', async () => {
    const { file } = buildCompactFile()
    // 明文JSON + 伪装gzip类型：按内容识别为明文
    const fakeGzip = new Blob([JSON.stringify(file)], { type: 'application/gzip' })
    expect(await readRecordingFile(fakeGzip)).toMatchObject({ schemaVersion: 2 })
    // gzip字节 + 伪装json类型：按magic识别为gzip
    const gz = await writeRecordingFile(file)
    const mislabeled = new Blob([gz], { type: 'application/json' })
    expect(await readRecordingFile(mislabeled)).toMatchObject({ schemaVersion: 2 })
  })

  it('截断gzip报中文可行动错误', async () => {
    const gz = await writeRecordingFile(buildCompactFile().file)
    const bytes = new Uint8Array(await gz.arrayBuffer())
    const cut = bytes.slice(0, Math.floor(bytes.length * 0.6))
    await expect(readRecordingFile(new Blob([cut]))).rejects.toThrow(/gzip 解压失败|损坏|截断/)
  })

  it('gzip内的JSON截断报中文错误', async () => {
    const text = JSON.stringify(buildCompactFile().file).slice(0, 60)
    const blob = new Blob([await gzipOf(text)], { type: 'application/gzip' })
    await expect(readRecordingFile(blob)).rejects.toThrow(/JSON 解析失败/)
  })

  it('明文JSON截断报中文错误；空文件同样拒绝', async () => {
    await expect(readRecordingFile(new Blob(['{"format":"trainer-sess']))).rejects.toThrow(/JSON 解析失败/)
    await expect(readRecordingFile(new Blob([]))).rejects.toThrow(/JSON 解析失败/)
  })

  it('未知schema显式拒绝，不能只cast', async () => {
    const base = buildCompactFile().file as unknown as Record<string, unknown>
    await expect(readRecordingFile(new Blob([JSON.stringify({ ...base, schemaVersion: 3 })]))).rejects.toThrow(
      /schemaVersion|仅支持 1 或 2/,
    )
    await expect(readRecordingFile(new Blob([JSON.stringify({ ...base, schemaVersion: '2' })]))).rejects.toThrow(
      /schemaVersion|必须是 2/,
    )
    await expect(readRecordingFile(new Blob([JSON.stringify({ ...base, format: 'other-session' })]))).rejects.toThrow(
      /format/,
    )
    // gzip包装下的未知schema同样拒绝
    const gz = await gzipOf(JSON.stringify({ ...base, schemaVersion: 3 }))
    await expect(readRecordingFile(new Blob([gz]))).rejects.toThrow(/schemaVersion|仅支持 1 或 2/)
  })

  it('损坏UTF-8字节拒绝而非替换后误接受', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x7d])
    await expect(readRecordingFile(new Blob([bytes]))).rejects.toThrow(/UTF-8 解码失败/)
  })
})

describe('write校验与预算', () => {
  it('NaN导出失败（不能静默写成null）', async () => {
    const file = buildCompactFile().file
    ;(file.resources.accounts[0] as { value: { equity: number } }).value.equity = Number.NaN
    await expect(writeRecordingFile(file)).rejects.toThrow(/有限|NaN/)
    await expect(writeRecordingFile(file, false)).rejects.toThrow(/有限|NaN/)
  })

  it('write先校验：损坏引用不产生文件', async () => {
    const file = buildCompactFile().file
    ;(file.checkpoints[0]!.chart as { seriesRef: string }).seriesRef = 's-missing'
    await expect(writeRecordingFile(file)).rejects.toThrow(/s-missing/)
  })

  it('write受预算约束，不产生自己读不了的文件', async () => {
    const file = buildCompactFile().file
    await expect(
      writeRecordingFileWithBudgets(file, true, { ...RECORDING_FILE_BUDGETS, gzipInputBytes: 8 }),
    ).rejects.toThrow(/压缩输入上限|导出大小/)
    await expect(
      writeRecordingFileWithBudgets(file, false, { ...RECORDING_FILE_BUDGETS, v2Bytes: 8 }),
    ).rejects.toThrow(/v2 预算|导出大小/)
    // 同一套注入预算下写出的文件必须能被同预算read接受
    const shared = { ...RECORDING_FILE_BUDGETS, gzipInputBytes: 1 << 16, v2Bytes: 1 << 16 }
    const blob = await writeRecordingFileWithBudgets(file, true, shared)
    expect(await readRecordingFileWithBudgets(blob, shared)).toMatchObject({ schemaVersion: 2 })
  })
})

describe('预算分层与流式取消', () => {
  it('gzip输入、解压输出、v2判定后是三个不同预算', async () => {
    const gz = await writeRecordingFile(buildCompactFile().file)
    // 压缩输入预算收紧：即使解压后很小也拒绝
    await expect(
      readRecordingFileWithBudgets(gz, { ...RECORDING_FILE_BUDGETS, gzipInputBytes: 8 }),
    ).rejects.toThrow(/压缩输入上限/)
    // 解压输出预算收紧：gzip本身很小但解压后超限
    await expect(
      readRecordingFileWithBudgets(gz, { ...RECORDING_FILE_BUDGETS, decompressedBytes: 64 }),
    ).rejects.toThrow(/解压预算|取消解压/)
    // v2判定后预算收紧（解压预算未超）：v2拒绝
    await expect(readRecordingFileWithBudgets(gz, { ...RECORDING_FILE_BUDGETS, v2Bytes: 64 })).rejects.toThrow(
      /v2 预算/,
    )
    // 同样大小的v1文件不受v2紧预算约束（迁移走256MiB外层）
    const v1gz = new Blob([await gzipOf(JSON.stringify(buildV1File(3)))], { type: 'application/gzip' })
    expect(await readRecordingFileWithBudgets(v1gz, { ...RECORDING_FILE_BUDGETS, v2Bytes: 64 })).toMatchObject({
      schemaVersion: 2,
    })
  })

  it('明文blob.size先拦', async () => {
    const plain = await writeRecordingFile(buildCompactFile().file, false)
    await expect(
      readRecordingFileWithBudgets(plain, { ...RECORDING_FILE_BUDGETS, plaintextBytes: 64 }),
    ).rejects.toThrow(/明文上限/)
  })

  it('解压超预算：立即cancel reader并停止读取，而非完整解压后判断', async () => {
    // 不可压缩且跨多个deflate stored block（~128KB）：解压随写入逐块产出，
    // 预算命中时源还有未读数据。小/单块gzip只在close时一次性吐出，cancel不可观测。
    const random = new Uint8Array(randomBytes(128 * 1024))
    const gz = await gzipOfBytes(random)
    expect(gz.byteLength).toBeGreaterThan(64 * 1024)
    const { stream, cancelCount, readBytes } = trackedChunks(gz, 16 * 1024)
    await expect(inflateGzipWithBudget(stream, 64)).rejects.toThrow(/解压预算|取消解压/)
    expect(cancelCount()).toBe(1)
    expect(readBytes()).toBeLessThan(gz.byteLength)
  })
})

describe('解压取消时限（高压缩率死锁回归）', () => {
  // 死锁机制：解压输出跨多个chunk时，draining越界抛错后无人继续读输出，
  // 主循环悬挂在 writer.write()/writer.close()（输出未排空时close永不返回，
  // 且abort救不了已挂起的close），导入永久挂死。65B gzip(32768×'A') 64B预算可复现。
  const DEADLINE_MS = 750

  it('高压缩率gzip解压超预算：悬挂在close时也能在时限内拒绝（65B→32KiB，64B预算）', async () => {
    const gz = await gzipOfBytes(new Uint8Array(32768).fill(65))
    expect(gz.byteLength).toBeLessThan(4096)
    await expect(
      withDeadline(inflateGzipWithBudget(new Blob([gz]).stream(), 64), DEADLINE_MS, '32KiB高压缩率解压'),
    ).rejects.toThrow(/解压预算|取消解压/)
  })

  it('高压缩率多输出chunk+预算：1MiB原文/65536预算越界同样及时拒绝，16384仍正常拒绝', async () => {
    const gz = await gzipOfBytes(new Uint8Array(1024 * 1024).fill(65))
    expect(gz.byteLength).toBeLessThan(4096)
    await expect(
      withDeadline(inflateGzipWithBudget(new Blob([gz]).stream(), 65536), DEADLINE_MS, '1MiB高压缩率解压'),
    ).rejects.toThrow(/解压预算|取消解压/)
    const small = await gzipOfBytes(new Uint8Array(16384).fill(65))
    await expect(
      withDeadline(inflateGzipWithBudget(new Blob([small]).stream(), 64), DEADLINE_MS, '16384高压缩率解压'),
    ).rejects.toThrow(/解压预算|取消解压/)
  })

  it('1MiB正常gzip按1/16/16384/65536/1MiB输入块往返无损', { timeout: 120_000 }, async () => {
    const plain = new Uint8Array(randomBytes(1024 * 1024))
    const gz = await gzipOfBytes(plain)
    expect(gz.byteLength).toBeGreaterThan(512 * 1024)
    for (const chunkSize of [1, 16, 16384, 65536, 1024 * 1024]) {
      const { stream } = trackedChunks(gz, chunkSize)
      const out = await withDeadline(inflateGzipWithBudget(stream, 2 * 1024 * 1024), 30_000, `1MiB往返(块=${chunkSize})`)
      expect(out.byteLength).toBe(plain.byteLength)
      expect(Buffer.from(out).equals(Buffer.from(plain))).toBe(true)
    }
  })

  it('多块源流上的截断gzip同样及时拒绝', async () => {
    const random = new Uint8Array(randomBytes(128 * 1024))
    const gz = await gzipOfBytes(random)
    const cut = gz.slice(0, Math.floor(gz.byteLength * 0.6))
    const { stream } = trackedChunks(cut, 16 * 1024)
    await expect(
      withDeadline(inflateGzipWithBudget(stream, 256 * 1024 * 1024), 5_000, '多块截断gzip'),
    ).rejects.toThrow(/gzip 解压失败|损坏|截断/)
  })
})
