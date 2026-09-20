import { registerOverlay, type OverlayCreateFiguresCallbackParams, type OverlayFigure } from 'klinecharts'
import { builtInGeometry } from './builtInGeometry'
import { boundedTextAnnotationLayout, drawingFigureGeometry, type DrawingCoordinate, type DrawingGeometry } from './drawingGeometry'

const definitions = [
  ['priceLine', 2], ['rectangle', 3], ['circle', 3], ['arc', 4], ['arrowLine', 3],
  ['bullArrow', 2], ['bearArrow', 2], ['percentageLine', 3], ['fibonacciLine', 3], ['curseLine', 3], ['textAnnotation', 2],
  ['polyline', Number.MAX_SAFE_INTEGER],
] as const

function connectedPaths(segs: DrawingGeometry['segs']): DrawingCoordinate[][] {
  const paths: DrawingCoordinate[][] = []
  for (const [a, b] of segs) {
    const previous = paths.at(-1)
    const end = previous?.at(-1)
    if (previous && end?.x === a.x && end.y === a.y) previous.push(b)
    else paths.push([a, b])
  }
  return paths
}

function measurementLabelLayout(levels: Array<{ start: DrawingCoordinate; text: string }>, width: number, height: number, topInset: number) {
  const size = Math.max(8, Math.min(11, Math.floor((height - topInset - 4) / levels.length) - 2))
  const spacing = size + 2
  const minY = topInset + size + 2
  const maxY = height - 2
  const rows = Math.max(1, Math.floor((maxY - minY) / spacing) + 1)
  const columns = Math.ceil(levels.length / rows)
  const columnWidth = Math.max(...levels.map(level => level.text.length * size * 0.65)) + 12
  const originX = Math.max(3, Math.min(levels[0]!.start.x + 3, width - columnWidth * columns - 3))
  const sorted = levels.map((level, index) => ({ index, y: level.start.y - 2 })).sort((a, b) => a.y - b.y)
  const positions: DrawingCoordinate[] = []
  // Pack downwards, then propagate any bottom overflow upwards without reordering prices.
  for (let column = 0; column < columns; column++) {
    const group = sorted.slice(column * rows, (column + 1) * rows)
    for (let index = 0; index < group.length; index++) group[index]!.y = Math.max(group[index]!.y, index ? group[index - 1]!.y + spacing : minY)
    group.at(-1)!.y = Math.min(group.at(-1)!.y, maxY)
    for (let index = group.length - 2; index >= 0; index--) group[index]!.y = Math.min(group[index]!.y, group[index + 1]!.y - spacing)
    for (const entry of group) positions[entry.index] = { x: originX + column * columnWidth, y: entry.y }
  }
  return { size, positions }
}

