import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import type { RecordingFile } from '../web/src/recording/types'
import type { CompactRecordingFile } from '../web/src/recording/compactTypes'

/** Test-side inspection only; browser import must exercise its own validation and decoder. */
export async function readRecordingArtifact(path: string): Promise<RecordingFile | CompactRecordingFile> {
  const bytes = await readFile(path)
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
  return JSON.parse(text)
}
