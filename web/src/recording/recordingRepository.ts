import { compactRecording } from './compactCodec'
import { validateCompactRecording } from './compactValidation'
import { IndexedDbCompactStorage } from './compactStorage'
import type { CompactRecordingFile } from './compactTypes'
import { validateRecording } from './validation'

export const recordingStorage = new IndexedDbCompactStorage()

/** Migrate on demand, retaining the original v1 row until the v2 transaction succeeds. */
export async function loadLocalRecording(id: string): Promise<CompactRecordingFile | null> {
  const current = await recordingStorage.load(id)
  if (current) return validateCompactRecording(current)
  const legacy = await recordingStorage.loadLegacy(id)
  if (!legacy) return null
  const migrated = validateCompactRecording(compactRecording(validateRecording(legacy, { maxCheckpoints: 20_000 })))
  await recordingStorage.save(migrated)
  return migrated
}
