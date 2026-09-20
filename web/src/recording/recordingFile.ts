// REC-FILE-V2：gzip文件封装（docs/engineering/recording-v2-contract.md「校验、文件封装」节）。
// 只用浏览器标准API（Blob/CompressionStream/DecompressionStream/TextDecoder），Node24 同API可测；
// 不引入 Node fs/zlib，无新依赖。gzip按magic(1f 8b)识别，与扩展名/MIME无关。
// 预算为固定常量，绝不从录制文件内容读取；解压逐chunk计数，越界立即cancel，不完整解压后判断。
import { compactRecording } from './compactCodec'
import type { CompactRecordingFile } from './compactTypes'
import { validateCompactRecording } from './compactValidation'
import { fail, isRecord, validateRecording } from './validation'

/** 压缩输入上限：gzip blob 字节数 */
export const MAX_GZIP_INPUT_BYTES = 25 * 1024 * 1024
/** 明文外层上限（含旧v1明文兼容） */
export const MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024
/** 解压后外层上限（含旧v1兼容；v1迁移允许到该值） */
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024
/** 判定为v2后的更紧预算 */
export const MAX_V2_BYTES = 128 * 1024 * 1024
/**
 * 解压输入合并上限：逐chunk write进DecompressionStream每次有固定异步开销，
 * 上游1字节粒度时1MiB输入约百万次write，慢CI（2vCPU/4worker）上超过30s时限。
 * 源小块先并入该有界缓冲再写；导出仅供测试按上限构造跨边界用例。
 */
export const INFLATE_COALESCE_BYTES = 64 * 1024

/** v1迁移时的检查点预算（合同值20000；只能由调用方传入，绝不从文件内容读取） */
const V1_MIGRATION_MAX_CHECKPOINTS = 20_000

/** 读写字节预算；生产入口固定使用 RECORDING_FILE_BUDGETS，测试可注入更小阈值省内存 */
export interface RecordingFileBudgets {
  gzipInputBytes: number
  plaintextBytes: number
  decompressedBytes: number
  v2Bytes: number
}

