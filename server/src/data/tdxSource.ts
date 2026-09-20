// TDX 本地数据源：包装 tdx/catalog、tdx/dayfile、tdx/adjustment-cache 的扫描能力。
// 只 import 这些正被并行开发/视为稳定 API 的模块，不修改它们。
// 稳定读取：单文件读取前后 size/mtime 必须一致、字节数必须是 32 的整数倍；
// 失败有限重试一次，仍不稳定则抛错（中文 message 指明文件），绝不返回部分结果。

import { access, readdir, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { readLastDayDate } from '../tdx/dayfile.js'
import { codeFromDayFile } from '../tdx/names.js'
import { isAShareCode, type TdxMarket } from '../tdx/stocks.js'
import { diffAgainstBaseline } from './source.js'
import type { DailySource, ScanBaseline, ScannedFileState, ScanOutcome } from './source.js'

const MARKETS: TdxMarket[] = ['sh', 'sz', 'bj']
const RECORD_SIZE = 32
const STABLE_READ_RETRIES = 1

export const TDX_SOURCE_NAME = '通达信本地数据'

export function createTdxSource(tdxRoot: string | null): DailySource {
  return {
    kind: 'tdx',
    name: TDX_SOURCE_NAME,
    available: () => isTdxAvailable(tdxRoot),
    scan: previous => scanTdx(tdxRoot, previous),
  }
}

/** 廉价检查：tdxRoot 可发现且 vipdoc 目录可访问 */
async function isTdxAvailable(tdxRoot: string | null): Promise<boolean> {
  if (!tdxRoot) return false
  try {
    await access(join(tdxRoot, 'vipdoc'))
    return true
  } catch {
    return false
  }
}

async function scanTdx(tdxRoot: string | null, previous?: ScanBaseline): Promise<ScanOutcome> {
  if (!tdxRoot) throw new Error('未检测到通达信数据目录（tdxRoot 为空），请先确认通达信安装路径')
  const files: ScannedFileState[] = []
  for (const market of MARKETS) {
    const marketDir = join(tdxRoot, 'vipdoc', market)
    try {
      await readdir(marketDir)
    } catch (error) {
      // 市场目录整体不存在＝该市场没有数据，属正常；存在但不可读＝磁盘/权限故障，任务失败
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`无法读取通达信市场目录 ${marketDir}：${describeFsError(error)}，请检查磁盘与权限后重试`)
    }
    const ldayDir = join(marketDir, 'lday')
    let dayFiles: string[]
    try {
      dayFiles = await readdir(ldayDir)
    } catch (error) {
      throw new Error(`无法读取通达信日线目录 ${ldayDir}：${describeFsError(error)}，请检查磁盘与权限后重试`)
    }
    for (const file of dayFiles.filter(item => item.toLowerCase().endsWith('.day'))) {
      const code = codeFromDayFile(file)
      if (!code || !isAShareCode(market, code)) continue
      const filePath = join(ldayDir, file)
      files.push(await readStableFileState(filePath, previous?.get(filePath)))
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const counts = diffAgainstBaseline(previous, files)
  const sourceMaxDate = files.reduce<string | null>((max, file) =>
    file.maxDate && (!max || file.maxDate > max) ? file.maxDate : max, null)
  return {
    kind: 'tdx',
    name: TDX_SOURCE_NAME,
    totalStocks: files.length,
    ...counts,
    sourceMaxDate,
    files,
  }
}

/** 逐文件稳定读取：size+mtime 未变化直接沿用上次结果；否则读前读后双校验。 */
async function readStableFileState(filePath: string, previous: ScannedFileState | undefined): Promise<ScannedFileState> {
  const info = await statFileOrThrow(filePath)
  if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
    return { path: filePath, size: info.size, mtimeMs: info.mtimeMs, maxDate: previous.maxDate, rows: previous.rows }
  }
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= STABLE_READ_RETRIES; attempt += 1) {
    try {
      const before = await statFileOrThrow(filePath)
      if (before.size % RECORD_SIZE !== 0) {
        throw new Error(`文件大小 ${before.size} 字节不是 ${RECORD_SIZE} 的整数倍（记录可能只写入了一半）`)
      }
      const maxDate = await readLastDayDate(filePath)
      const after = await statFileOrThrow(filePath)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('读取前后文件大小或修改时间发生变化（文件可能仍在写入）')
      }
      return { path: filePath, size: after.size, mtimeMs: after.mtimeMs, maxDate, rows: after.size / RECORD_SIZE }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`读取日线文件失败：${filePath} —— ${lastError?.message ?? '未知原因'}。文件可能正被通达信写入或已损坏，请稍后重试`)
}

async function statFileOrThrow(filePath: string): Promise<Stats> {
  try {
    return await stat(filePath)
  } catch (error) {
    throw new Error(`无法读取日线文件信息：${filePath} —— ${describeFsError(error)}。文件可能在扫描过程中被移动或删除，请确认通达信数据目录完整后重试`)
  }
}

function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code) return `错误码 ${code}`
  return error instanceof Error ? error.message : String(error)
}
