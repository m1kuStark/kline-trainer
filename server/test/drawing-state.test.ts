import { describe, expect, it } from 'vitest'
import { DrawingHistory, SerialDrawingSaver, serializeDrawings, applyDrawingPrices } from '../../web/src/drawingState'
import {
  adoptDrawings, advanceRenderedBasis, isDrawingPriceBasis, projectDrawings, projectPriceValue, sameDrawingPriceBasis,
  type DrawingPriceBasis,
} from '../../web/src/drawingPriceBasis'

const line = { id: 'a', name: 'segment', paneId: 'candle_pane', points: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 20 }] }
// 603980 复现口径：除息后 historic 4.81 → 4.74。
const dividend: DrawingPriceBasis = { scale: 1, offset: -0.07 }
const identity: DrawingPriceBasis = { scale: 1, offset: 0 }

describe('drawing price basis projection', () => {
  it('validates basis metadata with the same strictness as the server contract', () => {
    expect(isDrawingPriceBasis({ scale: 1, offset: 0 })).toBe(true)
    expect(isDrawingPriceBasis({ scale: 0.5, offset: -0.12 })).toBe(true)
    expect(isDrawingPriceBasis({ scale: 0, offset: 0 })).toBe(false)
    expect(isDrawingPriceBasis({ scale: -1, offset: 0 })).toBe(false)
    expect(isDrawingPriceBasis({ scale: 1 })).toBe(false)
    expect(isDrawingPriceBasis({ scale: 1, offset: 0, mode: 'x' })).toBe(false)
    expect(isDrawingPriceBasis(null)).toBe(false)
    expect(isDrawingPriceBasis('identity')).toBe(false)
    expect(sameDrawingPriceBasis(identity, { scale: 1, offset: 0 })).toBe(true)
    expect(sameDrawingPriceBasis(identity, dividend)).toBe(false)
  })

  it('projects historic 4.81 onto the post-dividend basis as 4.74 without rounding or mutation', () => {
    const stored = { ...line, points: [{ timestamp: 1000, value: 4.81 }], priceBasis: identity }
    const snapshot = JSON.parse(JSON.stringify(stored))
    const projected = projectDrawings([stored], identity, dividend)
    expect(projected[0]!.points[0]!.value).toBeCloseTo(4.74, 12)
    expect(projected[0]!.points[0]!.value).not.toBe(4.74)
    expect(projected[0]!.priceBasis).toEqual({ scale: 1, offset: -0.07 })
    expect(stored).toEqual(snapshot)
    expect(projectPriceValue(4.81, identity, dividend)).toBeCloseTo(4.74, 12)
  })

  it('moves combined dividend, bonus and rights affinely, not by a pure ratio', () => {
    // 10送5配2配股价6派3：m=1.7，c=-0.9 → 仿射 (P+0.9)/1.7，与纯比例 P/1.7 不同。
    const combined: DrawingPriceBasis = { scale: 1 / 1.7, offset: 0.9 / 1.7 }
    const projected = projectPriceValue(4.81, identity, combined)
    expect(projected).toBeCloseTo((4.81 + 0.9) / 1.7, 12)
    expect(Math.abs(projected - 4.81 / 1.7)).toBeGreaterThan(0.5)
    const back = projectPriceValue(projected, combined, identity)
    expect(back).toBeCloseTo(4.81, 12)
  })

  it('keeps sub-pane anchors unchanged while restamping their metadata', () => {
    const volume = { id: 'v', name: 'horizontalSegment', paneId: 'VOL', points: [{ timestamp: 1000, value: 4200 }], priceBasis: identity }
    const macd = { id: 'm', name: 'segment', paneId: 'MACD', points: [{ timestamp: 1000, value: 0.12 }], priceBasis: identity }
    const projected = projectDrawings([volume, macd], identity, dividend)
    expect(projected[0]!.points[0]!.value).toBe(4200)
    expect(projected[1]!.points[0]!.value).toBe(0.12)
    expect(projected[0]!.priceBasis).toEqual(dividend)
    expect(projected[1]!.priceBasis).toEqual(dividend)
  })

  it('refreshes a simpleTag numeric price label so it does not go stale', () => {
    const tag = { id: 't', name: 'simpleTag', paneId: 'candle_pane', points: [{ timestamp: 1000, value: 4.81 }], extendData: '4.81', priceBasis: identity }
    const note = { id: 'n', name: 'simpleAnnotation', paneId: 'candle_pane', points: [{ timestamp: 1000, value: 4.81 }], extendData: '除息日', priceBasis: identity }
    const projected = projectDrawings([tag, note], identity, dividend)
    expect(projected[0]!.extendData).toBe('4.74')
    expect(projected[1]!.extendData).toBe('除息日')
  })

  it('stamps the rendered basis on serialization while two-argument calls keep the legacy shape', () => {
    const based = serializeDrawings([{ ...line, isDrawing: () => false }], id => id, dividend)
    expect(based[0]!.priceBasis).toEqual(dividend)
    expect(serializeDrawings([{ ...line, isDrawing: () => false }], id => id)).toEqual([line])
  })

  it('adopts legacy drawings without a basis at their stored values under the first reliable basis', () => {
    const legacy = { ...line, points: [{ timestamp: 1000, value: 4.81 }] }
    const adopted = adoptDrawings([legacy], dividend)
    expect(adopted[0]!.points[0]!.value).toBe(4.81)
    expect(adopted[0]!.priceBasis).toEqual(dividend)
    // 带基准画线：从存储基准投影到当前基准；无效基准元数据按旧画线处理，不抛错不猜测。
    const based = { ...line, points: [{ timestamp: 1000, value: 4.81 }], priceBasis: identity }
    expect(adoptDrawings([based], dividend)[0]!.points[0]!.value).toBeCloseTo(4.74, 12)
    const invalid = { ...line, points: [{ timestamp: 1000, value: 4.81 }], priceBasis: { scale: 0, offset: 0 } as unknown as DrawingPriceBasis }
    expect(adoptDrawings([invalid], dividend)[0]!.points[0]!.value).toBe(4.81)
    expect(adoptDrawings([based], identity)[0]!.points[0]!.value).toBe(4.81)
  })

  it('restores undo/redo history states that carry their own bases by projecting to the current basis', () => {
    const history = new DrawingHistory()
    history.reset([{ ...line, points: [{ timestamp: 1000, value: 4.81 }], priceBasis: identity }])
    history.record([{ ...line, id: 'b', points: [{ timestamp: 1000, value: 5 }], priceBasis: identity }])
    // 基准推进后（当前=dividend），撤销恢复的是旧基准快照，载入时投影到当前基准。
    const previous = history.undo()!
    const restored = adoptDrawings(previous, dividend)
    expect(restored[0]!.points[0]!.value).toBeCloseTo(4.74, 12)
    expect(restored[0]!.priceBasis).toEqual(dividend)
    // 历史状态本身保持旧基准，重复投影结果一致（不发生复利位移）。
    const again = adoptDrawings(previous, dividend)
    expect(again[0]!.points[0]!.value).toBeCloseTo(restored[0]!.points[0]!.value, 15)
  })
})

