import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDayBuffer } from './dayfile.js'
import { isAShareCode, type TdxMarket } from './stocks.js'

export interface TdxCandidateCheck {
  root: string
  recognized: boolean
  readable: boolean
  dailyFileCount: number
  latestDate: string | null
  hasAdjustment: boolean
  hasNames: boolean
  hasBenchmark: boolean
  problems: string[]
}

const DAY_RECORD_SIZE = 32
const GBBQ_HEADER_SIZE = 4
const GBBQ_RECORD_SIZE = 29
const MARKETS: readonly TdxMarket[] = ['sh', 'sz', 'bj']
const BENCHMARK_CODE = '000300'
const MAX_PROBLEMS = 200
const READ_ATTEMPTS = 3
const RETRY_DELAY_MS = 25
const FILE_CONCURRENCY = 8
const NAME_VERIFY_BYTES = 64
const ACCESS_ERROR_CODES = new Set(['EACCES', 'EPERM'])

type AccessTracker = { sawAccessError: boolean }

function noteAccessError(access: AccessTracker, code: string | undefined): void {
  if (code !== undefined && ACCESS_ERROR_CODES.has(code)) access.sawAccessError = true
}

type PathDescription =
  | { kind: 'dir' | 'file' | 'symlink' | 'other'; size: number; mtimeMs: number }
  | { kind: 'absent' }
  | { kind: 'error'; code: string; message: string }

// lstat 只保护路径末段；候选根的祖先段与 vipdoc/<market>、T0002 等中间段由调用方逐段 lstat 确认后才允许进入
async function describePath(path: string): Promise<PathDescription> {
  try {
    const info = await lstat(path)
    const size = info.size
    const mtimeMs = info.mtimeMs
    if (info.isSymbolicLink()) return { kind: 'symlink', size, mtimeMs }
    if (info.isDirectory()) return { kind: 'dir', size, mtimeMs }
    if (info.isFile()) return { kind: 'file', size, mtimeMs }
    return { kind: 'other', size, mtimeMs }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'error', code: code ?? 'EUNKNOWN', message: (error as Error).message }
  }
}

// 逐段 lstat 候选根的全部祖先（lstat 会穿过中间段 junction 解析末段，只查末段不够）；
// 中间段缺失/出错时返回 null，由末段检查统一报告
async function findSymlinkAncestor(absolute: string): Promise<string | null> {
  const segments = absolute.split(/[\\/]/).filter(Boolean)
  const posixBase = absolute.startsWith('/') ? '/' : null
  const parts: string[] = []
  for (let index = 0; index < segments.length - 1; index += 1) {
    parts.push(segments[index])
    const prefix = index === 0 && /^[A-Za-z]:$/.test(segments[0])
      ? segments[0] + '\\'
      : posixBase
        ? join(posixBase, ...parts)
        : join(...parts)
    const info = await describePath(prefix)
    if (info.kind === 'symlink') return prefix
    if (info.kind === 'absent' || info.kind === 'error') return null
  }
  return null
}

class ProblemList {
  private readonly seen = new Set<string>()
  private readonly items: string[] = []
  private omitted = 0

  add(message: string): void {
    if (this.seen.has(message)) return
    if (this.items.length >= MAX_PROBLEMS) {
      this.omitted += 1
      return
    }
    this.seen.add(message)
    this.items.push(message)
  }

  finish(): string[] {
    if (this.omitted > 0) this.items.push(`另有 ${this.omitted} 条同类问题未逐条列出`)
    return [...this.items]
  }
}

function isWindowsReservedName(segment: string): boolean {
  const stem = segment.replace(/\.[^.]*$/, '').toUpperCase()
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

type NormalizedRoot = { ok: true; absolute: string } | { ok: false; problem: string }

function normalizeRoot(input: string): NormalizedRoot {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, problem: '候选路径为空，请提供通达信安装根目录的绝对路径' }
  if (trimmed.startsWith('\\\\.\\') || trimmed.startsWith('\\\\?\\')) {
    return { ok: false, problem: `不支持设备命名空间路径（${trimmed}），请提供本机盘符的绝对路径` }
  }
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return { ok: false, problem: `不支持 UNC 网络路径（${trimmed}），请提供本机盘符的绝对路径` }
  }
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  if (process.platform === 'win32' && segments.some(isWindowsReservedName)) {
    return { ok: false, problem: `路径包含 Windows 保留设备名（${trimmed}），无法作为目录检查` }
  }
  if (!isAbsolute(trimmed)) {
    return { ok: false, problem: `候选路径是相对路径（${trimmed}），请提供包含盘符的绝对路径` }
  }
  return { ok: true, absolute: resolve(trimmed) }
}