export const RECORDING_FILE_BUDGETS: RecordingFileBudgets = {
  gzipInputBytes: MAX_GZIP_INPUT_BYTES,
  plaintextBytes: MAX_PLAINTEXT_BYTES,
  decompressedBytes: MAX_DECOMPRESSED_BYTES,
  v2Bytes: MAX_V2_BYTES,
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function gzipTransform(): TransformStream<Uint8Array, Uint8Array> {
  return new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * gzip流式解压：手动泵送（源chunk并入有界缓冲后写gunzip，并发读取gunzip读出端逐chunk计数），
 * 超过 maxBytes 立即取消上游 reader 并中止，绝不先完整解压再判断。
 * 不用 pipeThrough：其后台管道会急切拉满源流，且取消不向源传播。
 * 流损坏/截断抛中文可行动错误。供注入小阈值测试；生产入口用固定预算。
 */
export async function inflateGzipWithBudget(
  compressed: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const budgetMessage = `录制文件读取失败：解压后数据超过解压预算 ${maxBytes} 字节，已提前取消解压以保护内存`
  const sourceReader = compressed.getReader()
  const gunzip = new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  const writer = gunzip.writable.getWriter()
  const outReader = gunzip.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let budgetHit = false
  let decompressError: unknown = null
  let interrupted = false
  let fireFatal!: (err: unknown) => void
  // 输出端死亡信号：主循环所有悬挂的 write/close 都与之赛跑，保证总能被唤醒
  const fatal = new Promise<never>((_, reject) => {
    fireFatal = reject
  })
  fatal.catch(() => {})
  // 输出端越界/出错时立即同时打断三端，绝不顺序await：
  // 输出无人排空时挂起的 writer.write/writer.close 永不返回，且 abort 无法挽救已挂起的
  // close（实测唯一可靠出口是 cancel 解压读出端，close 会以 cancel 原因被拒绝）。
  // 各动作只触发不等待，任何一端悬挂都不会阻塞其余两端。
  const interrupt = (err: unknown) => {
    if (interrupted) return
    interrupted = true
    fireFatal(err)
    outReader.cancel(err).catch(() => {})
    sourceReader.cancel().catch(() => {})
    writer.abort(err).catch(() => {})
  }
  // 并发消费解压输出：每到一个chunk就计数，越界立即置位、打断并抛出
  const draining = (async () => {
    try {
      for (;;) {
        const { done, value } = await outReader.read()
        if (done) return
        total += value.byteLength
        chunks.push(value)
        if (total > maxBytes) {
          budgetHit = true
          interrupt(new Error(budgetMessage))
          throw new Error(budgetMessage)
        }
      }
    } catch (err) {
      if (!budgetHit) {
        decompressError = err
        interrupt(err)
      }
      throw err
    }
  })()
  // 立即挂空catch：拒绝统一在下方await draining处分类，避免注册为unhandled rejection
  draining.catch(() => {})
  let inputError: unknown = null
  // 固定输入缓冲立即复制已读小块，允许上游在下一次read时复用其内存。
  // 越上限先冲刷、源结束后冲刷残余再close，不持有大量小块引用。
  const pending = new Uint8Array(INFLATE_COALESCE_BYTES)
  let pendingBytes = 0
  const flushPending = async (): Promise<void> => {
    if (pendingBytes === 0) return
    const coalesced = pending.subarray(0, pendingBytes)
    pendingBytes = 0
    // 背压下的write同理：越界/出错时靠fatal唤醒，不能裸await
    const written = writer.write(coalesced)
    written.catch(() => {})
    await Promise.race([written, fatal])
  }
  try {
    for (;;) {
      if (budgetHit || decompressError !== null) break
      const { done, value } = await sourceReader.read()
      if (done) {
        // 残余不冲刷输出即截断；close可能在输出未排空时悬挂，必须与死亡信号赛跑，不能裸await
        await flushPending()
        const closed = writer.close()
        closed.catch(() => {})
        await Promise.race([closed, fatal])
        break
      }
      if (pendingBytes + value.byteLength > INFLATE_COALESCE_BYTES) {
        await flushPending()
      }
      if (pendingBytes === 0 && value.byteLength >= INFLATE_COALESCE_BYTES) {
        // 大块直写：与合并前行为一致，避免一次额外拷贝
        const written = writer.write(value)
        written.catch(() => {})
        await Promise.race([written, fatal])
        continue
      }
      pending.set(value, pendingBytes)
      pendingBytes += value.byteLength
    }
  } catch (err) {
    inputError = err
  }
  // 兜底收尾：正常/中断路径到此各端都已了结或被interrupt打断，逐项幂等清理；
  // 只触发不await——abort在close挂起时自身不settle，此时主流程已不被任何一端阻塞
  sourceReader.cancel().catch(() => {})
  writer.abort().catch(() => {})
  outReader.cancel().catch(() => {})
  try {
    await draining
  } catch {
    // 由 budgetHit/decompressError 分类处理
  }
  if (budgetHit) throw new Error(budgetMessage)
  if (decompressError !== null || inputError !== null) {
    throw new Error(`录制文件读取失败：gzip 解压失败，数据可能损坏或被截断（${reason(decompressError ?? inputError)}）`)
  }
  return concatChunks(chunks, total)
}

async function deflateToUint8Array(plain: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const outReader = new Blob([plain as BlobPart]).stream().pipeThrough(gzipTransform()).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await outReader.read()
    if (done) break
    total += value.byteLength
    chunks.push(value)
  }
  return concatChunks(chunks, total)
}

/** fatal模式UTF-8解码：损坏字节按损坏文件拒绝，绝不替换后误接受 */
function decodeUtf8Fatal(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (err) {
    throw new Error(`录制文件读取失败：UTF-8 解码失败，文件包含损坏的字节序列（${reason(err)}）`)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`录制文件读取失败：JSON 解析失败，文件可能被截断或不是合法 JSON（${reason(err)}）`)
  }
}

