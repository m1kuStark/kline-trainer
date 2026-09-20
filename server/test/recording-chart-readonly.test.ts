import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

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

describe('REC-CHART-A readOnly chart contract', () => {
  it('declares a readOnly prop that defaults to false so the default editing mode is unchanged', async () => {
    const source = await readChart()
    expect(source).toMatch(/readOnly\?: boolean/)
    expect(source).toMatch(/readOnly: false/)
  })

  it('restores saved drawings as display-only: lock+ignoreEvent track readOnly and restore itself is never blocked', async () => {
    const source = await readChart()
    const restore = blockOf(source, 'function restoreDrawings(', 'function undoDrawing(')
    // 恢复图形属于允许的展示：内部清理（removeOverlay/取消取点）不得被只读拦住
    expect(restore).toMatch(/if \(!chart\) return\n  restoringDrawings = true/)
    expect(restore).not.toMatch(/props\.readOnly \|\| !chart/)
    // 只读 overlay 纯渲染：lock 与 ignoreEvent 都挂 props.readOnly，非只读保持原值 false
    expect(restore).toMatch(/lock: props\.readOnly, ignoreEvent: props\.readOnly \} as OverlayCreate/)
  })

  it('guards every drawing write entry so readOnly never emits drawingsChange', async () => {
    const source = await readChart()
    // 记录总闸：recordDrawings 直接 return，拖动结束/取点完成等链路都不会外发 drawingsChange
    expect(source).toMatch(/if \(props\.readOnly \|\| restoringDrawings \|\| disposed \|\| !restoredDrawings\) return/)
    // undo/redo 是除 recordDrawings 外仅有的 emit('drawingsChange') 入口
    expect(source).toMatch(/function undoDrawing\(\): void \{ if \(props\.readOnly\) return/)
    expect(source).toMatch(/function redoDrawing\(\): void \{ if \(props\.readOnly\) return/)
    expect(source).toMatch(/if \(props\.readOnly \|\| !chart \|\| !drawings\(\)\.length \|\| !window\.confirm/)
    expect(blockOf(source, 'function deleteSelected(', '\n}\n')).toMatch(/if \(props\.readOnly \|\| !chart\) return false/)
    expect(source).toMatch(/if \(props\.readOnly \|\| !chart \|\| !ctxMenu\.value\) return/)
    expect(blockOf(source, 'function applyEdit(', '// Delete 删除选中画线')).toMatch(/if \(props\.readOnly \|\| !chart\) return/)
    expect(source).toMatch(/if \(props\.readOnly \|\| !chart \|\| !form \|\| !form\.text\.trim\(\)/)
    // 绘图启动 watch：只读下不得创建取点 overlay
    expect(source).toMatch(/watch\(\(\) => props\.drawTool, tool => \{\n  if \(!chart \|\| props\.readOnly\) return/)
  })

  it('disables the right-click edit menu and overlay dragging in readOnly', async () => {
    const source = await readChart()
    // 右键菜单：原生右键抑制与 openCtxMenu 双入口都拦（库内 onRightClick 最终也走 openCtxMenu）
    expect(source).toMatch(/function openCtxMenu\(overlayId: string, x: number, y: number\): void \{\n  if \(props\.readOnly \|\| !host\.value\) return/)
    expect(source).toMatch(/if \(props\.readOnly \|\| props\.drawTool\) return/)
    // 拖动：按下命中补齐（startPressedMove/pressed/selected 状态）会绕过库的 ignoreEvent，必须整段拦下
    const bubble = blockOf(source, 'function onHostMouseDownBubble(', 'function dispatchSyntheticAxisMove(')
    expect(bubble).toMatch(/__klineSynthetic\) return\n  \/\/ [^\n]*\n  if \(props\.readOnly\) return/)
    // 中键平移的临时锁定照旧，但恢复必须回 props.readOnly——不得把只读锁解成 false
    expect(source).toMatch(/userOverlays\.forEach\(overlay => \{ overlay\.lock = true \}\)/)
    expect(source).toMatch(/userOverlays\.forEach\(overlay => \{ overlay\.lock = props\.readOnly \}\)/)
  })

  it('keeps panning, zooming and crosshair free of readOnly guards', async () => {
    const source = await readChart()
    expect(blockOf(source, 'function onWheel(', 'onMounted(() => {')).not.toMatch(/props\.readOnly/)
    expect(blockOf(source, 'function zoomBy(', 'function moveCrosshair(')).not.toMatch(/props\.readOnly/)
    expect(blockOf(source, 'function moveCrosshair(', 'function resetView(')).not.toMatch(/props\.readOnly/)
    expect(blockOf(source, 'function resetView(', 'function selectionRect(')).not.toMatch(/props\.readOnly/)
  })
})