function placementOf(description: PathDescription): { size: number; mtimeMs: number } | null {
  if (description.kind === 'absent' || description.kind === 'error') return null
  return { size: description.size, mtimeMs: description.mtimeMs }
}

function samePlacement(a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function firstRecordDate(buffer: Buffer): string | null {
  try {
    return parseDayBuffer(buffer)[0]?.date ?? null
  } catch {
    return null
  }
}

type DayFileOutcome = { ok: true; lastDate: string } | { ok: false }

// 只读首/末 32 字节记录，不读行情全文；读取前后 stat 不一致时有限重试，仍变化则报“正在更新”
async function checkDayFile(
  filePath: string,
  label: string,
  problems: ProblemList,
  access: AccessTracker,
): Promise<DayFileOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const before = await describePath(filePath)
    if (before.kind === 'absent') {
      problems.add(`${label} 不存在或刚被清理，检查不完整`)
      return { ok: false }
    }
    if (before.kind === 'error') {
      noteAccessError(access, before.code)
      problems.add(`${label} 无法访问（${before.code}），检查不完整`)
      return { ok: false }
    }
    if (before.kind === 'symlink') {
      problems.add(`${label} 是符号链接/junction，按策略不检查`)
      return { ok: false }
    }
    if (before.kind !== 'file') {
      problems.add(`${label} 不是常规文件，检查不完整`)
      return { ok: false }
    }
    if (before.size % DAY_RECORD_SIZE !== 0) {
      problems.add(`${label} 长度 ${before.size} 字节不是 ${DAY_RECORD_SIZE} 字节记录的整数倍，已跳过，检查不完整`)
      return { ok: false }
    }
    if (before.size === 0) {
      problems.add(`${label} 是空文件，没有可用日线记录`)
      return { ok: false }
    }
    let handle
    try {
      handle = await open(filePath, 'r')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      noteAccessError(access, code)
      problems.add(`${label} 无法读取（${code ?? (error as Error).message}），检查不完整`)
      return { ok: false }
    }
    try {
      try {
        const head = Buffer.alloc(DAY_RECORD_SIZE)
        const headRead = await handle.read(head, 0, DAY_RECORD_SIZE, 0)
        let tail = head
        let tailReadBytes = DAY_RECORD_SIZE
        if (before.size > DAY_RECORD_SIZE) {
          tail = Buffer.alloc(DAY_RECORD_SIZE)
          tailReadBytes = (await handle.read(tail, 0, DAY_RECORD_SIZE, before.size - DAY_RECORD_SIZE)).bytesRead
        }
        const after = await handle.stat()
        const afterPlacement = { size: after.size, mtimeMs: after.mtimeMs }
        const beforePlacement = placementOf(before)
        const readsComplete = headRead.bytesRead === DAY_RECORD_SIZE && tailReadBytes === DAY_RECORD_SIZE
        if (!beforePlacement || !readsComplete || !samePlacement(beforePlacement, afterPlacement)) {
          if (attempt < READ_ATTEMPTS) {
            await sleep(RETRY_DELAY_MS)
            continue
          }
          problems.add(`${label} 正在更新，本次跳过，检查不完整`)
          return { ok: false }
        }
        const headDate = firstRecordDate(head)
        const tailDate = firstRecordDate(tail)
        if (!headDate || !tailDate) {
          problems.add(`${label} 首条或末条记录日期无效，已跳过，检查不完整`)
          return { ok: false }
        }
        if (headDate > tailDate) {
          problems.add(`${label} 记录日期未按升序存放（首条 ${headDate} 晚于末条 ${tailDate}），已跳过，检查不完整`)
          return { ok: false }
        }
        return { ok: true, lastDate: tailDate }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        noteAccessError(access, code)
        problems.add(`${label} 读取失败（${code ?? (error as Error).message}），检查不完整`)
        return { ok: false }
      }
    } finally {
      await handle.close()
    }
  }
}

interface MarketScanResult {
  count: number
  latest: string | null
}

const DAY_FILE_NAME = /^(sh|sz|bj)(\d{6})\.day$/i

