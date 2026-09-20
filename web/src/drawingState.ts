import type { DrawingPriceBasis } from './drawingPriceBasis'
import { adoptDrawings } from './drawingPriceBasis'

export interface Drawing {
  id: string
  name: string
  paneId: string
  points: Array<{ timestamp: number; value: number }>
  styles?: Record<string, unknown>
  extendData?: unknown
  /** 画线数值所属的前复权基准（显示价 = 原始价 * scale + offset）；旧画线缺省 */
  priceBasis?: DrawingPriceBasis
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function applyDrawingPrices<T extends { value?: number }>(points: T[], values: number[], name: string): T[] {
  return points.map((point, index) => ({ ...point, value: values[name.startsWith('horizontal') ? 0 : index] }))
}

// priceBasis：当前渲染基准。所有在图数值都已对齐该基准（载入时投影/采用），序列化随行盖印，
// 保存、outbox、历史快照据此在基准变化后正确再投影；缺省（基准未知）不写字段＝旧格式兼容。
export function serializeDrawings(overlays: unknown[], paneName: (id: string) => string, priceBasis?: DrawingPriceBasis): Drawing[] {
  return overlays.flatMap(value => {
    const overlay = value as Drawing & { isDrawing?: () => boolean }
    if (['bsMark', 'costLine'].includes(overlay.name) || overlay.isDrawing?.()) return []
    const points = overlay.points.map(({ timestamp, value }) => ({ timestamp, value }))
    if (!points.length || points.some(point => !Number.isFinite(point.timestamp) || !Number.isFinite(point.value))) return []
    const drawing: Drawing = { id: overlay.id, name: overlay.name, paneId: paneName(overlay.paneId), points }
    if (priceBasis) drawing.priceBasis = { ...priceBasis }
    if (overlay.styles && Object.keys(overlay.styles).length) drawing.styles = copy(overlay.styles)
    if (overlay.extendData !== undefined && overlay.extendData !== null) drawing.extendData = copy(overlay.extendData)
    return [drawing]
  }).sort((a, b) => a.id.localeCompare(b.id))
}

export class DrawingHistory {
  private states: Drawing[][] = [[]]
  private index = 0
  get canUndo(): boolean { return this.index > 0 }
  get canRedo(): boolean { return this.index < this.states.length - 1 }
  reset(drawings: Drawing[]): void { this.states = [copy(drawings)]; this.index = 0 }
  rebasePriceBasis(basis: DrawingPriceBasis): void {
    // A market basis change is not a user edit. Keep all undo/redo states in the
    // rendered basis so a later pointer-up cannot record a phantom edit.
    this.states = this.states.map(state => adoptDrawings(state, basis))
  }
  record(drawings: Drawing[]): boolean {
    if (JSON.stringify(drawings) === JSON.stringify(this.states[this.index])) return false
    this.states = this.states.slice(0, this.index + 1)
    this.states.push(copy(drawings))
    if (this.states.length > 100) this.states.shift()
    this.index = this.states.length - 1
    return true
  }
  undo(): Drawing[] | null { return this.canUndo ? copy(this.states[--this.index]) : null }
  redo(): Drawing[] | null { return this.canRedo ? copy(this.states[++this.index]) : null }
}

export class SerialDrawingSaver {
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly write: (drawings: Drawing[]) => Promise<void>) {}
  save(drawings: Drawing[]): Promise<void> {
    const snapshot = copy(drawings)
    const current = this.pending.catch(() => {}).then(() => this.write(snapshot))
    this.pending = current
    return current
  }
}
