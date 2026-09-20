import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTnfFile } from '../src/tdx/names.js'

describe('TDX TNF names', () => {
  it('reads a GBK stock name at the byte offset used by the local TNF files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnf-name-'))
    const file = join(dir, 'shs.tnf')
    const buffer = Buffer.alloc(180)
    buffer.write('600519', 50, 'ascii')
    Buffer.from('b9f3d6ddc3a9cca8', 'hex').copy(buffer, 81)
    await writeFile(file, buffer)

    try {
      await expect(parseTnfFile(file, 'sh')).resolves.toContainEqual({ code: '600519', market: 'sh', name: '贵州茅台' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
