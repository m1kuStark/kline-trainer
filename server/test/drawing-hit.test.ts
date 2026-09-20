import { expect, it } from 'vitest'
import { builtInGeometry, pointInPolygon, segmentInRect } from '../../web/src/builtInGeometry'

it('extends vertical rays only toward the second point and keeps secondary pane bounds', () => {
  expect(builtInGeometry('verticalRayLine', [{ x: 30, y: 150 }, { x: 30, y: 120 }], { left: 0, right: 100, top: 100, bottom: 200 })?.segs)
    .toEqual([[{ x: 30, y: 150 }, { x: 30, y: 100 }]])
})
it('includes all price channel boundaries and excludes the control point diagonal', () => {
  expect(builtInGeometry('priceChannelLine', [{ x: 20, y: 20 }, { x: 40, y: 40 }, { x: 30, y: 50 }], { left: 0, right: 100, top: 0, bottom: 100 })?.segs)
    .toEqual([[{ x: 0, y: 0 }, { x: 100, y: 100 }], [{ x: 0, y: 20 }, { x: 100, y: 120 }], [{ x: 0, y: -20 }, { x: 100, y: 80 }]])
})
it('selects text and filled markers by their interior while a line outside a narrow selection box is excluded', () => {
  expect(pointInPolygon({ x: 50, y: 20 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }])).toBe(true)
  expect(pointInPolygon({ x: 110, y: 20 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }])).toBe(false)
  const box = { left: 102, top: 10, width: 5, height: 5 }
  expect(segmentInRect([{ x: -1000, y: 12 }, { x: 1000, y: 12 }], box)).toBe(true)
  expect(segmentInRect([{ x: -1000, y: 16 }, { x: 1000, y: 16 }], box)).toBe(false)
})
