import { describe, expect, it, vi } from 'vitest'
import { arcThroughPoints, drawingFigureGeometry } from '../../web/src/drawingGeometry'

const registerOverlay = vi.hoisted(() => vi.fn())
vi.mock('klinecharts', () => ({ registerOverlay }))
import { registerDrawingOverlays } from '../../web/src/drawingOverlays'

const bounds = { left: 0, right: 200, top: 0, bottom: 120 }
const p = (x: number, y: number) => ({ x, y })

describe('drawing geometry shared by rendering and pointer selection', () => {
  it('extends a price line only to the right of its single anchor', () => {
    expect(drawingFigureGeometry('priceLine', [p(40, 30)], bounds)).toEqual({
      anchors: [p(40, 30)], segs: [[p(40, 30), p(200, 30)]],
    })
  })

  it.each([
    { points: [p(20, 20), p(90, 80)], expected: [[p(90, 50), p(200, 50)]] },
    { points: [p(90, 80), p(20, 20)], expected: [[p(20, 50), p(200, 50)]] },
    { points: [p(20, 20), p(220, 80)], expected: [] },
  ])('keeps curse-line anchors while drawing only a rightward midpoint ray: $points', ({ points, expected }) => {
    expect(drawingFigureGeometry('curseLine', points, bounds)).toEqual({ anchors: points, segs: expected })
  })

  it('closes the four rectangle edges without selecting its transparent interior', () => {
    expect(drawingFigureGeometry('rectangle', [p(90, 70), p(10, 20)], bounds)).toEqual({
      anchors: [p(90, 70), p(10, 20)],
      segs: [[p(90, 70), p(10, 70)], [p(10, 70), p(10, 20)], [p(10, 20), p(90, 20)], [p(90, 20), p(90, 70)]],
    })
  })

  it.each([
    { anchors: [p(10, 20), p(90, 20)], center: p(50, 20), radius: 40, edges: [10, 90, -20, 60] },
    { anchors: [p(10, 20), p(90, 80)], center: p(50, 50), radius: 50, edges: [0, 100, 0, 100] },
    { anchors: [p(10, 20), p(10, 60)], center: p(10, 40), radius: 20, edges: [-10, 30, 20, 60] },
  ])('keeps a diameter-defined circle round when the anchor aspect ratio changes: $anchors', ({ anchors, center, radius, edges }) => {
    const result = drawingFigureGeometry('circle', anchors, bounds)
    const sampled = result.segs.flat()
    expect(result.anchors).toEqual(anchors)
    expect(Math.min(...sampled.map(point => point.x))).toBeCloseTo(edges[0]!, 8)
    expect(Math.max(...sampled.map(point => point.x))).toBeCloseTo(edges[1]!, 8)
    expect(Math.min(...sampled.map(point => point.y))).toBeCloseTo(edges[2]!, 8)
    expect(Math.max(...sampled.map(point => point.y))).toBeCloseTo(edges[3]!, 8)
    for (const point of sampled) expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeCloseTo(radius, 8)
    expect(result.polygon).toBeUndefined()
  })

  it('keeps coincident circle diameter endpoints finite without a phantom radius', () => {
    expect(drawingFigureGeometry('circle', [p(10, 20), p(10, 20)], bounds)).toEqual({
      anchors: [p(10, 20), p(10, 20)], segs: [[p(10, 20), p(10, 20)]],
    })
  })

  it.each([
    { points: [p(1, 0), p(0, 1), p(-1, 0)], sweep: Math.PI },
    { points: [p(1, 0), p(0, -1), p(-1, 0)], sweep: -Math.PI },
    { points: [p(1, 0), p(-1, 0), p(0, -1)], sweep: 1.5 * Math.PI },
    { points: [p(1, 0), p(-1, 0), p(0, 1)], sweep: -1.5 * Math.PI },
  ])('traces the arc through the middle anchor with signed sweep $sweep', ({ points, sweep }) => {
    const arc = arcThroughPoints(points[0]!, points[1]!, points[2]!)!
    expect(arc.center.x).toBeCloseTo(0, 10)
    expect(arc.center.y).toBeCloseTo(0, 10)
    expect(arc.radius).toBeCloseTo(1, 10)
    expect(arc.startAngle).toBeCloseTo(0, 10)
    expect(arc.sweepAngle).toBeCloseTo(sweep, 10)
    const result = drawingFigureGeometry('arc', points, bounds)
    expect(result.segs[0]![0]).toEqual(points[0])
    expect(result.segs.at(-1)![1]).toEqual(points[2])
    expect(result.segs.flat()).toContainEqual(points[1])
    for (const point of result.segs.flat()) expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 8)
  })

  it('uses an ordered line fallback for collinear or repeated arc anchors', () => {
    expect(arcThroughPoints(p(10, 10), p(20, 20), p(30, 30))).toBeNull()
    expect(arcThroughPoints(p(10, 10), p(10, 10), p(30, 30))).toBeNull()
    expect(drawingFigureGeometry('arc', [p(10, 10), p(20, 20), p(30, 30)], bounds).segs).toEqual([
      [p(10, 10), p(20, 20)], [p(20, 20), p(30, 30)],
    ])
  })

  it('keeps translated arc coordinates finite and rejects invalid anchors', () => {
    const arc = arcThroughPoints(p(1000001, 1000000), p(1000000, 1000001), p(999999, 1000000))!
    expect(arc.center).toEqual(p(1000000, 1000000))
    expect(arc.radius).toBe(1)
    for (const name of ['arc', 'circle', 'rectangle', 'arrowLine', 'percentageLine', 'polyline']) {
      const geometry = drawingFigureGeometry(name, [p(12, 12), p(12, 12), p(12, 12)], bounds)
      expect(geometry.segs.flat().every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
      expect(drawingFigureGeometry(name, [p(NaN, 12)], bounds)).toEqual({ anchors: [], segs: [] })
    }
  })

  it('draws a filled arrowhead at the second point with its complete triangle in selection', () => {
    const geometry = drawingFigureGeometry('arrowLine', [p(10, 50), p(90, 50)], bounds)
    expect(geometry.polygon).toEqual([p(80, 45), p(90, 50), p(80, 55)])
    expect(geometry.segs).toEqual([
      [p(10, 50), p(90, 50)], [p(80, 45), p(90, 50)], [p(90, 50), p(80, 55)], [p(80, 55), p(80, 45)],
    ])
  })

  it('makes the bullish and bearish filled triangles point at their price anchors', () => {
    expect(drawingFigureGeometry('bullArrow', [p(50, 50)], bounds).polygon).toEqual([p(50, 50), p(42, 64), p(58, 64)])
    expect(drawingFigureGeometry('bearArrow', [p(50, 50)], bounds).polygon).toEqual([p(50, 50), p(42, 36), p(58, 36)])
  })

  it('places exactly five percentage levels in first-to-second anchor order', () => {
    expect(drawingFigureGeometry('percentageLine', [p(90, 100), p(10, 20)], bounds).segs).toEqual([
      [p(10, 100), p(90, 100)], [p(10, 80), p(90, 80)], [p(10, 60), p(90, 60)],
      [p(10, 40), p(90, 40)], [p(10, 20), p(90, 20)],
    ])
  })

  it('retains every polyline leg without closing the last point to the first', () => {
    const points = [p(10, 10), p(90, 40), p(30, 70), p(100, 80)]
    expect(drawingFigureGeometry('polyline', points, bounds)).toEqual({
      anchors: points, segs: [[points[0], points[1]], [points[1], points[2]], [points[2], points[3]]],
    })
  })

  it('gives multiline plain-text annotations a selectable fixed-size box', () => {
    const geometry = drawingFigureGeometry('textAnnotation', [p(30, 40)], bounds, { text: 'AB\nCD', size: 20 })
    expect(geometry.polygon).toEqual([p(30, 40), p(54.8, 40), p(54.8, 88), p(30, 88)])
    expect(geometry.segs).toHaveLength(4)
  })

  it('moves a right-bottom annotation box fully inside its pane without moving the data anchor', () => {
    const geometry = drawingFigureGeometry('textAnnotation', [p(195, 115)], bounds, { text: 'AB\nCD', size: 20 })
    expect(geometry.anchors).toEqual([p(195, 115)])
    expect(geometry.polygon![0]!.x).toBeCloseTo(175.2, 8)
    expect(geometry.polygon![0]!.y).toBe(72)
    expect(geometry.polygon![2]).toEqual(p(200, 120))
  })

  it.each([p(-1, 30), p(30, -1), p(201, 30), p(30, 121)])('hides an annotation whose anchor is outside the visible pane: %j', anchor => {
    expect(drawingFigureGeometry('textAnnotation', [anchor], bounds, { text: 'AB', size: 20 })).toEqual({ anchors: [], segs: [] })
  })
})

