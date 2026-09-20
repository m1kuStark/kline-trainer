import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTdxRoot } from '../src/tdx/discover.js'

describe('TDX path discovery', () => {
  it('accepts a directory with vipdoc day data and hq_cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tdx-discover-'))
    await mkdir(join(root, 'vipdoc', 'sh', 'lday'), { recursive: true })
    await mkdir(join(root, 'T0002', 'hq_cache'), { recursive: true })
    await writeFile(join(root, 'vipdoc', 'sh', 'lday', 'sh600519.day'), Buffer.alloc(32))

    try {
      await expect(discoverTdxRoot([root])).resolves.toMatchObject({ root, source: 'candidate' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns null when directory characteristics do not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'not-tdx-'))
    try {
      await expect(discoverTdxRoot([root])).resolves.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
