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

describe('REC-CHART-B chart capture contract', () => {
  it('declares the chartCapture emit, captureState expose and optional replayView prop', async () => {
    const source = await readChart()
    expect(source).toMatch(/import type \{ ChartCapture, ChartCaptureView \} from '\.\.\/recording\/types'/)
    expect(source).toMatch(/import \{ VIEWPORT_CAPTURE_THROTTLE_MS, buildChartCapture, captureView, toCaptureBars, type CaptureSourceBar \} from '\.\.\/recording\/chartCapture'/)
    expect(source).toMatch(/chartCapture: \[ChartCapture\]/)
    expect(source).toMatch(/replayView\?: ChartCaptureView/)
    expect(source).toMatch(/defineExpose\(\{ zoomBy, moveCrosshair, resetView, deleteSelected, clearMultiSelection, undoDrawing, redoDrawing, clearDrawings, drawings, captureState \}\)/)
  })

  it('feeds bars with original date and amount so captures restore them verbatim', async () => {
    const source = await readChart()
    const toK = blockOf(source, 'function toK(', '\n')
    expect(toK).toMatch(/amount: bar\.amount/)
    expect(toK).toMatch(/date: bar\.date/)
  })

  it('captureState reads only loaded chart data and throws when the chart is missing', async () => {
    const source = await readChart()
    const capture = blockOf(source, 'function captureState(', 'let captureTimer')
    expect(capture).toMatch(/if \(!chart\) throw/)
    expect(capture).toMatch(/chart\.getDataList\(\)/)
    expect(capture).toMatch(/chart\.getVisibleRange\(\)/)
    expect(capture).toMatch(/chart\.getBarSpace\(\)\.bar/)
    expect(capture).toMatch(/captureView\(/)
    expect(capture).toMatch(/toCaptureBars\(data\)/)
    expect(capture).toMatch(/props\.chartCostPrice \?\? props\.costPrice/)
    // bars 绝不来自 props.bars（补载历史只存在于库内 loadedData）
    expect(capture).not.toMatch(/props\.bars/)
    // 语义窗格：跳过 x 轴、只收正高度
    const heights = blockOf(source, 'function semanticPaneHeights(', 'function captureState(')
    expect(heights).toMatch(/pane\.id === 'x_axis_pane'/)
    expect(heights).toMatch(/height > 0/)
    expect(heights).toMatch(/paneName\(pane\.id\)/)
  })

  it('schedules a 150ms trailing-edge capture after feed completion, history load and viewport changes', async () => {
    const source = await readChart()
    const schedule = blockOf(source, 'function scheduleChartCapture(', '// replayView 恢复')
    expect(schedule).toMatch(/props\.readOnly \|\| restoringView \|\| disposed \|\| !chart\) return/)
    expect(schedule).toMatch(/cancelChartCapture\(\)/)
    expect(schedule).toMatch(/setTimeout\(/)
    expect(schedule).toMatch(/VIEWPORT_CAPTURE_THROTTLE_MS/)
    expect(schedule).toMatch(/if \(disposed \|\| props\.readOnly \|\| restoringView \|\| !chart\) return/)
    expect(schedule).toMatch(/emit\('chartCapture', captureState\(\)\)/)
    // feed 完成（库在 loader callback 内同步应用初始数据）后调度；回放恢复排程在前、首次捕获随后
    const feed = blockOf(source, 'function feedData(', '// REC-CHART 图表捕获')
    expect(feed).toMatch(/callback\(loadedData, \{ forward: hasMoreForward, backward: false \}\)\n      scheduleReplayRestore\(\)\n      scheduleChartCapture\(\)/)
    // 补历史成功后调度
    const earlier = blockOf(source, 'async function loadEarlierBars(', 'function feedData(')
    expect(earlier).toMatch(/callback\(older, \{ forward: result\.hasMore \}\)\n    scheduleChartCapture\(\)/)
    // 视窗变化后调度
    expect(source).toMatch(/subscribeAction\('onVisibleRangeChange', \(\) => \{ emit\('visibleCount', visibleCount\(\)\); updateAnchorDots\(\); scheduleChartCapture\(\) \}\)/)
  })

  it('cancels the pending capture timer on unmount', async () => {
    const source = await readChart()
    expect(blockOf(source, 'onUnmounted(() => {', 'dispose(host.value)')).toMatch(/cancelChartCapture\(\)/)
  })

  it('restores a replay view by timestamp anchor, barSpace and pane heights, never re-applying the same view', async () => {
    const source = await readChart()
    const restore = blockOf(source, 'function applyReplayView(', 'watch(() => props.replayView')
    expect(restore).toMatch(/if \(!view \|\| !chart \|\| disposed \|\| !loadedData\.length\) return/)
    expect(restore).toMatch(/if \(appliedReplayView === key\) return/)
    expect(restore).toMatch(/restoringView = true/)
    expect(restore).toMatch(/cancelChartCapture\(\)/)
    // 语义窗格高度按 actualPaneId 恢复
    expect(restore).toMatch(/chart\.setPaneOptions\(\{ id: actualPaneId\(name\), height \}\)/)
    expect(restore).toMatch(/chart\.setBarSpace\(view\.barSpace\)/)
    // 右侧锚点按时间戳重定位，不套旧 dataIndex
    expect(restore).toMatch(/chart\.scrollToTimestamp\(anchor\)/)
    expect(restore).not.toMatch(/scrollToDataIndex/)
    expect(restore).toMatch(/queueMicrotask\(\(\) => \{ restoringView = false \}\)/)
    expect(source).toMatch(/watch\(\(\) => props\.replayView, view => \{ if \(view\) applyReplayView\(view\) \}\)/)
    expect(source).toMatch(/let appliedReplayView: string \| null = null/)
  })

  it('schedules the replay restore after the default reset settles and re-applies it on every data version', async () => {
    const source = await readChart()
    // 挂载顺序契约：先 feed 再程序化 resetView(false)（初始化复位，不算用户导航），回放恢复只允许经 rAF 排到两者之后（不得被默认视窗覆盖）
    expect(source).toMatch(/feedData\(\); resetView\(false\)/)
    const schedule = blockOf(source, 'let replayRestoreFrame', 'watch(() => props.replayView')
    expect(schedule).toMatch(/if \(!props\.replayView\) return/)
    expect(schedule).toMatch(/requestAnimationFrame/)
    expect(schedule).toMatch(/cancelAnimationFrame/)
    // 卸载后不得恢复；恢复完成后重新调度捕获
    expect(schedule).toMatch(/if \(disposed \|\| !chart \|\| !props\.replayView\) return/)
    expect(schedule).toMatch(/applyReplayView\(props\.replayView\)\n    scheduleChartCapture\(\)/)
    // 卸载撤销挂起的恢复帧
    expect(source).toMatch(/cancelChartCapture\(\); cancelReplayRestore\(\)/)
    // 新数据版本必须重放同 view：feedData 先作废去重键（appliedReplayView 去重只作用于同一数据版本内）
    const feed = blockOf(source, 'function feedData(', '// REC-CHART 图表捕获')
    expect(feed).toMatch(/dataVersion\+\+\n  \/\/ [^\n]+\n  appliedReplayView = null/)
    expect(feed).not.toMatch(/applyReplayView\(props\.replayView\)/)
  })

  it('routes timer capture failures to the additive captureError emit while captureState still throws', async () => {
    const source = await readChart()
    expect(source).toMatch(/chartCapture: \[ChartCapture\]; captureError: \[string\]/)
    const schedule = blockOf(source, 'function scheduleChartCapture(', '// replayView 恢复')
    expect(schedule).toMatch(/try \{\n      emit\('chartCapture', captureState\(\)\)\n    \} catch/)
    // 只有存活的非只读图表才向父层上报（只读回放静默），直接调用 captureState 仍原样抛出
    expect(schedule).toMatch(/if \(!disposed && !props\.readOnly\) emit\('captureError', error instanceof Error \? error\.message : String\(error\)\)/)
    expect(blockOf(source, 'function captureState(', 'let captureTimer')).toMatch(/if \(!chart\) throw/)
  })
})