describe('custom overlay figure contracts', () => {
  registerDrawingOverlays()
  const templates = new Map(registerOverlay.mock.calls.map(([template]) => [template.name, template]))
  const base = {
    coordinates: [p(20, 40), p(100, 80), p(150, 20)],
    bounding: { left: 0, top: 0, width: 200, height: 120 },
    chart: {
      getStyles: () => ({ overlay: { line: { color: '#facc15', size: 1, style: 'dashed', dashedValue: [4, 4] } } }),
      getSymbol: () => ({ pricePrecision: 2 }),
      getIndicators: () => [],
      getThousandsSeparator: () => ({ format: (value: string) => value }),
      getDecimalFold: () => ({ format: (value: string) => value }),
    },
    overlay: { points: [{ value: 12.345 }, { value: 9.875 }, { value: 20 }], styles: null, extendData: null },
  }

  it('registers all tools with the correct point counts and leaves polylines open for explicit completion', () => {
    expect([...templates.keys()]).toEqual(['priceLine', 'rectangle', 'circle', 'arc', 'arrowLine', 'bullArrow', 'bearArrow', 'percentageLine', 'fibonacciLine', 'curseLine', 'textAnnotation', 'polyline'])
    expect(templates.get('priceLine').totalStep).toBe(2)
    expect(templates.get('rectangle').totalStep).toBe(3)
    expect(templates.get('arc').totalStep).toBe(4)
    expect(templates.get('curseLine').totalStep).toBe(3)
    expect(templates.get('textAnnotation').totalStep).toBe(2)
    expect(templates.get('polyline').totalStep).toBe(Number.MAX_SAFE_INTEGER)
    const before = registerOverlay.mock.calls.length
    registerDrawingOverlays()
    expect(registerOverlay.mock.calls).toHaveLength(before)
  })

  it('passes edited line styles through to shape outlines without filling empty shapes', () => {
    for (const name of ['rectangle', 'circle', 'arc', 'percentageLine', 'polyline']) {
      const figures = templates.get(name).createPointFigures({ ...base,
        overlay: { ...base.overlay, styles: { line: { color: '#00ff00', size: 3, style: 'solid', dashedValue: [7, 2] } } },
      })
      const outlines = figures.filter((figure: { type: string; ignoreEvent?: boolean }) => figure.type === 'line' && !figure.ignoreEvent)
      expect(outlines.length).toBeGreaterThan(0)
      for (const figure of outlines) expect(figure.styles).toMatchObject({ color: '#00ff00', size: 3, style: 'solid', dashedValue: [7, 2] })
      expect(figures.some((figure: { type: string }) => ['polygon', 'rect', 'circle', 'arc'].includes(figure.type))).toBe(false)
    }
  })

  it('renders a solid arrowhead using the shaft color while retaining dashed shaft styling', () => {
    const figures = templates.get('arrowLine').createPointFigures({ ...base, coordinates: [p(10, 50), p(90, 50)],
      overlay: { ...base.overlay, styles: { line: { color: '#00ff00', size: 3, style: 'dashed', dashedValue: [7, 2] } } },
    })
    expect(figures).toHaveLength(2)
    expect(figures[0]).toMatchObject({ type: 'line', attrs: { coordinates: [p(10, 50), p(90, 50)] }, styles: { color: '#00ff00', size: 3, style: 'dashed', dashedValue: [7, 2] } })
    expect(figures[1]).toMatchObject({ type: 'polygon', attrs: { coordinates: [p(80, 45), p(90, 50), p(80, 55)] }, styles: { style: 'fill', color: '#00ff00' } })
    expect(figures[1].ignoreEvent).not.toBe(true)
  })

  it('uses a transparent price label with the same typography and default color as measurement labels', () => {
    const figures = templates.get('priceLine').createPointFigures({ ...base, coordinates: [p(20, 70)] })
    expect(figures[0].styles).toMatchObject({ color: '#facc15', size: 1, style: 'dashed', dashedValue: [4, 4] })
    expect(figures).toHaveLength(2)
    expect(figures[1]).toMatchObject({ type: 'text', attrs: { text: '12.35', x: 23 }, styles: { color: '#facc15', size: 11, family: 'Arial, sans-serif', backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 }, ignoreEvent: true })
    const edited = templates.get('priceLine').createPointFigures({ ...base, coordinates: [p(20, 70)],
      overlay: { ...base.overlay, styles: { line: { color: '#abcdef' } } },
    })
    expect(edited[1].styles.color).toBe('#abcdef')
  })

  it.each([
    { points: [{ value: 20 }, { value: 10 }], coordinates: [p(20, 40), p(80, 80)], start: p(80, 60) },
    { points: [{ value: 10 }, { value: 20 }], coordinates: [p(90, 80), p(20, 40)], start: p(20, 60) },
  ])('renders only a curse midpoint line and label from the second clicked time: $points', ({ points, coordinates, start }) => {
    expect(templates.has('curseLine')).toBe(true)
    const figures = templates.get('curseLine').createPointFigures({ ...base, coordinates,
      overlay: { ...base.overlay, points },
    })
    expect(figures).toHaveLength(2)
    expect(figures[0]).toMatchObject({ type: 'line', attrs: { coordinates: [start, p(200, 60)] } })
    expect(figures[1]).toMatchObject({ type: 'text', attrs: { text: '15.00 (50.0%)', x: start.x + 3, y: 58 }, styles: { color: '#facc15', backgroundColor: 'transparent', borderSize: 0 }, ignoreEvent: true })
  })

  it.each(['priceLine', 'curseLine'])('uses indicator precision and signed values for $name in subpanes', name => {
    expect(templates.has(name)).toBe(true)
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(20, 40), p(100, 80)],
      yAxis: { isInCandle: () => false },
      chart: { ...base.chart, getIndicators: () => [{ precision: 3 }] },
      overlay: { ...base.overlay, paneId: 'macd', points: [{ value: -0.012 }, { value: 0.008 }] },
    })
    expect(figures.filter((figure: { type: string }) => figure.type === 'text')[0].attrs.text).toBe(name === 'priceLine' ? '-0.012' : '-0.002 (50.0%)')
  })

  it.each(['priceLine', 'curseLine'])('keeps $name labels below the pane legend without adding diagonal leaders', name => {
    expect(templates.has(name)).toBe(true)
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(20, 1), p(100, 1)],
      bounding: { ...base.bounding, height: 290 },
    })
    expect(figures).toHaveLength(2)
    expect(figures[1]).toMatchObject({ type: 'text', attrs: { y: 57 } })
  })

  it.each(['priceLine', 'curseLine'])('does not pin an offscreen $name label to the visible pane', name => {
    expect(templates.has(name)).toBe(true)
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(20, -20), p(100, -10)] })
    expect(figures.filter((figure: { type: string }) => figure.type === 'text')).toEqual([])
  })

  it('renders percentage labels with their interpolated prices and transparent text', () => {
    const figures = templates.get('percentageLine').createPointFigures({ ...base, coordinates: [p(20, 40), p(100, 80)],
      overlay: { ...base.overlay, points: [{ value: 10 }, { value: 20 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels.map((figure: any) => figure.attrs.text)).toEqual(['10.00 (0.0%)', '12.50 (25.0%)', '15.00 (50.0%)', '17.50 (75.0%)', '20.00 (100.0%)'])
    for (const label of labels) expect(label.styles).toMatchObject({ backgroundColor: 'transparent', borderSize: 0, color: '#facc15' })
  })

  it('overrides Fibonacci labels with native ratios, interpolated prices, and transparent text', () => {
    expect(templates.has('fibonacciLine')).toBe(true)
    const template = templates.get('fibonacciLine')
    expect(template).toMatchObject({ totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true })
    const figures = template.createPointFigures({ ...base, coordinates: [p(20, 40), p(100, 80)],
      overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels.map((figure: any) => figure.attrs.text)).toEqual(['20.00 (100.0%)', '17.86 (78.6%)', '16.18 (61.8%)', '15.00 (50.0%)', '13.82 (38.2%)', '12.36 (23.6%)', '10.00 (0.0%)'])
    expect(figures.filter((figure: { type: string; ignoreEvent?: boolean }) => figure.type === 'line' && !figure.ignoreEvent)).toHaveLength(7)
    for (const label of labels) expect(label.styles).toMatchObject({ backgroundColor: 'transparent', borderSize: 0, color: '#facc15' })
  })

  it.each([
    { name: 'percentageLine', expected: ['20.00 (0.0%)', '17.50 (25.0%)', '15.00 (50.0%)', '12.50 (75.0%)', '10.00 (100.0%)'], firstX: 23, firstY: 278, lastY: 78 },
    { name: 'fibonacciLine', expected: ['20.00 (100.0%)', '17.86 (78.6%)', '16.18 (61.8%)', '15.00 (50.0%)', '13.82 (38.2%)', '12.36 (23.6%)', '10.00 (0.0%)'], firstX: 3, firstY: 278, lastY: 78 },
  ])('keeps reversed $name labels on their own price levels with edited line styling', ({ name, expected, firstX, firstY, lastY }) => {
    expect(templates.has(name)).toBe(true)
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(100, 280), p(20, 80)],
      bounding: { ...base.bounding, height: 320 },
      overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }], styles: { line: { color: '#ffffff', size: 3, style: 'solid' } } },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels.map((figure: any) => figure.attrs.text)).toEqual(expected)
    expect(labels[0].attrs).toMatchObject({ x: firstX, y: firstY, baseline: 'bottom' })
    expect(labels.at(-1).attrs.y).toBe(lastY)
    for (const label of labels) expect(label).toMatchObject({ styles: { color: '#ffffff', size: 11, weight: 'normal', family: 'Arial, sans-serif', backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 }, ignoreEvent: true })
    for (const line of figures.filter((figure: { type: string }) => figure.type === 'line')) expect(line.styles).toMatchObject({ color: '#ffffff', size: 3, style: 'solid', dashedValue: [4, 4] })
    if (name === 'fibonacciLine') {
      const lines = figures.filter((figure: { type: string }) => figure.type === 'line')
      expect(lines[0].attrs.coordinates).toEqual([p(0, 280), p(200, 280)])
      expect(lines.at(-1).attrs.coordinates).toEqual([p(0, 80), p(200, 80)])
    }
  })

  it.each(['percentageLine', 'fibonacciLine'])('retains $name indicator precision and price signs in subpanes', name => {
    expect(templates.has(name)).toBe(true)
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(20, 40), p(100, 80)],
      yAxis: { isInCandle: () => false },
      chart: { ...base.chart, getIndicators: ({ paneId }: { paneId: string }) => paneId === 'macd' ? [{ precision: 2 }, { precision: 3 }] : [] },
      overlay: { ...base.overlay, paneId: 'macd', points: [{ value: -0.012 }, { value: 0.008 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels[0].attrs.text).toBe(name === 'percentageLine' ? '-0.012 (0.0%)' : '-0.012 (100.0%)')
    expect(labels.at(-1).attrs.text).toBe(name === 'percentageLine' ? '0.008 (100.0%)' : '0.008 (0.0%)')
  })

  it('separates crowded Fibonacci labels without moving price lines or adding selectable leaders', () => {
    const figures = templates.get('fibonacciLine').createPointFigures({ ...base, coordinates: [p(20, 60), p(100, 60)],
      bounding: { ...base.bounding, height: 200 },
      overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels.map((figure: any) => figure.attrs.y)).toEqual([58, 71, 84, 97, 110, 123, 136])
    expect(labels.map((figure: any) => figure.attrs.text)).toEqual(['20.00 (100.0%)', '17.86 (78.6%)', '16.18 (61.8%)', '15.00 (50.0%)', '13.82 (38.2%)', '12.36 (23.6%)', '10.00 (0.0%)'])
    const levels = figures.filter((figure: { type: string; ignoreEvent?: boolean }) => figure.type === 'line' && !figure.ignoreEvent)
    expect(levels).toHaveLength(7)
    for (const level of levels) expect(level.attrs.coordinates).toEqual([p(0, 60), p(200, 60)])
    const leaders = figures.filter((figure: { type: string; ignoreEvent?: boolean }) => figure.type === 'line' && figure.ignoreEvent)
    expect(leaders).toHaveLength(6)
    for (const leader of leaders) expect(leader.styles).toMatchObject({ size: 0.5, style: 'solid', color: '#facc15' })
  })

  it.each([
    { y: 1, expected: [57, 70, 83, 96, 109] },
    { y: 199, expected: [146, 159, 172, 185, 198] },
  ])('keeps dense percentage labels within the pane at y=$y', ({ y, expected }) => {
    const figures = templates.get('percentageLine').createPointFigures({ ...base, coordinates: [p(20, y), p(100, y)],
      bounding: { ...base.bounding, height: 200 },
      overlay: { ...base.overlay, points: [{ value: 10 }, { value: 20 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels.map((figure: any) => figure.attrs.y)).toEqual(expected)
    for (const label of labels) expect(label.styles).toMatchObject({ size: 11, backgroundColor: 'transparent' })
  })

  it('fits every Fibonacci label in a compact pane with readable text and no background', () => {
    const figures = templates.get('fibonacciLine').createPointFigures({ ...base, coordinates: [p(20, 30), p(100, 30)],
      bounding: { ...base.bounding, height: 80 }, overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels).toHaveLength(7)
    for (const label of labels) expect(label.styles).toMatchObject({ size: 8, backgroundColor: 'transparent' })
    expect(labels[0].attrs.y).toBeGreaterThanOrEqual(10)
    expect(labels.at(-1).attrs.y).toBeLessThanOrEqual(78)
    for (let index = 1; index < labels.length; index++) expect(labels[index].attrs.y - labels[index - 1].attrs.y).toBeGreaterThanOrEqual(10)
  })

  it('uses separate label columns when a short pane cannot fit seven readable rows', () => {
    const figures = templates.get('fibonacciLine').createPointFigures({ ...base, coordinates: [p(20, 20), p(100, 20)],
      bounding: { ...base.bounding, height: 50 }, overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels).toHaveLength(7)
    expect(new Set(labels.map((figure: any) => figure.attrs.x)).size).toBe(2)
    for (const label of labels) {
      expect(label.styles.size).toBe(8)
      expect(label.attrs.y).toBeGreaterThanOrEqual(10)
      expect(label.attrs.y).toBeLessThanOrEqual(48)
    }
    const byColumn = labels.reduce((columns: Map<number, number[]>, label: any) => {
      columns.set(label.attrs.x, [...columns.get(label.attrs.x) ?? [], label.attrs.y])
      return columns
    }, new Map<number, number[]>())
    for (const ys of byColumn.values()) {
      const sorted = ys.toSorted((a: number, b: number) => a - b)
      for (let index = 1; index < sorted.length; index++) expect(sorted[index] - sorted[index - 1]).toBeGreaterThanOrEqual(10)
    }
  })

  it.each([
    { name: 'percentageLine', expected: ['12.50 (25.0%)', '15.00 (50.0%)', '17.50 (75.0%)'], values: [10, 20], lineCount: 5 },
    { name: 'fibonacciLine', expected: ['16.18 (61.8%)', '15.00 (50.0%)', '13.82 (38.2%)', '12.36 (23.6%)'], values: [20, 10], lineCount: 7 },
  ])('clips offscreen $name labels while retaining the original price levels and ratios', ({ name, expected, values, lineCount }) => {
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(20, -50), p(100, 150)],
      overlay: { ...base.overlay, points: values.map(value => ({ value })) },
    })
    expect(figures.filter((figure: { type: string }) => figure.type === 'text').map((figure: any) => figure.attrs.text)).toEqual(expected)
    const levels = figures.filter((figure: { type: string; ignoreEvent?: boolean }) => figure.type === 'line' && !figure.ignoreEvent)
    expect(levels).toHaveLength(lineCount)
    expect(levels[0].attrs.coordinates[0].y).toBe(-50)
    expect(levels.at(-1).attrs.coordinates[0].y).toBe(150)
  })

  it.each(['percentageLine', 'fibonacciLine'])('does not pin any $name labels inside the pane when every price level is offscreen', name => {
    const figures = templates.get(name).createPointFigures({ ...base, coordinates: [p(20, -100), p(100, -50)],
      overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }] },
    })
    expect(figures.some((figure: { type: string }) => figure.type === 'text')).toBe(false)
    expect(figures.some((figure: { ignoreEvent?: boolean }) => figure.ignoreEvent)).toBe(false)
    expect(figures).toHaveLength(name === 'percentageLine' ? 5 : 7)
  })

  it.each([
    { isInCandle: true, topInset: 44 },
    { isInCandle: false, topInset: 32 },
  ])('keeps measurement text below the pane legend: candle=$isInCandle', ({ isInCandle, topInset }) => {
    const figures = templates.get('fibonacciLine').createPointFigures({ ...base, coordinates: [p(20, 1), p(100, 1)],
      bounding: { ...base.bounding, height: 290 }, yAxis: { isInCandle: () => isInCandle },
      overlay: { ...base.overlay, points: [{ value: 20 }, { value: 10 }] },
    })
    const labels = figures.filter((figure: { type: string }) => figure.type === 'text')
    expect(labels).toHaveLength(7)
    expect(labels[0].attrs.y).toBe(topInset + 13)
    for (const label of labels) expect(label.attrs.y - label.styles.size).toBeGreaterThanOrEqual(topInset + 2)
  })

  it('uses canvas text with size, color, bold and italic while preserving markup as literal text', () => {
    const figures = templates.get('textAnnotation').createPointFigures({ ...base, coordinates: [p(20, 40)],
      overlay: { ...base.overlay, extendData: { text: '<b>A</b>\nsecond', color: '#abcdef', size: 18, bold: true, italic: true } },
    })
    expect(figures).toHaveLength(2)
    expect(figures[0]).toMatchObject({ type: 'text', attrs: { text: '<b>A</b>' }, styles: { color: '#abcdef', size: 18, weight: 'italic bold', backgroundColor: 'transparent', borderSize: 0 } })
    expect(figures[0].ignoreEvent).not.toBe(true)
    expect(figures[1].attrs.text).toBe('second')
    expect(figures[1].attrs.y).toBeCloseTo(61.6, 8)
  })

  it('wraps edge annotations and shares the same layout with absolute-pane hit geometry', () => {
    const data = { text: 'A'.repeat(24), size: 20 }
    const figures = templates.get('textAnnotation').createPointFigures({ ...base, coordinates: [p(95, 75)],
      bounding: { left: 200, top: 300, width: 100, height: 80 }, overlay: { ...base.overlay, extendData: data },
    })
    expect(figures).toHaveLength(3)
    expect(figures.map((figure: any) => figure.attrs.text)).toEqual(['AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA'])
    expect(figures[0].attrs.x).toBeCloseTo(0.8, 8)
    expect(figures[0].attrs.y).toBe(8)
    expect(figures[2].attrs.y + figures[2].attrs.height).toBe(80)
    const geometry = drawingFigureGeometry('textAnnotation', [p(295, 375)], { left: 200, right: 300, top: 300, bottom: 380 }, data)
    expect(geometry.anchors).toEqual([p(295, 375)])
    expect(geometry.polygon![0]!.x).toBeCloseTo(200.8, 8)
    expect(geometry.polygon![0]!.y).toBe(308)
    expect(geometry.polygon![2]).toEqual(p(300, 380))
    expect(data).toEqual({ text: 'A'.repeat(24), size: 20 })
  })

  it('reduces long-note font size to keep complete text inside the available vertical space', () => {
    const figures = templates.get('textAnnotation').createPointFigures({ ...base, coordinates: [p(95, 55)],
      bounding: { left: 0, top: 0, width: 100, height: 60 }, overlay: { ...base.overlay, extendData: { text: 'A'.repeat(80), size: 20 } },
    })
    expect(figures).toHaveLength(5)
    expect(figures[0].styles.size).toBe(10)
    expect(figures.map((figure: any) => figure.attrs.text).join('')).toBe('A'.repeat(80))
    expect(figures[0].attrs.y).toBe(0)
    expect(figures[4].attrs.y + figures[4].attrs.height).toBe(60)
  })

  it('fits Chinese text and explicitly abbreviates extreme notes at a readable minimum size', () => {
    const data = { text: '\u6807\u6ce8'.repeat(1000), size: 20 }
    const figures = templates.get('textAnnotation').createPointFigures({ ...base, coordinates: [p(95, 25)],
      bounding: { left: 0, top: 0, width: 100, height: 30 }, overlay: { ...base.overlay, extendData: data },
    })
    expect(figures).toHaveLength(3)
    expect(figures[0].styles.size).toBe(8)
    expect(figures[0].attrs.text).toBe('\u6807\u6ce8'.repeat(6))
    expect(figures[2].attrs.text.endsWith('...')).toBe(true)
    for (const figure of figures) {
      expect(figure.attrs.x + figure.attrs.width).toBeLessThanOrEqual(100)
      expect(figure.attrs.y + figure.attrs.height).toBeLessThanOrEqual(30)
    }
    expect(data.text).toBe('\u6807\u6ce8'.repeat(1000))
  })

  it('does not render a text box pinned to the pane after its anchor scrolls offscreen', () => {
    expect(templates.get('textAnnotation').createPointFigures({ ...base, coordinates: [p(-5, 40)],
      overlay: { ...base.overlay, extendData: { text: 'AB', size: 20 } },
    })).toEqual([])
  })

  it('renders red bullish and green bearish markers and accepts later line-color edits', () => {
    for (const [name, color] of [['bullArrow', '#ef4444'], ['bearArrow', '#16a34a']]) {
      const figures = templates.get(name).createPointFigures(base)
      expect(figures[0]).toMatchObject({ type: 'polygon', styles: { color, style: 'fill' } })
      const edited = templates.get(name).createPointFigures({ ...base, overlay: { ...base.overlay, styles: { line: { color: '#ffffff' } } } })
      expect(edited[0].styles.color).toBe('#ffffff')
    }
  })
})
