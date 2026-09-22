import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectTdxCandidate, inspectTdxCandidates } from '../src/tdx/inspect.js'

const DAY_RECORD = 32
const GBBQ_RECORD = 29
const onWindows = process.platform === 'win32'
const canSimulateAccessError = onWindows || (typeof process.getuid === 'function' && process.getuid() !== 0)

function dayRecord(date: string): Buffer {
  const buffer = Buffer.alloc(DAY_RECORD)
  buffer.writeInt32LE(Number(date.replaceAll('-', '')), 0)
  buffer.writeInt32LE(1050, 4)
  buffer.writeInt32LE(1100, 8)
  buffer.writeInt32LE(1000, 12)
  buffer.writeInt32LE(1080, 16)
  buffer.writeFloatLE(123456.5, 20)
  buffer.writeInt32LE(8800, 24)
  return buffer
}

function rawDayRecord(dateValue: number): Buffer {
  const buffer = Buffer.alloc(DAY_RECORD)
  buffer.writeInt32LE(dateValue, 0)
  return buffer
}

function dayFile(...dates: string[]): Buffer {
  return Buffer.concat(dates.map(dayRecord))
}

function gbbqFile(recordCount: number): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(recordCount, 0)
  return Buffer.concat([header, Buffer.alloc(recordCount * GBBQ_RECORD, 7)])
}

async function writeTdxScaffold(root: string): Promise<void> {
  await mkdir(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true })
  await mkdir(join(root, 'vipdoc', 'sz', 'lday'), { recursive: true })
  await mkdir(join(root, 'vipdoc', 'bj', 'lday'), { recursive: true })
  await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
}

async function writeCompleteFixture(root: string): Promise<void> {
  await writeTdxScaffold(root)
  await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600600.day'), dayFile('2024-01-04', '2024-01-05'))
  await writeFile(join(root, 'vipdoc', 'sz', 'lday', 'sz000001.day'), dayFile('2024-03-08'))
  await writeFile(join(root, 'vipdoc', 'bj', 'lday', 'bj920001.day'), dayFile('2024-02-01'))
  await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh000300.day'), dayFile('2024-03-08'))
  await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbqFile(1))
  await writeFile(join(root, 'T0002', 'hq_cache', 'shs.tnf'), Buffer.alloc(64, 1))
}

async function inTempDir(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const lines: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = join(dir, entry.name)
    const info = await stat(full)
    if (entry.isDirectory()) {
      lines.push(`${full}/:${info.size}:${info.mtimeMs}`)
      lines.push(...await snapshot(full))
    } else {
      lines.push(`${full}:${info.size}:${info.mtimeMs}`)
    }
  }
  return lines.sort()
}

async function createLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, onWindows ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

// 受控制造读取拒绝：Windows 用 icacls 拒绝读数据（保留属性使 lstat 仍可用），POSIX 去掉权限位
async function denyRead(path: string): Promise<boolean> {
  if (onWindows) {
    const result = spawnSync('icacls', [path, '/deny', '*S-1-1-0:(RD)'], { encoding: 'utf8' })
    return result.status === 0
  }
  try {
    await chmod(path, 0o000)
    return true
  } catch {
    return false
  }
}