describe('rendered basis advance decision (KlineChart 喂新K线 watcher)', () => {
  const apply = (basis: DrawingPriceBasis, value: number): number => value * basis.scale + basis.offset
  const compose = (outer: DrawingPriceBasis, inner: DrawingPriceBasis): DrawingPriceBasis =>
    ({ scale: outer.scale * inner.scale, offset: outer.scale * inner.offset + outer.offset })
  const invert = (basis: DrawingPriceBasis): DrawingPriceBasis =>
    ({ scale: 1 / basis.scale, offset: -basis.offset / basis.scale })

  it('advances the rendered basis across a dividend even when no drawings are on the chart', () => {
    // P1 返修：空图/清空/撤销到空跨除息同样必须推进目标基准（决策与图形数量无关，
    // changed=true 时 watcher 仅跳过恢复与外发，不跳过推进）。
    expect(advanceRenderedBasis(identity, dividend)).toEqual({ basis: dividend, changed: true })
    // 完整链路：除息时空图推进基准 → 新建 4.74 画线盖印新基准 → 普通刷新同基准不投影，
    // 4.74 保持 4.74（修复前盖印旧基准 1/0，下次刷新被二次投影错位成 4.67）。
    const drawn = serializeDrawings([{ ...line, points: [{ timestamp: 1000, value: 4.74 }] }], id => id, dividend)
    expect(drawn[0]!.priceBasis).toEqual(dividend)
    expect(advanceRenderedBasis(dividend, dividend).changed).toBe(false)
  })

  it('keeps unknown, readonly, unchanged and first-reliable semantics of the previous behavior', () => {
    const target: DrawingPriceBasis | null = null
    expect(advanceRenderedBasis(identity, target)).toEqual({ basis: identity, changed: false }) // 只读/未接线不动
    expect(advanceRenderedBasis(null, null)).toEqual({ basis: null, changed: false })
    expect(advanceRenderedBasis(dividend, { ...dividend })).toEqual({ basis: dividend, changed: false }) // 同基准不重复投影
    const adopt = advanceRenderedBasis(null, dividend) // 首个可靠基准：采用，无从投影
    expect(adopt).toEqual({ basis: dividend, changed: false })
  })

  it('follows later-era anchors correctly because successive chart bases cancel earlier events', () => {
    // 集成评审口径：锚定在部分权息之后的K线（later anchor），按图表级基准逐段投影依然正确——
    // F_new ∘ F_old⁻¹ 抵消两份基准共有的早先事件，只余新发生事件，不复利位移。
    // 事件变换 G(p)=(p-c)/m：10送10 → G1=p/2；10派1送2 → G2=(p-0.1)/1.2；10派2送3 → G3=(p-0.2)/1.3。
    const e1: DrawingPriceBasis = { scale: 1 / 2, offset: 0 }
    const e2: DrawingPriceBasis = { scale: 1 / 1.2, offset: -0.1 / 1.2 }
    const e3: DrawingPriceBasis = { scale: 1 / 1.3, offset: -0.2 / 1.3 }
    const afterE1 = compose(e1, { scale: 1, offset: 0 }) // 事件1后的图表级基准（最老段累计）
    const afterE2 = compose(e2, afterE1)                 // 新事件更新，复合在最外层：G2 ∘ G1
    const afterE3 = compose(e3, afterE2)
    // later anchor：事件1与2之间的K线（原始价 10，旧图表下显示仍为 10），盖印旧图表级基准，
    // 推进后只吃到事件2的变换（8.25），而不是直接套新图表级基准的重复调整（≈4.08）。
    const anchored = { ...line, points: [{ timestamp: 1000, value: 10 }], priceBasis: afterE1 }
    const projected = projectDrawings([anchored], afterE1, afterE2)[0]!
    expect(projected.points[0]!.value).toBeCloseTo(apply(e2, 10), 12)
    expect(Math.abs(projected.points[0]!.value - apply(afterE2, 10))).toBeGreaterThan(4)
    // 最老年代锚点（事件1之前，旧显示 G1(8)=4）投影后恰为新图表级基准值 3.25。
    const oldest = { ...line, id: 'o', points: [{ timestamp: 2000, value: apply(afterE1, 8) }], priceBasis: afterE1 }
    expect(projectDrawings([oldest], afterE1, afterE2)[0]!.points[0]!.value).toBeCloseTo(apply(afterE2, 8), 12)
    // 空图推进后再新建画线：盖印新基准，再次推进只施加新事件（4.74 链路的多事件推广）。
    const advance = advanceRenderedBasis(afterE2, afterE3)
    expect(advance).toEqual({ basis: afterE3, changed: true })
    const fresh = { ...line, id: 'f', points: [{ timestamp: 3000, value: 10 }], priceBasis: advance.basis }
    expect(projectDrawings([fresh], afterE2, afterE3)[0]!.points[0]!.value).toBeCloseTo(apply(e3, 10), 12)
  })
})

