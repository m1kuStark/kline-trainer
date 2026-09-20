// REC-CHART-C 语义图形操作助手：params 序列化与 move 上报去重表（docs/engineering/recording-contract.md）。
// 纯函数模块，不接触 klinecharts 实例；组件层只做接线，行为回归在 server/test/recording-drawing-operations.test.ts。
import type { JsonValue } from './types'
import type { Drawing } from '../drawingState'

// params 只携带有限 JSON（id/name/paneId/points），不透出库实例。serializeDrawings 已过滤
// 半成品点位，这里按有限性兜底：不完整端点（库取点中断残留）绝不进录制流。
export function drawingOperationParams(drawing: Drawing): JsonValue {
  return {
    id: drawing.id,
    name: drawing.name,
    paneId: drawing.paneId,
    points: drawing.points
      .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
      .map(point => ({ timestamp: point.timestamp, value: point.value })),
  }
}

// move 上报去重：window pointerup 兜底会抢在 onPressedMoveEnd 之前消费历史布尔，move 依据只能是
// "overlayID＋最近一次已上报快照"的指纹比较。表必须与当前图形集合同步——restoreDrawings（加载、
// 撤销、重做、清空）后整体重播种：否则已加载/已撤销图形的按压被误报 move；撤销后移回旧端点的
// 真实 move 被旧指纹误吞。删除路径逐 id 清除，防同 id 复现时继承陈旧基线。
export type ReportedDrawings = Map<string, string>

export function hasUnreportedMove(reported: ReportedDrawings, drawing: Drawing): boolean {
  return reported.get(drawing.id) !== JSON.stringify(drawing)
}

export function markDrawingReported(reported: ReportedDrawings, drawing: Drawing): void {
  reported.set(drawing.id, JSON.stringify(drawing))
}

// 以当前序列化图形集为准精确同步：清掉全部陈旧 id，再按现状播种基线（未上报过的图形从此静默）
export function syncReportedDrawings(reported: ReportedDrawings, drawings: Drawing[]): void {
  reported.clear()
  for (const drawing of drawings) markDrawingReported(reported, drawing)
}
