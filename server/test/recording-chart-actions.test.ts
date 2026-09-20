import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { exerciseChartZoom } from './helpers/chart-zoom'

const chartPath = new URL('../../web/src/components/KlineChart.vue', import.meta.url)

// 源文件为 CRLF，读入后归一化成 LF，函数级断言才能用 \n 书写
async function readChart(): Promise<string> {
  return (await readFile(chartPath, 'utf8')).replace(/\r\n/g, '\n')
}

// 取 startMarker 起、至 endMarker 前的源码块（函数级契约断言，避免全文件正则误命中）
function blockOf(source: string, startMarker: string, endMarker: string): string {
  const from = source.indexOf(startMarker)
  expect(from).toBeGreaterThanOrEqual(0)
  const to = endMarker ? source.indexOf(endMarker, from + startMarker.length) : -1
  return to < 0 ? source.slice(from) : source.slice(from, to)
}

describe('REC-CHART-C operation emit surface', () => {
  it('declares the operation emit typed from recording/types without widening the existing emits', async () => {
    const source = await readChart()
    // 类型从 recording/types 导入（与 chartCapture 的既有导入行并存，保持捕获契约测试的字面量）
    expect(source).toMatch(/import type \{ Action, JsonValue \} from '\.\.\/recording\/types'/)
    expect(source).toMatch(/operation: \[\{ action: Action; params\?: JsonValue \}\]/)
  })

  it('gates every operation behind non-readOnly, non-restoring, mounted state and never passes the chart instance', async () => {
    const source = await readChart()
    // 总闸：只读回放、恢复图形期间与卸载后绝不外发任何动作
    const gate = blockOf(source, 'function emitOperation(', 'function findDrawing(')
    expect(gate).toMatch(/if \(props\.readOnly \|\| restoringDrawings \|\| disposed\) return/)
    expect(gate).toMatch(/emit\('operation', params === undefined \? \{ action \} : \{ action, params \}\)/)
    // params 只携带语义图形（id/name/paneId/points）的有限 JSON，不透出库实例；
    // 序列化委托给 recording/drawingOperations.ts（有限性兜底的行为回归见 recording-drawing-operations.test.ts）
    expect(source).toMatch(/import \{ drawingOperationParams, hasUnreportedMove, markDrawingReported, syncReportedDrawings, type ReportedDrawings \} from '\.\.\/recording\/drawingOperations'/)
    expect(source).not.toMatch(/emit\('operation', \{\s*chart/)
  })
})

describe('REC-CHART-C drawing action entries', () => {
  it('reports create at onDrawEnd only for completed non-text drawings; textAnnotation only opens its panel', async () => {
    const source = await readChart()
    const onDrawEnd = blockOf(source, 'onDrawEnd: event =>', 'onPressedMoveEnd:')
    // 文本分支只开面板；create 只在非文本分支发出
    expect(onDrawEnd).toMatch(/if \(event\.overlay\.name === 'textAnnotation'\) openTextPanel\(event\.overlay\.id, true\)\n        else \{ recordDrawings\(\); emitDrawingAction\('chart\.drawing\.create', event\.overlay\.id\) \}/)
    expect(onDrawEnd).not.toMatch(/textAnnotation[^']*chart\.drawing\.create/)
  })

  it('reports create after a successful finishPolyline and cancel when the fixed points are fewer than two', async () => {
    const source = await readChart()
    const finish = blockOf(source, 'function finishPolyline(', 'watch(() => props.drawTool')
    expect(finish).toMatch(/if \(fixed\.length < 2\) \{ cancelDrawing\(\); emit\('toolChange', null\); return \}/)
    expect(finish).toMatch(/recordDrawings\(\)\n  emitDrawingAction\('chart\.drawing\.create', overlay\.id\)/)
  })

  it('reports move only when the overlay fingerprint actually changed, never off the raced history bool', async () => {
    const source = await readChart()
    // window pointerup 兜底先写历史会消费掉 recordDrawings 的布尔，move 依据改为逐 overlay 快照比较
    expect(source).toMatch(/const lastReportedDrawing: ReportedDrawings = new Map\(\)/)
    const move = blockOf(source, 'function emitMoveIfChanged(', 'function emitDrawingAction(')
    expect(move).toMatch(/if \(!hasUnreportedMove\(lastReportedDrawing, drawing\)\) return/)
    expect(move).toMatch(/markDrawingReported\(lastReportedDrawing, drawing\)/)
    expect(move).toMatch(/emitOperation\('chart\.drawing\.move', drawingOperationParams\(drawing\)\)/)
    expect(source).toMatch(/onPressedMoveEnd: event => \{ updateAnchorDots\(\); recordDrawings\(\); emitMoveIfChanged\(event\.overlay\.id\) \}/)
    // 基线表与当前图形集合同步：restoreDrawings（加载/撤销/重做/清空）后整体重播种——
    // 已加载/已撤销图形的首次按压不得误报 move，移回旧端点的真实 move 不得被旧指纹吞掉
    const restore = blockOf(source, 'function restoreDrawings(', 'function undoDrawing(')
    expect(restore).toMatch(/syncReportedDrawings\(lastReportedDrawing, drawings\(\)\)/)
  })

  it('reports one batched edit only when applyEdit actually overrode at least one overlay', async () => {
    const source = await readChart()
    const edit = blockOf(source, 'function applyEdit(', '// Delete 删除选中画线')
    expect(edit).toMatch(/let applied = 0/)
    expect(edit).toMatch(/if \(!applied\) \{ closePanels\(\); return \}/)
    expect(edit).toMatch(/edited\.forEach\(drawing => markDrawingReported\(lastReportedDrawing, drawing\)\)/)
    expect(edit).toMatch(/emitOperation\('chart\.drawing\.edit', \{ drawings: edited\.map\(drawingOperationParams\) \}\)/)
  })

  it('reports delete only for drawings that really exist, from both the context menu and Delete key', async () => {
    const source = await readChart()
    const menu = blockOf(source, 'function removeViaMenu(', '// 选项卡式编辑面板')
    expect(menu).toMatch(/const removed = ids\.map\(id => findDrawing\(id\)\)\.filter\(\(drawing\): drawing is Drawing => !!drawing\)/)
    expect(menu).toMatch(/if \(!removed\.length\) \{ closePanels\(\); return \}/)
    expect(menu).toMatch(/emitOperation\('chart\.drawing\.delete', \{ ids: removed\.map\(drawing => drawing\.id\), drawings: removed\.map\(drawingOperationParams\) \}\)/)
    // 删除路径同步清除基线表条目，防同 id 复现时继承陈旧基线
    expect(menu).toMatch(/removed\.forEach\(drawing => lastReportedDrawing\.delete\(drawing\.id\)\)/)
    const selected = blockOf(source, 'function deleteSelected(', 'type TextForm')
    expect(selected).toMatch(/if \(!removed\.length\) return false/)
    expect(selected).toMatch(/recordDrawings\(\)\n  emitOperation\('chart\.drawing\.delete'/)
    expect(selected).toMatch(/removed\.forEach\(drawing => lastReportedDrawing\.delete\(drawing\.id\)\)/)
    expect(selected).toMatch(/return true/)
  })

  it('reports undo/redo only on a successful history step and clear only after confirm with non-empty drawings', async () => {
    const source = await readChart()
    expect(source).toMatch(/function undoDrawing\(\): void \{[^\n]*emitOperation\('chart\.drawing\.undo'\) \}/)
    expect(source).toMatch(/function redoDrawing\(\): void \{[^\n]*emitOperation\('chart\.drawing\.redo'\) \}/)
    const clear = blockOf(source, 'function clearDrawings(', 'function clampCount(')
    expect(clear).toMatch(/!drawings\(\)\.length \|\| !window\.confirm/)
    expect(clear).toMatch(/const cleared = drawings\(\)\.length/)
    expect(clear).toMatch(/emitOperation\('chart\.drawing\.clear', \{ count: cleared \}\)/)
  })

  it('reports cancel only when a real in-progress overlay or a new text annotation is abandoned', async () => {
    const source = await readChart()
    // 取点取消：只有确实存在 isDrawing overlay 才发，params 带半成品的 id/name/points
    const cancel = blockOf(source, 'function cancelDrawing(', 'function drawingEvents(')
    expect(cancel).toMatch(/if \(!drawing\) return/)
    expect(cancel).toMatch(/emitOperation\('chart\.drawing\.cancel', \{ id: drawing\.id, name: drawing\.name, points \}\)/)
    // 文本面板：新建放弃＝cancel；已存在标注的取消不改数据、不上报
    const text = blockOf(source, 'function cancelTextPanel(', 'function confirmTextPanel(')
    expect(text).toMatch(/if \(form\?\.isNew\) \{/)
    expect(text).toMatch(/if \(drawing\) emitOperation\('chart\.drawing\.cancel', drawingOperationParams\(drawing\)\)/)
  })

  it('completes the text panel as create when new and edit when existing, after the overlay is updated', async () => {
    const source = await readChart()
    const confirm = blockOf(source, 'function confirmTextPanel(', '// 菜单/面板打开期间')
    expect(confirm).toMatch(/recordDrawings\(\)\n  emitDrawingAction\(form\.isNew \? 'chart\.drawing\.create' : 'chart\.drawing\.edit', form\.id\)/)
  })

  it('reports chart.tool only when a user tool really activates; auto-complete back to null is silent', async () => {
    const source = await readChart()
    const watch = blockOf(source, 'watch(() => props.drawTool', '// 多选模式关闭')
    expect(watch).toMatch(/if \(!chart \|\| props\.readOnly\) return\n  cancelDrawing\(\)\n  if \(tool\) \{\n    emitOperation\('chart\.tool', \{ name: tool \}\)/)
    // null 分支只恢复滚动，不发任何动作
    expect(watch).toMatch(/else \{\n    chart\.setScrollEnabled\(true\)\n  \}/)
  })
})

describe('REC-CHART-C pointerup fallback and viewport operations', () => {
  it('keeps the window pointerup fallback history-only so move/create come from their source events', async () => {
    const source = await readChart()
    const fallback = blockOf(source, 'function completePointerAction(', 'onMounted(() => {')
    expect(fallback).toMatch(/queueMicrotask\(\(\) => \{ updateAnchorDots\(\); recordDrawings\(\) \}\)/)
    // 兜底绝不冒充动作来源：不发 operation、不发 create/move
    expect(fallback).not.toMatch(/emitOperation|emitDrawingAction|emitMoveIfChanged/)
  })

  it('schedules the viewport report on user navigation ends with a 150ms trailing edge and re-checks suppression at fire time', async () => {
    const source = await readChart()
    const schedule = blockOf(source, 'function scheduleViewportOperation(', '// replayView 恢复')
    expect(schedule).toMatch(/if \(props\.readOnly \|\| disposed\) return/)
    expect(schedule).toMatch(/cancelViewportOperation\(\)/)
    expect(schedule).toMatch(/setTimeout\(/)
    expect(schedule).toMatch(/VIEWPORT_CAPTURE_THROTTLE_MS/)
    // 触发时再查一次：只读、恢复视窗与卸载期间到点的旧定时器也不得外发
    expect(schedule).toMatch(/if \(disposed \|\| props\.readOnly \|\| restoringView \|\| !chart\) return/)
    expect(schedule).toMatch(/emitOperation\('chart\.viewport', \{ fromTimestamp: view\.fromTimestamp, toTimestamp: view\.toTimestamp, barSpace: view\.barSpace, paneHeights: view\.paneHeights \}\)/)
  })

  it('wires every user gesture end to the viewport report exactly once per path', async () => {
    const source = await readChart()
    expect(blockOf(source, 'function onWheel(', 'onMounted(() => {')).toMatch(/chart\?\.scrollByDistance\([^\n]+\)\n  scheduleViewportOperation\(\)/)
    // 框选右滑/左滑、轴缩放松手、窗格分隔松手、中键平移松手共 5 处
    const up = blockOf(source, 'function onPointerUp(', 'function onPaneDblClick(')
    expect((up.match(/scheduleViewportOperation\(\)/g) ?? []).length).toBe(5)
    expect(up).toMatch(/if \(event\.pointerId === paneResizePointerId\) \{ paneResizePointerId = null; scheduleViewportOperation\(\); return \}/)
    expect(up).toMatch(/if \(axisScaleDrag\) \{ axisScaleDrag = false; scheduleViewportOperation\(\); return \}/)
    for (const count of [1, 150]) {
      const zoom = await exerciseChartZoom(1 / 1.3, count)
      expect(zoom.actions.filter(action => action === 'viewport')).toHaveLength(1)
      expect(zoom.barSpace).toBeGreaterThan(6)
    }
    expect((await exerciseChartZoom(1)).actions).toEqual([])
    expect((await exerciseChartZoom(NaN)).actions).toEqual([])
  })

  it('never counts mount initialization, feed, history backfill, layout resize or replay restore as user navigation', async () => {
    const source = await readChart()
    // 复位显式区分用户与程序：默认 userInitiated=true（回到最新按钮、Home 键）才上报；
    // 挂载初始化与父层程序化复位（timeframe/数据加载）必须传 false
    const reset = blockOf(source, 'function resetView(', 'function selectionRect(')
    expect(reset).toMatch(/function resetView\(userInitiated = true\)/)
    expect(reset).toMatch(/if \(userInitiated\) scheduleViewportOperation\(\) \}/)
    expect(source).toMatch(/feedData\(\); resetView\(false\)/)
    // 数据替换作废挂起的视窗上报：旧数据上的用户手势不得在新 timeframe 数据上落账
    expect(blockOf(source, 'function feedData(', '// REC-CHART 图表捕获')).toMatch(/cancelViewportOperation\(\)/)
    expect(blockOf(source, 'function feedData(', '// REC-CHART 图表捕获')).not.toMatch(/scheduleViewportOperation/)
    expect(blockOf(source, 'async function loadEarlierBars(', 'function feedData(')).not.toMatch(/scheduleViewportOperation/)
    expect(blockOf(source, 'function updateMarkerRail(', 'function projectTradeTime(')).not.toMatch(/scheduleViewportOperation/)
    expect(source).toMatch(/markerResizeObserver = new ResizeObserver\(\(\) => \{ enforceVisibleLimit\(\); updateMarkerRail\(\) \}\)/)
    // replayView 恢复与卸载撤销挂起的上报
    expect(blockOf(source, 'function applyReplayView(', 'watch(() => props.replayView')).toMatch(/cancelViewportOperation\(\)/)
    expect(blockOf(source, 'onUnmounted(() => {', 'dispose(host.value)')).toMatch(/cancelChartCapture\(\); cancelReplayRestore\(\); cancelViewportOperation\(\)/)
  })
})