// 逐市场目录校验（vipdoc/<market> 这一段 lstat 末段 lday 不保护）；absent 保持静默，与下层 lday 缺失口径一致
async function describeMarketDirectory(
  root: string,
  market: TdxMarket,
  problems: ProblemList,
  access: AccessTracker,
): Promise<'dir' | 'skip'> {
  const directory = join(root, 'vipdoc', market)
  const info = await describePath(directory)
  if (info.kind === 'dir') return 'dir'
  if (info.kind === 'absent') return 'skip'
  if (info.kind === 'symlink') {
    problems.add(`市场 ${market} 目录 vipdoc/${market} 是符号链接/junction，按策略不跟随，该市场未检查`)
    return 'skip'
  }
  if (info.kind === 'error') {
    noteAccessError(access, info.code)
    problems.add(`市场 ${market} 目录 vipdoc/${market} 无法访问（${info.code}），检查不完整`)
    return 'skip'
  }
  problems.add(`市场 ${market} 目录 vipdoc/${market} 不是目录，检查不完整`)
  return 'skip'
}

async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

async function scanMarkets(root: string, problems: ProblemList, access: AccessTracker): Promise<MarketScanResult> {
  const result: MarketScanResult = { count: 0, latest: null }
  for (const market of MARKETS) {
    if (await describeMarketDirectory(root, market, problems, access) !== 'dir') continue
    const ldayDirectory = join(root, 'vipdoc', market, 'lday')
    const lday = await describePath(ldayDirectory)
    if (lday.kind === 'absent') continue
    if (lday.kind === 'symlink') {
      problems.add(`市场 ${market} 日线目录是符号链接/junction，按策略不检查`)
      continue
    }
    if (lday.kind === 'error') {
      noteAccessError(access, lday.code)
      problems.add(`市场 ${market} 日线目录无法访问（${lday.code}），检查不完整`)
      continue
    }
    if (lday.kind !== 'dir') {
      problems.add(`市场 ${market} 日线目录不是目录，检查不完整`)
      continue
    }
    let files: string[]
    try {
      files = (await readdir(ldayDirectory)).filter(name => name.toLowerCase().endsWith('.day')).sort()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      noteAccessError(access, code)
      problems.add(`市场 ${market} 日线目录读取失败（${code ?? (error as Error).message}），检查不完整`)
      continue
    }
    const candidates = files
      .map(name => {
        const match = name.match(DAY_FILE_NAME)
        if (!match) return null
        // 文件名市场前缀必须与所在市场目录一致，sh 目录里的 sz600000.day 不得计入
        if (match[1].toLowerCase() !== market) {
          problems.add(`vipdoc/${market}/lday/${name} 文件名前缀与所在市场目录不一致，已跳过`)
          return null
        }
        const code = match[2]
        if (!isAShareCode(market, code)) return null
        return { name, label: `vipdoc/${market}/lday/${name}` }
      })
      .filter((item): item is { name: string; label: string } => item !== null)
    const outcomes = await mapLimited(candidates, FILE_CONCURRENCY, candidate =>
      checkDayFile(join(ldayDirectory, candidate.name), candidate.label, problems, access),
    )
    for (const outcome of outcomes) {
      if (!outcome.ok) continue
      result.count += 1
      if (!result.latest || outcome.lastDate > result.latest) result.latest = outcome.lastDate
    }
  }
  return result
}

async function checkAdjustment(root: string, problems: ProblemList, access: AccessTracker): Promise<boolean> {
  const gbbqPath = join(root, 'T0002', 'hq_cache', 'gbbq')
  const info = await describePath(gbbqPath)
  if (info.kind === 'absent') {
    problems.add('缺少权息文件 T0002/hq_cache/gbbq，无法做前复权')
    return false
  }
  if (info.kind === 'symlink') {
    problems.add('权息文件 gbbq 是符号链接/junction，按策略不检查')
    return false
  }
  if (info.kind === 'error') {
    noteAccessError(access, info.code)
    problems.add(`权息文件 gbbq 无法访问（${info.code}），无法确认可用`)
    return false
  }
  if (info.kind !== 'file') {
    problems.add('权息文件 gbbq 不是常规文件，不可用')
    return false
  }
  if (info.size < GBBQ_HEADER_SIZE) {
    problems.add(`权息文件 gbbq 为空或缺少记录头（${info.size} 字节），不可用`)
    return false
  }
  // 只读 4 字节记录头做一致性检查；本标志不代表解码成功
  let handle
  try {
    handle = await open(gbbqPath, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    noteAccessError(access, code)
    problems.add(`权息文件 gbbq 无法读取（${code ?? (error as Error).message}），不可用`)
    return false
  }
  try {
    try {
      const header = Buffer.alloc(GBBQ_HEADER_SIZE)
      const headerRead = await handle.read(header, 0, GBBQ_HEADER_SIZE, 0)
      const after = await handle.stat()
      if (headerRead.bytesRead !== GBBQ_HEADER_SIZE || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        problems.add('权息文件 gbbq 正在更新，本次无法确认可用')
        return false
      }
      const recordCount = header.readUInt32LE(0)
      if (after.size !== GBBQ_HEADER_SIZE + recordCount * GBBQ_RECORD_SIZE) {
        problems.add('权息文件 gbbq 长度与记录数不一致，疑似损坏，不可用')
        return false
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      noteAccessError(access, code)
      problems.add(`权息文件 gbbq 读取失败（${code ?? (error as Error).message}），不可用`)
      return false
    }
  } finally {
    await handle.close()
  }
  return true
}

// 名称不只看 lstat 非空：固定读取少量字节证明文件确实可读；缺失与权限拒绝分开报告
async function verifyNameFile(path: string, relative: string, problems: ProblemList, access: AccessTracker): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    noteAccessError(access, code)
    problems.add(`证券名称文件 ${relative} 存在但无法读取（${code ?? (error as Error).message}），名称不可用`)
    return false
  }
  try {
    const buffer = Buffer.alloc(NAME_VERIFY_BYTES)
    const read = await handle.read(buffer, 0, NAME_VERIFY_BYTES, 0)
    return read.bytesRead > 0
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    noteAccessError(access, code)
    problems.add(`证券名称文件 ${relative} 存在但无法读取（${code ?? (error as Error).message}），名称不可用`)
    return false
  } finally {
    await handle.close()
  }
}

