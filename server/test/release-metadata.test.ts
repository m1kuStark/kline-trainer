import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAppInfo } from '../src/recording-context.js'

describe('portable release recording provenance', () => {
  it('uses the packaged build identity without a Git checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trainer-release-meta-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }))
      await writeFile(join(root, 'release.json'), JSON.stringify({ appId: 'a-share-kline-trainer', version: '0.3.0', gitCommit: 'a'.repeat(40) }))
      expect(readAppInfo(root)).toEqual({ version: '0.3.0', gitCommit: 'a'.repeat(40), dirty: false })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('does not accept unrelated, mismatched or invalid release metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trainer-release-meta-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }))
      for (const metadata of [
        { appId: 'other', version: '0.3.0', gitCommit: 'a'.repeat(40) },
        { appId: 'a-share-kline-trainer', version: '0.2.0', gitCommit: 'a'.repeat(40) },
        { appId: 'a-share-kline-trainer', version: '0.3.0', gitCommit: 'not-a-sha' },
      ]) {
        await writeFile(join(root, 'release.json'), JSON.stringify(metadata))
        expect(readAppInfo(root).gitCommit).toBe('unknown')
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
