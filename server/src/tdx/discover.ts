import { access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface TdxDiscovery {
  root: string
  source: 'candidate' | 'manual'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function isTdxRoot(root: string): Promise<boolean> {
  const dayDirs = await Promise.all(['sh', 'sz', 'bj'].map(async market => {
    const directory = join(root, 'vipdoc', market, 'lday')
    if (!(await exists(directory))) return false
    const names = await readdir(directory).catch(() => [])
    return names.some(name => name.toLowerCase().endsWith('.day'))
  }))
  return dayDirs.some(Boolean) && await exists(join(root, 'T0002', 'hq_cache'))
}

export async function discoverTdxRoot(candidates: string[]): Promise<TdxDiscovery | null> {
  for (const candidate of candidates) {
    const root = resolve(candidate)
    if (await isTdxRoot(root)) return { root, source: 'candidate' }
  }
  return null
}

export function defaultTdxCandidates(): string[] {
  return [
    'D:\\MySoftWares\\TDX',
    'C:\\new_tdx',
    'C:\\通达信',
  ]
}
