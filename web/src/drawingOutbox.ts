import type { Drawing } from './drawingState'

export class DrawingOutbox {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly key: string,
  ) {}

  read(): Drawing[] | null {
    const raw = this.storage.getItem(this.key)
    if (raw === null) return null
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('Invalid drawing recovery data: malformed JSON')
    }
    if (!Array.isArray(value) || !value.every(isDrawing)) throw new Error('Invalid drawing recovery data: expected drawings with timestamp anchors')
    return value
  }

  write(drawings: Drawing[]): void {
    this.storage.setItem(this.key, JSON.stringify(drawings))
  }

  acknowledge(snapshot: Drawing[]): void {
    if (this.storage.getItem(this.key) === JSON.stringify(snapshot)) this.storage.removeItem(this.key)
  }
}

function isDrawing(value: unknown): value is Drawing {
  if (!isRecord(value) || !['id', 'name', 'paneId'].every(key => typeof value[key] === 'string' && value[key].trim().length > 0)) return false
  return Array.isArray(value.points) && value.points.length > 0 && value.points.every(point =>
    isRecord(point) && typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) &&
    typeof point.value === 'number' && Number.isFinite(point.value),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