describe('drawing state lifecycle', () => {
  it('edits horizontal drawings with one price while preserving all timestamps and ordinary independent endpoints', () => {
    expect(applyDrawingPrices(line.points, [30], 'horizontalSegment')).toEqual([{ timestamp: 1000, value: 30 }, { timestamp: 2000, value: 30 }])
    expect(applyDrawingPrices(line.points, [40], 'horizontalRayLine')).toEqual([{ timestamp: 1000, value: 40 }, { timestamp: 2000, value: 40 }])
    expect(applyDrawingPrices(line.points, [30, 40], 'segment')).toEqual([{ timestamp: 1000, value: 30 }, { timestamp: 2000, value: 40 }])
  })
  it('undoes creation, movement and deletion without aliasing snapshots, and clears redo on new edits', () => {
    const history = new DrawingHistory()
    history.reset([])
    history.record([line])
    history.record([{ ...line, points: [{ timestamp: 1000, value: 30 }, line.points[1]] }])
    history.record([])
    expect(history.undo()?.[0].points[0].value).toBe(30)
    const previous = history.undo()!
    expect(previous[0].points[0].value).toBe(10)
    previous[0].points[0].value = 999
    expect(history.redo()?.[0].points[0].value).toBe(30)
    history.record([{ ...line, id: 'b' }])
    expect(history.redo()).toBeNull()
  })

  it('serializes only user drawings with timestamp anchors and stable pane names', () => {
    const result = serializeDrawings([
      { ...line, paneId: 'random-pane', points: [{ timestamp: 1000, value: 10, dataIndex: 30 }], isDrawing: () => false },
      { ...line, id: 'engine', name: 'bsMark' },
      { ...line, id: 'unfinished', isDrawing: () => true },
    ], id => id === 'random-pane' ? 'MACD' : id)
    expect(result).toEqual([{ ...line, paneId: 'MACD', points: [{ timestamp: 1000, value: 10 }] }])
  })
  it('does not record hover-induced library stacking order as a drawing edit', () => {
    const a = { ...line, id: 'a' }, b = { ...line, id: 'b' }
    expect(serializeDrawings([b, a], id => id)).toEqual(serializeDrawings([a, b], id => id))
  })

  it('serializes pending saves so an old response cannot overwrite a later drawing', async () => {
    const calls: string[] = []
    let release!: () => void
    const saver = new SerialDrawingSaver(async drawings => {
      calls.push(drawings[0]?.id ?? 'empty')
      if (calls.length === 1) await new Promise<void>(resolve => { release = resolve })
    })
    const first = saver.save([line])
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = saver.save([{ ...line, id: 'b' }])
    expect(calls).toEqual(['a'])
    release()
    await Promise.all([first, second])
    expect(calls).toEqual(['a', 'b'])
  })

  it('allows a retry after a failed save and surfaces that failure', async () => {
    let attempt = 0
    const saver = new SerialDrawingSaver(async () => { if (++attempt === 1) throw new Error('offline') })
    await expect(saver.save([line])).rejects.toThrow('offline')
    await expect(saver.save([line])).resolves.toBeUndefined()
    expect(attempt).toBe(2)
  })
})