/** 按schema路由：v2直接校验；v1按迁移预算校验后转v2再校验；未知schema显式拒绝 */
function validateBySchema(value: unknown, byteLength: number, budgets: RecordingFileBudgets): CompactRecordingFile {
  if (!isRecord(value)) fail('顶层', '必须是 JSON 对象')
  if (value.schemaVersion === 2) {
    if (byteLength > budgets.v2Bytes) {
      fail('文件大小', `v2 录制文件 ${byteLength} 字节超过 v2 预算 ${budgets.v2Bytes} 字节（128MiB）`)
    }
    return validateCompactRecording(value)
  }
  if (value.schemaVersion === 1) {
    if (byteLength > budgets.decompressedBytes) {
      fail('文件大小', `v1 录制文件 ${byteLength} 字节超过迁移预算 ${budgets.decompressedBytes} 字节（256MiB）`)
    }
    const v1 = validateRecording(value, { maxCheckpoints: V1_MIGRATION_MAX_CHECKPOINTS })
    return validateCompactRecording(compactRecording(v1))
  }
  fail('schemaVersion', `不支持的录制文件版本（收到 ${JSON.stringify(value.schemaVersion)}），仅支持 1 或 2`)
}

export async function readRecordingFile(blob: Blob): Promise<CompactRecordingFile> {
  return readRecordingFileWithBudgets(blob, RECORDING_FILE_BUDGETS)
}

/** readRecordingFile 的内部入口；budgets 只能由调用方注入，绝不从录制文件内容读取 */
export async function readRecordingFileWithBudgets(
  blob: Blob,
  budgets: RecordingFileBudgets,
): Promise<CompactRecordingFile> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  const isGzip = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b
  let bytes: Uint8Array
  if (isGzip) {
    // gzip不信任扩展名/MIME，Blob.size是压缩输入真实字节数
    if (blob.size > budgets.gzipInputBytes) {
      fail('文件大小', `gzip 输入 ${blob.size} 字节超过压缩输入上限 ${budgets.gzipInputBytes} 字节（25MiB）`)
    }
    bytes = await inflateGzipWithBudget(blob.stream(), budgets.decompressedBytes)
  } else {
    // 明文先按 blob.size 拦截，再读入
    if (blob.size > budgets.plaintextBytes) {
      fail('文件大小', `明文文件 ${blob.size} 字节超过明文上限 ${budgets.plaintextBytes} 字节（256MiB）`)
    }
    bytes = new Uint8Array(await blob.arrayBuffer())
  }
  const text = decodeUtf8Fatal(bytes)
  return validateBySchema(parseJson(text), bytes.byteLength, budgets)
}

export async function writeRecordingFile(file: CompactRecordingFile, compressed = true): Promise<Blob> {
  return writeRecordingFileWithBudgets(file, compressed, RECORDING_FILE_BUDGETS)
}

/** writeRecordingFile 的内部入口；先校验再序列化，输出必须能被同预算 read 接受 */
export async function writeRecordingFileWithBudgets(
  file: CompactRecordingFile,
  compressed: boolean,
  budgets: RecordingFileBudgets,
): Promise<Blob> {
  const validated = validateCompactRecording(file)
  const bytes = new TextEncoder().encode(JSON.stringify(validated))
  if (bytes.byteLength > budgets.v2Bytes) {
    fail('导出大小', `v2 JSON ${bytes.byteLength} 字节超过 v2 预算 ${budgets.v2Bytes} 字节（128MiB），产生的文件无法被 readRecordingFile 接受`)
  }
  if (!compressed) return new Blob([bytes as BlobPart], { type: 'application/json' })
  const gz = await deflateToUint8Array(bytes)
  if (gz.byteLength > budgets.gzipInputBytes) {
    fail('导出大小', `gzip 输出 ${gz.byteLength} 字节超过压缩输入上限 ${budgets.gzipInputBytes} 字节（25MiB），产生的文件无法被 readRecordingFile 接受`)
  }
  return new Blob([gz], { type: 'application/gzip' })
}
