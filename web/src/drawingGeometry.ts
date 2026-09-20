export interface DrawingCoordinate { x: number; y: number }
export interface DrawingBounds { left: number; right: number; top: number; bottom: number }
export interface DrawingGeometry {
  anchors: DrawingCoordinate[]
  segs: Array<[DrawingCoordinate, DrawingCoordinate]>
  polygon?: DrawingCoordinate[]
}

export interface DrawingArc {
  center: DrawingCoordinate
  radius: number
  startAngle: number
  sweepAngle: number
}

export interface TextAnnotationData {
  text: string
  color?: string
  size?: number
  bold?: boolean
  italic?: boolean
}

const TAU = Math.PI * 2
const finitePoint = (point: DrawingCoordinate) => Number.isFinite(point.x) && Number.isFinite(point.y)
const positiveAngle = (angle: number) => ((angle % TAU) + TAU) % TAU

function segments(points: DrawingCoordinate[], closed = false): DrawingGeometry['segs'] {
  const result: DrawingGeometry['segs'] = []
  for (let i = 1; i < points.length; i++) result.push([points[i - 1]!, points[i]!])
  if (closed && points.length > 1) result.push([points.at(-1)!, points[0]!])
  return result
}

export function arcThroughPoints(a: DrawingCoordinate, b: DrawingCoordinate, c: DrawingCoordinate): DrawingArc | null {
  if (![a, b, c].every(finitePoint)) return null
  // Translate and normalize before solving, avoiding cancellation far from the origin.
  const scale = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(c.x - a.x), Math.abs(c.y - a.y))
  if (!Number.isFinite(scale) || scale < 1e-8) return null
  const bx = (b.x - a.x) / scale
  const by = (b.y - a.y) / scale
  const cx = (c.x - a.x) / scale
  const cy = (c.y - a.y) / scale
  const determinant = 2 * (bx * cy - by * cx)
  if (Math.abs(determinant) < 1e-8) return null
  const bSquared = bx * bx + by * by
  const cSquared = cx * cx + cy * cy
  const offsetX = (cy * bSquared - by * cSquared) / determinant * scale
  const offsetY = (bx * cSquared - cx * bSquared) / determinant * scale
  const center = { x: a.x + offsetX, y: a.y + offsetY }
  const radius = Math.hypot(offsetX, offsetY)
  if (!finitePoint(center) || !Number.isFinite(radius)) return null
  const startAngle = Math.atan2(a.y - center.y, a.x - center.x)
  const endAngle = Math.atan2(c.y - center.y, c.x - center.x)
  const sweepAngle = determinant > 0 ? positiveAngle(endAngle - startAngle) : -positiveAngle(startAngle - endAngle)
  return { center, radius, startAngle, sweepAngle }
}

function curveSteps(radius: number, sweep: number): number {
  const stepAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.3 / Math.max(radius, 0.3))))
  return Math.min(2048, Math.max(8, Math.ceil(Math.abs(sweep) / Math.max(1e-4, stepAngle))))
}

function sampleArc(arc: DrawingArc, start: DrawingCoordinate, end: DrawingCoordinate, startAngle: number, sweep: number): DrawingCoordinate[] {
  const count = curveSteps(arc.radius, sweep)
  const result = [start]
  for (let i = 1; i < count; i++) {
    const angle = startAngle + sweep * i / count
    result.push({ x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) })
  }
  result.push(end)
  return result
}

function textWidth(text: string, size: number, factor = 1): number {
  return Array.from(text).reduce((sum, character) => {
    const unit = /[^\x00-\x7f]/.test(character) ? 1 : /[MW@%]/.test(character) ? 0.95 : 0.62
    return sum + unit * size
  }, 0) * factor
}

export function textAnnotationLayout(extendData?: unknown) {
  const data = extendData && typeof extendData === 'object' ? extendData as Partial<TextAnnotationData> : {}
  const size = typeof data.size === 'number' && Number.isFinite(data.size) ? Math.max(8, Math.min(72, data.size)) : 14
  const lines = (typeof data.text === 'string' ? data.text : '').replace(/\r\n?/g, '\n').split('\n')
  const lineHeight = size * 1.2
  const width = Math.max(size, ...lines.map(line => textWidth(line, size))) * (data.bold ? 1.08 : 1) * (data.italic ? 1.05 : 1)
  return { data, size, lines, lineHeight, width, height: lines.length * lineHeight }
}

function wrapTextLines(lines: string[], size: number, factor: number, maxWidth: number): string[] {
  return lines.flatMap(line => {
    const wrapped: string[] = []
    let current = ''
    let width = 0
    for (const character of Array.from(line)) {
      const characterWidth = textWidth(character, size, factor)
      if (current && width + characterWidth > maxWidth) {
        wrapped.push(current)
        current = ''
        width = 0
      }
      current += character
      width += characterWidth
    }
    wrapped.push(current)
    return wrapped
  })
}

