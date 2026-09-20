import { describe, expect, it } from 'vitest'
import {
  drawingOperationParams,
  hasUnreportedMove,
  markDrawingReported,
  syncReportedDrawings,
  type ReportedDrawings,
} from '../../web/src/recording/drawingOperations'

// 行为回归（REC-CHART-C 评审缺陷）：lastReportedDrawing 基线表此前从不被 restoreDrawings
// 初始化/复位——加载或撤销后的图形首次按压被误报 move，撤销后移回旧端点的真实 move 被误吞；
// params 对不完整点位（timestamp/value 非有限）未设兜底。
const lineAt = (value: number, id = 'overlay_1'): { id: string; name: string; paneId: string; points: Array<{ timestamp: number; value: number }> } => ({
  id,
  name: 'segment',
  paneId: 'candle_pane',
  points: [{ timestamp: 1000, value }, { timestamp: 2000, value: value + 10 }],
})

function simulateMove(reported: ReportedDrawings, drawing: ReturnType<typeof lineAt>): boolean {
  if (!hasUnreportedMove(reported, drawing)) return false
  markDrawingReported(reported, drawing)
  return true
}

describe('REC-CHART-C reported-drawing baseline map', () => {
  it('stays silent when a freshly loaded drawing is pressed without moving (no false move)', () => {
    const reported: ReportedDrawings = new Map()
    syncReportedDrawings(reported, [lineAt(10), lineAt(20, 'overlay_2')])
    // 点击/按压终点（onPressedMoveEnd 空操作）不得上报 move
    expect(simulateMove(reported, lineAt(10))).toBe(false)
    expect(simulateMove(reported, lineAt(20, 'overlay_2'))).toBe(false)
  })

  it('reports a real move and records the new snapshot as the baseline', () => {
    const reported: ReportedDrawings = new Map()
    syncReportedDrawings(reported, [lineAt(10)])
    expect(simulateMove(reported, lineAt(30))).toBe(true)
    // 同一终态的重复 move-end 不再上报
    expect(simulateMove(reported, lineAt(30))).toBe(false)
  })

  it('reseeds on restore so an undone drawing moved back to its former endpoint is still reported', () => {
    const reported: ReportedDrawings = new Map()
    // create@10 → move 到 30（基线=30）→ undo 恢复到 10：陈旧基线 30 若不重播种，移回 30 会被吞
    syncReportedDrawings(reported, [lineAt(10)])
    simulateMove(reported, lineAt(30))
    // 撤销后 restoreDrawings 以当前（已回退）图形重播种
    syncReportedDrawings(reported, [lineAt(10)])
    expect(simulateMove(reported, lineAt(10))).toBe(false)
    expect(simulateMove(reported, lineAt(30))).toBe(true)
  })

  it('syncs exactly to the current drawings: stale ids from before the restore are removed', () => {
    const reported: ReportedDrawings = new Map()
    syncReportedDrawings(reported, [lineAt(10), lineAt(20, 'overlay_2')])
    simulateMove(reported, lineAt(20, 'overlay_2'))
    // 清空/撤销后集合只剩 overlay_1：overlay_2 的基线必须消失
    syncReportedDrawings(reported, [lineAt(10)])
    expect([...reported.keys()]).toEqual(['overlay_1'])
  })

  it('drops the baseline of deleted drawings so a recreated id starts unreported-clean', () => {
    const reported: ReportedDrawings = new Map()
    const deleted = lineAt(10)
    markDrawingReported(reported, deleted)
    // removeViaMenu/deleteSelected 的清理路径
    reported.delete(deleted.id)
    expect(reported.has(deleted.id)).toBe(false)
    expect(simulateMove(reported, lineAt(10))).toBe(true)
  })
})

describe('REC-CHART-C drawing operation params', () => {
  it('carries only bounded semantic fields and drops points with non-finite timestamp or value', () => {
    const params = drawingOperationParams({
      id: 'overlay_1',
      name: 'segment',
      paneId: 'candle_pane',
      points: [
        { timestamp: 1000, value: 10.5 },
        { timestamp: Number.NaN, value: 20 },
        { timestamp: 2000, value: Number.POSITIVE_INFINITY },
      ],
      styles: { line: { color: '#fff' } },
      extendData: { tag: 'x' },
    })
    // 半成品点位被过滤；styles/extendData 等库侧附加字段绝不透出
    expect(params).toEqual({
      id: 'overlay_1',
      name: 'segment',
      paneId: 'candle_pane',
      points: [{ timestamp: 1000, value: 10.5 }],
    })
    expect(JSON.parse(JSON.stringify(params))).toEqual(params)
  })
})
