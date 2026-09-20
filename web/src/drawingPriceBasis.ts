import type { Drawing } from './drawingState'

// 固定并行接口（docs/engineering/stage-feedback-20260919.md DRAW-02）：
// DrawingPriceBasis 表示已发生权息的累计仿射变换（显示价 = 原始价 * scale + offset），
// 无事件或 raw 为 1/0。旧基准到新基准的统一变换为
// (value - old.offset) / old.scale * new.scale + new.offset，不四舍五入、不改输入。
export interface DrawingPriceBasis {
  scale: number
  offset: number
}

// 与服务端 drawings 校验同一口径：恰含 scale/offset，scale 为正有限数，offset 为有限数。
export function isDrawingPriceBasis(value: unknown): value is DrawingPriceBasis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2) return false
  return typeof record.scale === 'number' && Number.isFinite(record.scale) && record.scale > 0 &&
    typeof record.offset === 'number' && Number.isFinite(record.offset)
}

export function sameDrawingPriceBasis(a: DrawingPriceBasis, b: DrawingPriceBasis): boolean {
  return a.scale === b.scale && a.offset === b.offset
}

export function projectPriceValue(value: number, from: DrawingPriceBasis, to: DrawingPriceBasis): number {
  return (value - from.offset) / from.scale * to.scale + to.offset
}

export interface BasisAdvance {
  /** 推进后的渲染基准；与入参 from 同一引用＝原地不动，null＝维持未知（只读/未接线） */
  basis: DrawingPriceBasis | null
  /** true＝已知基准间推进，调用方须把喂新数据前按旧基准捕获的画线投影到新基准 */
  changed: boolean
}

// 喂新K线时的渲染基准推进决策（纯函数，watcher 与单测共用）：目标未知（只读回放/prop 缺省）
// 绝不自行推断；未知→已知直接采用首个可靠基准（无从投影）；已知→相同基准原地不动，不重复投影；
// 已知→新基准无条件推进——与当前图形数量无关，空图/清空/撤销到空也必须推进，否则跨权息后
// 新建画线被盖印旧基准，下次普通刷新遭二次投影错位。
export function advanceRenderedBasis(from: DrawingPriceBasis | null, to: DrawingPriceBasis | null): BasisAdvance {
  if (!to || (from !== null && sameDrawingPriceBasis(from, to))) return { basis: from, changed: false }
  return { basis: to, changed: from !== null }
}

// 画线整体投影：只换主图锚点数值（VOL/MACD 等副图指标值不套主图价格公式）；
// simpleTag 的纯数字字符串 extendData 是价格标签，随锚点同步刷新避免滞留旧基准。
// 输出全新对象（浅拷贝 styles/extendData 引用），同基准画线数值原样保留，并统一盖印目标基准。
export function projectDrawings(drawings: Drawing[], from: DrawingPriceBasis, to: DrawingPriceBasis): Drawing[] {
  const identical = sameDrawingPriceBasis(from, to)
  return drawings.map(drawing => {
    const mainPane = drawing.paneId === 'candle_pane' || drawing.paneId === undefined
    const points = drawing.points.map(point => ({
      ...point,
      value: mainPane && !identical ? projectPriceValue(point.value, from, to) : point.value,
    }))
    const projected: Drawing = { ...drawing, points, priceBasis: { ...to } }
    if (!mainPane || identical) return projected
    const label = drawing.extendData
    const oldValue = drawing.points[0]?.value
    if (drawing.name === 'simpleTag' && drawing.points.length === 1 && typeof label === 'string' &&
        Number.isFinite(Number(label.trim())) && Math.abs(Number(label.trim()) - (oldValue ?? NaN)) < 1e-9) {
      projected.extendData = projectPriceValue(oldValue!, from, to).toFixed(2)
    }
    return projected
  })
}

// 恢复/撤销/重做共用：带合法 priceBasis 的画线从其基准投影到当前基准；
// 旧无基准画线保留原值并采用当前基准（首个可靠载入基准，不猜创建日期）。
// target 缺省（prop 未接线或只读回放）时原样返回，保持旧行为。
export function adoptDrawings(drawings: Drawing[], target: DrawingPriceBasis): Drawing[] {
  return drawings.map(drawing => {
    const stored = isDrawingPriceBasis(drawing.priceBasis) ? drawing.priceBasis : null
    if (!stored || sameDrawingPriceBasis(stored, target)) {
      return { ...drawing, points: drawing.points.map(point => ({ ...point })), priceBasis: { ...target } }
    }
    return projectDrawings([drawing], stored, target)[0]!
  })
}