async function checkNames(root: string, problems: ProblemList, access: AccessTracker): Promise<boolean> {
  const candidates = [...MARKETS.map(market => join('T0002', 'hq_cache', `${market}s.tnf`)), join('T0002', 'hq_cache', 'base.dbf')]
  let sawMissing = true
  for (const relative of candidates) {
    const info = await describePath(join(root, relative))
    if (info.kind === 'error') {
      noteAccessError(access, info.code)
      problems.add(`证券名称文件 ${relative} 无法访问（${info.code}），无法确认名称可用`)
      sawMissing = false
      continue
    }
    if (info.kind !== 'file' || info.size === 0) continue
    sawMissing = false
    if (await verifyNameFile(join(root, relative), relative, problems, access)) return true
  }
  if (sawMissing) {
    problems.add('缺少可用的证券名称文件（T0002/hq_cache/shs.tnf、szs.tnf、bjs.tnf 或 base.dbf），名称将退化为代码')
  }
  return false
}

// 基准沿用产品实际使用的 sh000300 日线（api/kline 与验收测试均以 vipdoc/sh/lday/sh000300.day 为基准源）
async function checkBenchmark(root: string, problems: ProblemList, access: AccessTracker): Promise<boolean> {
  if (await describeMarketDirectory(root, 'sh', problems, access) !== 'dir') return false
  const ldayDirectory = join(root, 'vipdoc', 'sh', 'lday')
  const lday = await describePath(ldayDirectory)
  if (lday.kind !== 'dir') return false
  const benchmarkPath = join(ldayDirectory, `sh${BENCHMARK_CODE}.day`)
  const info = await describePath(benchmarkPath)
  if (info.kind === 'absent') {
    problems.add(`缺少基准指数日线 vipdoc/sh/lday/sh${BENCHMARK_CODE}.day，无法对照基准走势`)
    return false
  }
  const outcome = await checkDayFile(benchmarkPath, `vipdoc/sh/lday/sh${BENCHMARK_CODE}.day（基准指数日线）`, problems, access)
  return outcome.ok
}

function emptyCheck(root: string, problems: string[]): TdxCandidateCheck {
  return {
    root,
    recognized: false,
    readable: false,
    dailyFileCount: 0,
    latestDate: null,
    hasAdjustment: false,
    hasNames: false,
    hasBenchmark: false,
    problems,
  }
}