async function restoreRead(path: string): Promise<void> {
  if (onWindows) {
    spawnSync('icacls', [path, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' })
    return
  }
  await chmod(path, 0o644)
}

describe('inspectTdxCandidate', () => {
  it('reports a complete candidate as usable', async () => {
    await inTempDir('tdx-inspect-full-', async root => {
      await writeCompleteFixture(root)
      const check = await inspectTdxCandidate(root)
      expect(check.root).toBe(root)
      expect(check.recognized).toBe(true)
      expect(check.readable).toBe(true)
      expect(check.dailyFileCount).toBe(3)
      expect(check.latestDate).toBe('2024-03-08')
      expect(check.hasAdjustment).toBe(true)
      expect(check.hasNames).toBe(true)
      expect(check.hasBenchmark).toBe(true)
      expect(check.problems).toEqual([])
    })
  })

  it('does not modify the candidate directory', async () => {
    await inTempDir('tdx-inspect-readonly-', async root => {
      await writeCompleteFixture(root)
      const before = await snapshot(root)
      await inspectTdxCandidate(root)
      const after = await snapshot(root)
      expect(after).toEqual(before)
    })
  })

  it('reports an empty directory as not a TDX install', async () => {
    await inTempDir('tdx-inspect-empty-', async root => {
      const check = await inspectTdxCandidate(root)
      expect(check.readable).toBe(true)
      expect(check.recognized).toBe(false)
      expect(check.dailyFileCount).toBe(0)
      expect(check.problems.join('\n')).toMatch(/vipdoc|T0002/)
    })
  })

  it('distinguishes a recognized but empty install from a missing one', async () => {
    await inTempDir('tdx-inspect-bare-', async root => {
      await writeTdxScaffold(root)
      const check = await inspectTdxCandidate(root)
      expect(check.recognized).toBe(true)
      expect(check.readable).toBe(true)
      expect(check.dailyFileCount).toBe(0)
      expect(check.latestDate).toBeNull()
      expect(check.problems.join('\n')).toMatch(/不能用于训练|没有可用的/)
    })
  })

  it('reports a missing root as unreadable', async () => {
    await inTempDir('tdx-inspect-missing-', async root => {
      const check = await inspectTdxCandidate(join(root, 'not-here'))
      expect(check.readable).toBe(false)
      expect(check.recognized).toBe(false)
      expect(check.problems.join('\n')).toMatch(/不存在/)
    })
  })

  it('reports a plain file root as not a directory', async () => {
    await inTempDir('tdx-inspect-file-', async root => {
      const filePath = join(root, 'plain.txt')
      await writeFile(filePath, 'x')
      const check = await inspectTdxCandidate(filePath)
      expect(check.readable).toBe(false)
      expect(check.problems.join('\n')).toMatch(/不是目录/)
    })
  })

  it('rejects empty and relative paths without touching the filesystem', async () => {
    const emptyCheck = await inspectTdxCandidate('')
    expect(emptyCheck.readable).toBe(false)
    expect(emptyCheck.problems.join('\n')).toMatch(/为空/)

    const blankCheck = await inspectTdxCandidate('   ')
    expect(blankCheck.problems.join('\n')).toMatch(/为空/)

    const relativeCheck = await inspectTdxCandidate('some' + '\\' + 'relative' + '\\' + 'tdx')
    expect(relativeCheck.readable).toBe(false)
    expect(relativeCheck.recognized).toBe(false)
    expect(relativeCheck.dailyFileCount).toBe(0)
    expect(relativeCheck.problems.join('\n')).toMatch(/绝对路径/)
  })

  it.skipIf(!onWindows)('rejects UNC and device paths on Windows', async () => {
    const uncCheck = await inspectTdxCandidate('\\\\server\\share\\tdx')
    expect(uncCheck.readable).toBe(false)
    expect(uncCheck.problems.join('\n')).toMatch(/UNC/)

    const deviceCheck = await inspectTdxCandidate('\\\\.\\pipe\\tdx')
    expect(deviceCheck.readable).toBe(false)
    expect(deviceCheck.problems.join('\n')).toMatch(/设备/)

    const reservedCheck = await inspectTdxCandidate('C:\\CON\\tdx')
    expect(reservedCheck.readable).toBe(false)
    expect(reservedCheck.problems.join('\n')).toMatch(/保留设备名/)
  })

  it('refuses to follow a symlink/junction root', async () => {
    await inTempDir('tdx-inspect-link-', async outer => {
      const real = join(outer, 'real')
      await writeCompleteFixture(real)
      const link = join(outer, 'link')
      try {
        await symlink(real, link, onWindows ? 'junction' : 'dir')
      } catch {
        console.warn('skipping symlink-root test: link creation not permitted here')
        return
      }
      const check = await inspectTdxCandidate(link)
      expect(check.readable).toBe(false)
      expect(check.recognized).toBe(false)
      expect(check.problems.join('\n')).toMatch(/符号链接|junction/i)
    })
  })

  it('refuses roots whose ancestor segments contain a junction', async () => {
    await inTempDir('tdx-inspect-ancestor-', async outer => {
      const real = join(outer, 'real')
      await writeCompleteFixture(real)
      const rootLink = join(outer, 'root-link')
      if (await createLink(real, rootLink)) {
        const check = await inspectTdxCandidate(rootLink)
        expect(check.readable).toBe(false)
        expect(check.recognized).toBe(false)
        expect(check.dailyFileCount).toBe(0)
        expect(check.hasAdjustment).toBe(false)
        expect(check.hasNames).toBe(false)
        expect(check.problems.join('\n')).toMatch(/符号链接|junction/i)
      }

      const nested = join(real, 'nested-install')
      await writeCompleteFixture(nested)
      const ancestorLink = join(outer, 'ancestor-link')
      if (await createLink(real, ancestorLink)) {
        const check = await inspectTdxCandidate(join(ancestorLink, 'nested-install'))
        expect(check.readable).toBe(false)
        expect(check.recognized).toBe(false)
        expect(check.dailyFileCount).toBe(0)
        expect(check.hasAdjustment).toBe(false)
        expect(check.hasNames).toBe(false)
        expect(check.problems.join('\n')).toMatch(/符号链接|junction/i)
      }
    })
  })

  it('does not follow a junction at T0002 for adjustment and names', async () => {
    await inTempDir('tdx-inspect-t0002-', async outer => {
      const root = join(outer, 'install')
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600600.day'), dayFile('2024-01-05'))
      const external = join(outer, 'external-data')
      await mkdir(join(external, 'hq_cache'), { recursive: true })
      await writeFile(join(external, 'hq_cache', 'gbbq'), gbbqFile(1))
      await writeFile(join(external, 'hq_cache', 'shs.tnf'), Buffer.alloc(64, 1))
      await rm(join(root, 'T0002'), { recursive: true, force: true })
      if (!(await createLink(external, join(root, 'T0002')))) return
      const check = await inspectTdxCandidate(root)
      expect(check.recognized).toBe(true)
      expect(check.readable).toBe(true)
      expect(check.dailyFileCount).toBe(1)
      expect(check.hasAdjustment).toBe(false)
      expect(check.hasNames).toBe(false)
      const all = check.problems.join('\n')
      expect(all).toMatch(/T0002/)
      expect(all).toMatch(/符号链接|junction/i)
    })
  })

  it('does not follow a junction at vipdoc/sh when scanning that market', async () => {
    await inTempDir('tdx-inspect-marketlink-', async outer => {
      const root = join(outer, 'install')
      await mkdir(join(root, 'vipdoc', 'sz', 'lday'), { recursive: true })
      await mkdir(join(root, 'vipdoc', 'bj', 'lday'), { recursive: true })
      await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
      await writeFile(join(root, 'vipdoc', 'sz', 'lday', 'sz000001.day'), dayFile('2024-03-08'))
      await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbqFile(1))
      await writeFile(join(root, 'T0002', 'hq_cache', 'shs.tnf'), Buffer.alloc(64, 1))
      const external = join(outer, 'external-sh')
      await mkdir(join(external, 'lday'), { recursive: true })
      await writeFile(join(external, 'lday', 'sh600600.day'), dayFile('2024-01-05'))
      await writeFile(join(external, 'lday', 'sh000300.day'), dayFile('2024-03-08'))
      await rm(join(root, 'vipdoc', 'sh'), { recursive: true, force: true })
      if (!(await createLink(external, join(root, 'vipdoc', 'sh')))) return
      const check = await inspectTdxCandidate(root)
      expect(check.recognized).toBe(true)
      expect(check.readable).toBe(true)
      expect(check.dailyFileCount).toBe(1)
      expect(check.latestDate).toBe('2024-03-08')
      expect(check.hasBenchmark).toBe(false)
      expect(check.hasAdjustment).toBe(true)
      expect(check.hasNames).toBe(true)
      const all = check.problems.join('\n')
      expect(all).toMatch(/vipdoc\/sh|市场 sh/)
      expect(all).toMatch(/符号链接|junction/i)
    })
  })

  it.skipIf(!canSimulateAccessError)('reports access-denied data as unreadable instead of absent', async () => {
    await inTempDir('tdx-inspect-eacces-', async root => {
      await writeCompleteFixture(root)
      const dayPath = join(root, 'vipdoc', 'sh', 'lday', 'sh600600.day')
      expect(await denyRead(dayPath)).toBe(true)
      try {
        const dayCheck = await inspectTdxCandidate(root)
        expect(dayCheck.recognized).toBe(true)
        expect(dayCheck.readable).toBe(false)
        expect(dayCheck.dailyFileCount).toBe(2)
        expect(dayCheck.latestDate).toBe('2024-03-08')
        expect(dayCheck.hasAdjustment).toBe(true)
        const all = dayCheck.problems.join('\n')
        expect(all).toMatch(/sh600600\.day/)
        expect(all).toMatch(/EACCES|EPERM/)
      } finally {
        await restoreRead(dayPath)
      }

      const namesPath = join(root, 'T0002', 'hq_cache', 'shs.tnf')
      expect(await denyRead(namesPath)).toBe(true)
      try {
        const namesCheck = await inspectTdxCandidate(root)
        expect(namesCheck.recognized).toBe(true)
        expect(namesCheck.readable).toBe(false)
        expect(namesCheck.hasNames).toBe(false)
        expect(namesCheck.dailyFileCount).toBe(3)
        const all = namesCheck.problems.join('\n')
        expect(all).toMatch(/名称/)
        expect(all).toMatch(/EACCES|EPERM/)
      } finally {
        await restoreRead(namesPath)
      }
    })
  })

  it('does not count day files whose prefix disagrees with the market directory', async () => {
    await inTempDir('tdx-inspect-prefix-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sz600000.day'), dayFile('2024-01-05'))
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600001.day'), dayFile('2024-01-04'))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(1)
      expect(check.latestDate).toBe('2024-01-04')
      expect(check.problems.join('\n')).toMatch(/sz600000/)
    })
  })

  it('excludes malformed day files but keeps valid ones', async () => {
    await inTempDir('tdx-inspect-badlen-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600001.day'), Buffer.concat([dayFile('2024-01-05'), Buffer.alloc(10)]))
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600002.day'), dayFile('2024-01-04', '2024-01-05'))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(1)
      expect(check.latestDate).toBe('2024-01-05')
      expect(check.problems.join('\n')).toMatch(/32/)
      expect(check.problems.join('\n')).toMatch(/sh600001\.day/)
    })
  })

  it('excludes day files whose last record date is invalid', async () => {
    await inTempDir('tdx-inspect-baddate-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sz', 'lday', 'sz000002.day'), rawDayRecord(0))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(0)
      expect(check.latestDate).toBeNull()
      expect(check.problems.join('\n')).toMatch(/日期/)
    })
  })

  it('excludes day files stored in descending date order', async () => {
    await inTempDir('tdx-inspect-order-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600003.day'), dayFile('2024-02-01', '2024-01-01'))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(0)
      expect(check.problems.join('\n')).toMatch(/升序/)
    })
  })

  it('does not count empty day files as usable data', async () => {
    await inTempDir('tdx-inspect-zeroday-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600004.day'), Buffer.alloc(0))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(0)
      expect(check.latestDate).toBeNull()
      expect(check.problems.join('\n')).toMatch(/空文件|没有可用/)
    })
  })

  it('ignores non-A-share day files without flagging them', async () => {
    await inTempDir('tdx-inspect-index-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh999999.day'), dayFile('2024-01-05'))
      await writeFile(join(root, 'vipdoc', 'sz', 'lday', 'sz399001.day'), dayFile('2024-01-05'))
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'shABCDEF.day'), Buffer.alloc(32))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(0)
      expect(check.problems.join('\n')).toMatch(/没有可用的|不能用于训练/)
      expect(check.problems.join('\n')).not.toMatch(/999999|399001|ABCDEF/)
    })
  })

  it('keeps counting other markets when one market directory is broken', async () => {
    await inTempDir('tdx-inspect-market-', async root => {
      await writeTdxScaffold(root)
      await rm(join(root, 'vipdoc', 'sz', 'lday'), { recursive: true })
      await writeFile(join(root, 'vipdoc', 'sz', 'lday'), 'not a directory')
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600005.day'), dayFile('2024-01-05'))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(1)
      expect(check.latestDate).toBe('2024-01-05')
      expect(check.problems.join('\n')).toMatch(/sz/)
    })
  })

  it('reports missing companion data separately', async () => {
    await inTempDir('tdx-inspect-companion-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600006.day'), dayFile('2024-01-05'))
      const check = await inspectTdxCandidate(root)
      expect(check.hasAdjustment).toBe(false)
      expect(check.hasNames).toBe(false)
      expect(check.hasBenchmark).toBe(false)
      const all = check.problems.join('\n')
      expect(all).toMatch(/gbbq/)
      expect(all).toMatch(/名称/)
      expect(all).toMatch(/基准|sh000300/)
    })
  })

  it('rejects an empty or inconsistent gbbq file', async () => {
    await inTempDir('tdx-inspect-gbbq-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), Buffer.alloc(0))
      const emptyCheck = await inspectTdxCandidate(root)
      expect(emptyCheck.hasAdjustment).toBe(false)
      expect(emptyCheck.problems.join('\n')).toMatch(/为空|记录头/)

      await writeFile(join(root, 'T0002', 'hq_cache', 'gbbq'), gbbqFile(5).subarray(0, 4 + 2 * GBBQ_RECORD))
      const inconsistentCheck = await inspectTdxCandidate(root)
      expect(inconsistentCheck.hasAdjustment).toBe(false)
      expect(inconsistentCheck.problems.join('\n')).toMatch(/不一致|损坏/)
    })
  })

  it('treats an empty names file without fallback as no names', async () => {
    await inTempDir('tdx-inspect-names-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'T0002', 'hq_cache', 'shs.tnf'), Buffer.alloc(0))
      const check = await inspectTdxCandidate(root)
      expect(check.hasNames).toBe(false)
      expect(check.problems.join('\n')).toMatch(/名称/)
    })
  })

  it('matches uppercase day file names but not non-.day suffixes', async () => {
    await inTempDir('tdx-inspect-case-', async root => {
      await writeTdxScaffold(root)
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'SH600519.DAY'), dayFile('2024-01-05'))
      await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day.txt'), dayFile('2024-01-05'))
      const check = await inspectTdxCandidate(root)
      expect(check.dailyFileCount).toBe(1)
      expect(check.latestDate).toBe('2024-01-05')
    })
  })
})

describe('inspectTdxCandidates', () => {
  it.skipIf(!onWindows)('deduplicates candidates case-insensitively on Windows', async () => {
    await inTempDir('tdx-inspect-dedupe-', async root => {
      await writeCompleteFixture(root)
      const flipped = root.replace(/([a-z])(?=[^\\]*$)/, c => c.toUpperCase())
      const results = await inspectTdxCandidates([root, flipped, root])
      expect(results).toHaveLength(1)
      expect(results[0].dailyFileCount).toBe(3)
    })
  })

  it('keeps order and does not let invalid candidates block valid ones', async () => {
    await inTempDir('tdx-inspect-order2-', async root => {
      await writeCompleteFixture(root)
      const results = await inspectTdxCandidates(['', join(root, 'missing'), root, 'relative\\tdx'])
      expect(results).toHaveLength(4)
      expect(results[0].problems.join('\n')).toMatch(/为空/)
      expect(results[1].problems.join('\n')).toMatch(/不存在/)
      expect(results[2].recognized).toBe(true)
      expect(results[2].dailyFileCount).toBe(3)
      expect(results[3].problems.join('\n')).toMatch(/绝对路径/)
    })
  })
})
