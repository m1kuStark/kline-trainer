import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotTdx, SNAPSHOT_FILES } from '../../scripts/runtime/snapshot.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'trainer-snapshot-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function bar(date: number) { const b = Buffer.alloc(32); b.writeUInt32LE(date); b.writeUInt32LE(1000, 4); return b }
async function source() {
  const dir = join(root, 'source')
  for (const file of SNAPSHOT_FILES) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), file.endsWith('.day') ? Buffer.concat([bar(20260911), bar(20260916), bar(20260917)]) : Buffer.from('fixture'))
  }
  return dir
}
it('freezes only the declared symbols through cutoff and fingerprints exactly the copied bytes', async () => {
  const src = await source(), dest = join(root, 'snapshot')
  const result = await snapshotTdx(src, dest, 20260916)
  expect(result.files).toHaveLength(6)
  expect((await readFile(join(dest, 'vipdoc/sh/lday/sh600519.day'))).length).toBe(64)
  expect((await readFile(join(src, 'vipdoc/sh/lday/sh600519.day'))).length).toBe(96)
  expect(result.cutoff).toBe('2026-09-16')
  expect(JSON.parse(await readFile(join(dest, 'snapshot.json'), 'utf8')).files).toEqual(result.files)
})
it('rejects a partial source record without publishing a snapshot or modifying source', async () => {
  const src = await source(), dest = join(root, 'bad')
  await writeFile(join(src, SNAPSHOT_FILES[0]), Buffer.alloc(33))
  await expect(snapshotTdx(src, dest, 20260916)).rejects.toThrow(/32|record/i)
  await expect(access(join(dest, 'snapshot.json'))).rejects.toThrow()
  expect((await readFile(join(src, SNAPSHOT_FILES[0]))).length).toBe(33)
})
it('never overwrites an existing snapshot', async () => {
  const src = await source(), dest = join(root, 'snapshot')
  await snapshotTdx(src, dest, 20260916)
  await expect(snapshotTdx(src, dest, 20260916)).rejects.toThrow(/exist/i)
})