export function boundedTextAnnotationLayout(anchor: DrawingCoordinate, bounds: DrawingBounds, extendData?: unknown) {
  if (!finitePoint(anchor) || !Object.values(bounds).every(Number.isFinite) ||
    anchor.x < bounds.left || anchor.x > bounds.right || anchor.y < bounds.top || anchor.y > bounds.bottom) return null
  const availableWidth = bounds.right - bounds.left
  const availableHeight = bounds.bottom - bounds.top
  if (availableWidth <= 0 || availableHeight < 8 * 1.2) return null
  const original = textAnnotationLayout(extendData)
  const factor = (original.data.bold ? 1.08 : 1) * (original.data.italic ? 1.05 : 1)
  let size = original.size
  let lines = wrapTextLines(original.lines, size, factor, availableWidth)
  while (size > 8 && lines.length * size * 1.2 > availableHeight) {
    size = Math.max(8, size - 1)
    lines = wrapTextLines(original.lines, size, factor, availableWidth)
  }
  const lineHeight = size * 1.2
  const maxLines = Math.max(1, Math.floor(availableHeight / lineHeight))
  const truncated = lines.length > maxLines
  if (truncated) {
    // Keep the complete note in extendData; only abbreviate an overfull on-chart label.
    lines = lines.slice(0, maxLines)
    const last = Array.from(lines[maxLines - 1]!)
    while (last.length && textWidth(`${last.join('')}...`, size, factor) > availableWidth) last.pop()
    lines[maxLines - 1] = `${last.join('')}...`
  }
  const width = Math.min(availableWidth, Math.max(size * factor, ...lines.map(line => textWidth(line, size, factor))))
  const height = lines.length * lineHeight
  const origin = {
    x: Math.max(bounds.left, Math.min(anchor.x, bounds.right - width)),
    y: Math.max(bounds.top, Math.min(anchor.y, bounds.bottom - height)),
  }
  return { ...original, size, lines, lineHeight, width, height, origin, truncated }
}

export function drawingFigureGeometry(name: string, points: DrawingCoordinate[], bounds: DrawingBounds, extendData?: unknown): DrawingGeometry {
  if (!points.length || !points.every(finitePoint)) return { anchors: [], segs: [] }
  const anchors = points.map(point => ({ ...point }))
  const [a, b, c] = anchors
  const result: DrawingGeometry = { anchors, segs: [] }
  if (!a) return result
  if (name === 'priceLine') {
    if (Number.isFinite(bounds.right) && a.x <= bounds.right) result.segs = [[a, { x: bounds.right, y: a.y }]]
  } else if (name === 'bullArrow' || name === 'bearArrow') {
    const baseY = a.y + (name === 'bullArrow' ? 14 : -14)
    result.polygon = [a, { x: a.x - 8, y: baseY }, { x: a.x + 8, y: baseY }]
    result.segs = segments(result.polygon, true)
  } else if (name === 'textAnnotation') {
    const layout = boundedTextAnnotationLayout(a, bounds, extendData)
    if (!layout) return { anchors: [], segs: [] }
    const origin = layout.origin
    result.polygon = [origin, { x: origin.x + layout.width, y: origin.y }, { x: origin.x + layout.width, y: origin.y + layout.height }, { x: origin.x, y: origin.y + layout.height }]
    result.segs = segments(result.polygon, true)
  } else if (name === 'polyline') {
    result.segs = segments(anchors)
  } else if (b) {
    if (name === 'rectangle') {
      result.segs = segments([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], true)
    } else if (name === 'circle') {
      const radius = Math.hypot(b.x - a.x, b.y - a.y) / 2
      if (radius < 1e-8) result.segs = [[a, b]]
      else {
        const center = { x: a.x + (b.x - a.x) / 2, y: a.y + (b.y - a.y) / 2 }
        const count = Math.ceil(curveSteps(radius, TAU) / 4) * 4
        result.segs = segments(Array.from({ length: count }, (_, i) => ({
          x: center.x + radius * Math.cos(TAU * i / count), y: center.y + radius * Math.sin(TAU * i / count),
        })), true)
      }
    } else if (name === 'arc') {
      const arc = c ? arcThroughPoints(a, b, c) : null
      if (arc && c) {
        const middleAngle = Math.atan2(b.y - arc.center.y, b.x - arc.center.x)
        const firstSweep = arc.sweepAngle > 0 ? positiveAngle(middleAngle - arc.startAngle) : -positiveAngle(arc.startAngle - middleAngle)
        const first = sampleArc(arc, a, b, arc.startAngle, firstSweep)
        const second = sampleArc(arc, b, c, middleAngle, arc.sweepAngle - firstSweep)
        result.segs = segments([...first, ...second.slice(1)])
      } else result.segs = segments(anchors.slice(0, 3))
    } else if (name === 'arrowLine') {
      result.segs = [[a, b]]
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (length > 1e-8) {
        const ux = (b.x - a.x) / length
        const uy = (b.y - a.y) / length
        const head = Math.min(10, length / 2)
        const base = { x: b.x - ux * head, y: b.y - uy * head }
        result.polygon = [{ x: base.x + uy * head / 2, y: base.y - ux * head / 2 }, b, { x: base.x - uy * head / 2, y: base.y + ux * head / 2 }]
        result.segs.push(...segments(result.polygon, true))
      }
    } else if (name === 'curseLine') {
      const y = (a.y + b.y) / 2
      if (Number.isFinite(bounds.right) && b.x <= bounds.right) result.segs = [[{ x: b.x, y }, { x: bounds.right, y }]]
    } else if (name === 'percentageLine') {
      result.segs = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
        const y = a.y + (b.y - a.y) * ratio
        return [{ x: Math.min(a.x, b.x), y }, { x: Math.max(a.x, b.x), y }]
      })
    }
  }
  return result
}