export async function inspectTdxCandidate(root: string): Promise<TdxCandidateCheck> {
  const normalized = normalizeRoot(root)
  if (!normalized.ok) return emptyCheck(root.trim(), [normalized.problem])
  const absolute = normalized.absolute
  const problems = new ProblemList()
  const access: AccessTracker = { sawAccessError: false }
  try {
    const rootInfo = await describePath(absolute)
    if (rootInfo.kind === 'absent') {
      return { ...emptyCheck(absolute, []), problems: [`根目录不存在：${absolute}，请确认选择的是通达信安装根目录`] }
    }
    if (rootInfo.kind === 'error') {
      return { ...emptyCheck(absolute, []), problems: [`根目录无法访问（${rootInfo.code}），可能是权限或被占用：${absolute}`] }
    }
    if (rootInfo.kind === 'symlink') {
      return { ...emptyCheck(absolute, []), problems: [`根目录是符号链接/junction，按策略不跟随：${absolute}，请直接填写真实安装目录`] }
    }
    if (rootInfo.kind !== 'dir') {
      return { ...emptyCheck(absolute, []), problems: [`根路径不是目录：${absolute}`] }
    }
    const ancestor = await findSymlinkAncestor(absolute)
    if (ancestor) {
      return {
        ...emptyCheck(absolute, []),
        problems: [`候选路径中包含符号链接/junction（${ancestor}），按策略不跟随，请直接填写真实安装目录`],
      }
    }

    const vipdoc = await describePath(join(absolute, 'vipdoc'))
    const t0002 = await describePath(join(absolute, 'T0002'))
    const hqCache = await describePath(join(absolute, 'T0002', 'hq_cache'))
    const recognized = vipdoc.kind === 'dir' || hqCache.kind === 'dir'
    if (!recognized) {
      problems.add('未发现通达信结构（需要 vipdoc 或 T0002/hq_cache 目录），该目录不像已安装的通达信，请选择通达信安装根目录')
      return {
        root: absolute,
        recognized: false,
        readable: true,
        dailyFileCount: 0,
        latestDate: null,
        hasAdjustment: false,
        hasNames: false,
        hasBenchmark: false,
        problems: problems.finish(),
      }
    }
    if (vipdoc.kind === 'symlink') {
      problems.add('vipdoc 是符号链接/junction，按策略不跟随，行情数据未检查')
    } else if (vipdoc.kind === 'error') {
      noteAccessError(access, vipdoc.code)
      problems.add(`vipdoc 无法访问（${vipdoc.code}），行情数据未检查`)
    } else if (vipdoc.kind === 'file' || vipdoc.kind === 'other') {
      problems.add('vipdoc 不是目录，行情数据未检查')
    }

    const scan = vipdoc.kind === 'dir' ? await scanMarkets(absolute, problems, access) : { count: 0, latest: null }
    if (scan.count === 0) {
      problems.add('已识别通达信结构，但没有可用的 A 股日线数据，当前不能用于训练')
    }

    const hqUsable = t0002.kind === 'dir' && hqCache.kind === 'dir'
    if (!hqUsable) {
      if (t0002.kind === 'symlink') {
        problems.add('T0002 是符号链接/junction，按策略不跟随，权息与名称未确认')
      } else if (t0002.kind === 'error') {
        noteAccessError(access, t0002.code)
        problems.add(`T0002 无法访问（${t0002.code}），权息与名称未确认`)
      } else if (t0002.kind === 'file' || t0002.kind === 'other') {
        problems.add('T0002 不是目录，权息与名称未确认')
      } else if (hqCache.kind === 'symlink') {
        problems.add('T0002/hq_cache 是符号链接/junction，按策略不检查，权息与名称未确认')
      } else if (hqCache.kind === 'error') {
        noteAccessError(access, hqCache.code)
        problems.add(`T0002/hq_cache 无法访问（${hqCache.code}），权息与名称未确认`)
      } else if (hqCache.kind === 'file' || hqCache.kind === 'other') {
        problems.add('T0002/hq_cache 不是目录，权息与名称未确认')
      } else {
        problems.add('缺少 T0002/hq_cache 目录，权息与名称文件缺失')
      }
    }
    const hasAdjustment = hqUsable ? await checkAdjustment(absolute, problems, access) : false
    const hasNames = hqUsable ? await checkNames(absolute, problems, access) : false
    const hasBenchmark = vipdoc.kind === 'dir' ? await checkBenchmark(absolute, problems, access) : false

    return {
      root: absolute,
      recognized: true,
      readable: !access.sawAccessError,
      dailyFileCount: scan.count,
      latestDate: scan.latest,
      hasAdjustment,
      hasNames,
      hasBenchmark,
      problems: problems.finish(),
    }
  } catch (error) {
    problems.add(`检查过程发生未预期错误：${error instanceof Error ? error.message : String(error)}`)
    return { ...emptyCheck(absolute, problems.finish()), readable: false }
  }
}

export async function inspectTdxCandidates(roots: readonly string[]): Promise<TdxCandidateCheck[]> {
  const seen = new Set<string>()
  const results: TdxCandidateCheck[] = []
  for (const input of roots) {
    const normalized = normalizeRoot(input)
    const key = normalized.ok ? normalized.absolute : `invalid:${input.trim()}`
    const dedupeKey = process.platform === 'win32' ? key.toLowerCase() : key
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    results.push(await inspectTdxCandidate(input))
  }
  return results
}