function measurementFigures(name: string, { chart, overlay, coordinates, bounding, yAxis }: OverlayCreateFiguresCallbackParams<unknown>): OverlayFigure[] {
  const [first, second] = overlay.points.map(point => point.value)
  const priceLine = name === 'priceLine'
  const last = priceLine ? first : second
  if (coordinates.length < (priceLine ? 1 : 2) || typeof first !== 'number' || typeof last !== 'number' || !Number.isFinite(first) || !Number.isFinite(last)) return []
  const bounds = { left: 0, right: bounding.width, top: 0, bottom: bounding.height }
  const fibonacci = name === 'fibonacciLine'
  const geometry = fibonacci ? builtInGeometry(name, coordinates, bounds) : drawingFigureGeometry(name, coordinates, bounds)
  const ratios = fibonacci ? [1, 0.786, 0.618, 0.5, 0.382, 0.236, 0] : priceLine ? [0] : name === 'curseLine' ? [0.5] : [0, 0.25, 0.5, 0.75, 1]
  const inCandle = yAxis?.isInCandle() ?? true
  const precision = inCandle
    ? chart.getSymbol()?.pricePrecision ?? 2
    : Math.max(0, ...chart.getIndicators({ paneId: overlay.paneId }).map(indicator => indicator.precision))
  const lineStyle = { ...chart.getStyles().overlay.line, ...overlay.styles?.line }
  const segments = geometry?.segs ?? []
  if (!segments.length) return []
  const figures: OverlayFigure[] = segments.map(segment => ({ type: 'line', attrs: { coordinates: segment }, styles: lineStyle }))
  const levels = segments.map((segment, index) => {
    const ratio = ratios[index]!
    const value = fibonacci ? last + (first - last) * ratio : first + (last - first) * ratio
    const text = chart.getDecimalFold().format(chart.getThousandsSeparator().format(value.toFixed(precision)))
    return { start: segment[0]!, text: priceLine ? text : `${text} (${(ratio * 100).toFixed(1)}%)` }
  }).filter(level => level.start.y >= 0 && level.start.y <= bounding.height)
  if (!levels.length) return figures
  const topInset = Math.min(inCandle ? 44 : 32, Math.max(0, bounding.height - 80))
  const { size, positions } = measurementLabelLayout(levels, bounding.width, bounding.height, topInset)
  levels.forEach(({ start, text }, index) => {
    const position = positions[index]!
    if (!priceLine && name !== 'curseLine' && (Math.abs(position.y - (start.y - 2)) > 0.5 || Math.abs(position.x - (start.x + 3)) > 0.5)) figures.push({
      type: 'line', attrs: { coordinates: [start, { x: position.x, y: position.y + 2 }] },
      styles: { ...lineStyle, size: 0.5, style: 'solid' }, ignoreEvent: true,
    })
    figures.push({
      type: 'text', attrs: { ...position, baseline: 'bottom', text },
      styles: { color: lineStyle.color, size, weight: 'normal', family: 'Arial, sans-serif', backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
      ignoreEvent: true,
    })
  })
  return figures
}

function createFigures(name: string, params: OverlayCreateFiguresCallbackParams<unknown>): OverlayFigure[] {
  if (name === 'percentageLine' || name === 'fibonacciLine' || name === 'curseLine' || name === 'priceLine') return measurementFigures(name, params)
  const { chart, overlay, coordinates, bounding } = params
  const bounds = { left: 0, right: bounding.width, top: 0, bottom: bounding.height }
  const geometry = drawingFigureGeometry(name, coordinates, bounds, overlay.extendData)
  const anchor = geometry.anchors[0]
  if (!anchor) return []
  const lineStyle = { ...chart.getStyles().overlay.line, ...overlay.styles?.line }
  if (name === 'bullArrow' || name === 'bearArrow') {
    const color = overlay.styles?.line?.color ?? (name === 'bullArrow' ? '#ef4444' : '#16a34a')
    return [{ type: 'polygon', attrs: { coordinates: geometry.polygon }, styles: { style: 'fill', color } }]
  }
  if (name === 'textAnnotation') {
    const layout = boundedTextAnnotationLayout(anchor, bounds, overlay.extendData)
    if (!layout) return []
    const { data, size, lines, lineHeight, width, origin } = layout
    // klinecharts createFont inserts weight before size, accepting CSS italic + bold here.
    const weight = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold' : 'normal'}`
    return lines.map((text, index) => ({
      type: 'text',
      attrs: { x: origin.x, y: origin.y + index * lineHeight, text, width, height: lineHeight },
      styles: { color: data.color ?? lineStyle.color, size, weight, family: 'Arial, sans-serif', backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
    }))
  }
  const outline = name === 'arrowLine' ? geometry.segs.slice(0, 1) : geometry.segs
  const figures: OverlayFigure[] = connectedPaths(outline).map(path => ({
    type: 'line', attrs: { coordinates: path }, styles: lineStyle,
  }))
  if (name === 'arrowLine' && geometry.polygon) figures.push({
    type: 'polygon', attrs: { coordinates: geometry.polygon }, styles: { style: 'fill', color: lineStyle.color },
  })
  return figures
}

let registered = false

export function registerDrawingOverlays(): void {
  if (registered) return
  for (const [name, totalStep] of definitions) registerOverlay({
    name,
    totalStep,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: name === 'fibonacciLine',
    needDefaultYAxisFigure: name === 'fibonacciLine',
    createPointFigures: params => createFigures(name, params),
  })
  registered = true
}
