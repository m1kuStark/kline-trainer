type Point = { x: number; y: number }
type Bounds = { left: number; right: number; top: number; bottom: number }

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function segmentInRect(segment: Point[], rect: { left: number; top: number; width: number; height: number }): boolean {
  const [a, b] = segment
  let from = 0, to = 1
  const dx = b.x - a.x, dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - rect.left], [dx, rect.left + rect.width - a.x], [-dy, a.y - rect.top], [dy, rect.top + rect.height - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) from = Math.max(from, t)
    else to = Math.min(to, t)
    if (from > to) return false
  }
  return true
}

export function builtInGeometry(name: string, points: Point[], bounds: Bounds): { anchors: Point[]; segs: Point[][] } | null {
  const [a, b, c] = points
  if (!a) return { anchors: [], segs: [] }
  const segs: Point[][] = []
  const horizontal = (y: number) => [{ x: bounds.left, y }, { x: bounds.right, y }]
  const vertical = (x: number) => [{ x, y: bounds.top }, { x, y: bounds.bottom }]
  const extended = (p: Point, q: Point) => {
    if (p.x === q.x) return vertical(p.x)
    const k = (q.y - p.y) / (q.x - p.x)
    return [{ x: bounds.left, y: p.y + (bounds.left - p.x) * k }, { x: bounds.right, y: p.y + (bounds.right - p.x) * k }]
  }
  if (name === 'horizontalStraightLine') segs.push(horizontal(a.y))
  else if (name === 'verticalStraightLine') segs.push(vertical(a.x))
  else if (!b) return null
  else if (name === 'horizontalSegment') segs.push([a, { x: b.x, y: a.y }])
  else if (name === 'verticalSegment') segs.push([a, { x: a.x, y: b.y }])
  else if (name === 'horizontalRayLine') segs.push([a, { x: b.x >= a.x ? bounds.right : bounds.left, y: a.y }])
  else if (name === 'verticalRayLine') segs.push([a, { x: a.x, y: b.y >= a.y ? bounds.bottom : bounds.top }])
  else if (name === 'straightLine') segs.push(extended(a, b))
  else if (name === 'rayLine') {
    const line = extended(a, b)
    segs.push([a, a.x === b.x ? line[b.y >= a.y ? 1 : 0] : line[b.x >= a.x ? 1 : 0]])
  } else if (name === 'segment') segs.push([a, b])
  else if (name === 'parallelStraightLine' || name === 'priceChannelLine') {
    segs.push(extended(a, b))
    if (c) {
      segs.push(extended(c, { x: c.x + b.x - a.x, y: c.y + b.y - a.y }))
      if (name === 'priceChannelLine') {
        const reflected = { x: 2 * a.x - c.x, y: 2 * a.y - c.y }
        segs.push(extended(reflected, { x: reflected.x + b.x - a.x, y: reflected.y + b.y - a.y }))
      }
    }
  } else if (name === 'fibonacciLine') {
    for (const ratio of [1, 0.786, 0.618, 0.5, 0.382, 0.236, 0]) segs.push(horizontal(b.y + (a.y - b.y) * ratio))
  } else return null
  return { anchors: points, segs }
}
