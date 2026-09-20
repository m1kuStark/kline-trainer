import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { discoverTdxRoot, defaultTdxCandidates } from '../../server/src/tdx/discover.js'
import type { RunManifest } from './run.js'

export const SNAPSHOT_FILES = ['vipdoc/sh/lday/sh600519.day', 'vipdoc/sz/lday/sz300857.day',
  'vipdoc/sh/lday/sh000300.day', 'T0002/hq_cache/gbbq', 'T0002/hq_cache/shs.tnf', 'T0002/hq_cache/szs.tnf']

export async function snapshotTdx(source: string, destination: string, cutoff = 20260916) {
  try { await access(destination); throw new Error(`Snapshot already exists: ${destination}`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const pending = `${destination}.partial-${randomUUID()}`
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  try {
    for (const path of SNAPSHOT_FILES) {
      const origin = join(source, path), before = await stat(origin)
      let bytes = await readFile(origin)
      const after = await stat(origin)
      if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`Source changed while reading: ${path}`)
      }
      if (path.endsWith('.day')) {
        if (!bytes.length || bytes.length % 32) throw new Error(`Invalid 32-byte day records: ${path}`)
        let length = 0, previous = 0
        for (let offset = 0; offset < bytes.length; offset += 32) {
          const date = bytes.readUInt32LE(offset)
          if (date <= previous) throw new Error(`Unsorted day records: ${path}`)
          previous = date
          if (date <= cutoff) length = offset + 32
        }
        bytes = bytes.subarray(0, length)
        if (!bytes.length) throw new Error(`No bars before cutoff: ${path}`)
      }
      const target = join(pending, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const date = String(cutoff)
    const manifest = { schemaVersion: 1, kind: 'tdx-browser-sample', cutoff: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`, files }
    await writeFile(join(pending, 'snapshot.json'), JSON.stringify(manifest, null, 2))
    await rename(pending, destination)
    return manifest
  } finally { await rm(pending, { recursive: true, force: true }) }
}

/** Freeze the existing real-data browser samples; no download and no source writes. */
export async function prepareJourneySnapshot(run: RunManifest): Promise<void> {
  const explicit = run.tdxRoot ?? process.env.TDX_ROOT
  const discovered = await discoverTdxRoot(explicit ? [explicit] : defaultTdxCandidates())
  if (!discovered) throw new Error('Journey needs a readable TDX sample source; set TDX_ROOT. No download was attempted.')
  const target = resolve(run.runDir, 'tdx-snapshot')
  await snapshotTdx(discovered.root, target)
  run.tdxRoot = target
  await writeFile(run.manifestPath, JSON.stringify(run, null, 2))
}
