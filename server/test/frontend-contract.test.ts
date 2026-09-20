import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { exerciseChartZoom } from './helpers/chart-zoom'

const chartPath = new URL('../../web/src/components/KlineChart.vue', import.meta.url)
const trainingPath = new URL('../../web/src/views/Training.vue', import.meta.url)

describe('M2 chart interaction contract', () => {
  it('registers shared transparent measurement labels without changing the Fibonacci tool name', async () => {
    const overlays = await readFile(new URL('../../web/src/drawingOverlays.ts', import.meta.url), 'utf8')
    expect(overlays).toMatch(/\['fibonacciLine', 3\]/)
    expect(overlays).toMatch(/name === 'percentageLine' \|\| name === 'fibonacciLine'/)
    expect(overlays).toMatch(/backgroundColor: 'transparent', borderSize: 0/)
  })
  it('starts box select only on the draw-pane layer and supports right-drag zoom-in / left-drag zoom-out', async () => {
    const source = await readFile(chartPath, 'utf8')
    // 框选在任一绘图 pane 启动（主副图同权，用户 D4 验收拍板），x 轴除外
    expect(source).toMatch(/if \(!isDrawPane\(paneIdAt\(event\.clientY\)\)\) return/)
    expect(source).toMatch(/if \(end >= selectStartX\)/)
    expect(source).toMatch(/const dragWidth = selectStartX - end/)
    expect(source).toMatch(/current \* drawable \/ dragWidth/)
  })

  it('confines box-select visuals and zoom range to the chart plot area, clear of the price/time axes (no leaking into the console)', async () => {
    const source = await readFile(chartPath, 'utf8')
    // 绘图区边界：右缘＝价格轴左缘、底缘＝时间轴上缘（用户 D1 验收反馈：选中框不得侵入坐标轴）
    expect(source).toMatch(/function computePlotBounds\(\): void/)
    expect(source).toMatch(/getSize\('x_axis_pane'\)/)
    expect(source).toMatch(/plotBounds = \{ right: yAxis\.left, top: pane\.top, bottom: xAxis\.top \}/)
    expect(source).toMatch(/Math\.max\(0, Math\.min\(plotBounds\?\.right \?\? hostRect\?\.width \?\? x, x\)\)/)
    expect(source).toMatch(/rect\.style\.top = `\$\{plotBounds\.top\}px`/)
    expect(source).toMatch(/\.chart-wrap \{[^}]*overflow: hidden/)
  })

  it('colors the last price line by change vs previous close in CN convention and re-applies it after theme switches', async () => {
    const source = await readFile(chartPath, 'utf8')
    expect(source).toMatch(/function applyLastPriceStyle\(\): void/)
    expect(source).toMatch(/last\.close > prev\.close/)
    expect(source).toMatch(/last\.close < prev\.close/)
    expect(source).toMatch(/watch\(theme, value => \{ chart\?\.setStyles\(chartStyles\(value\)\); applyLastPriceStyle\(\) \}\)/)
    const themeSource = await readFile(new URL('../../web/src/theme.ts', import.meta.url), 'utf8')
    expect(themeSource).toMatch(/last: \{ upColor: '#ef4444', downColor: '#16a34a', noChangeColor: '#94a3b8'/)
  })

  it('runs drawings through the M3 mode machine: console-docked toolbar, box-select isolated, trade hotkeys disabled (D1)', async () => {
    const source = await readFile(chartPath, 'utf8')
    // 画线模式下不启动框选：事件放行给 klinecharts overlay 取点交互
    expect(source).toMatch(/if \(props\.drawTool\) return/)
    // 指针命中用户画线（锚点±8px/线体≤7px）时同样放行：拖动已画线段不得触发框选（用户 D1 验收反馈）
    expect(source).toMatch(/if \(hitTestUserOverlay\(event\.clientX, event\.clientY\)\) return/)
    expect(source).toMatch(/function distanceToSegment\(/)
    // 取点期间锁定平移；退出/切换前取消未完成取点（库不处理 Esc，取消自行实现）
    expect(source).toMatch(/function cancelDrawing\(\): void/)
    expect(source).toMatch(/isDrawing\?\.\(\)/)
    expect(source).toMatch(/onDrawEnd: event => \{\s*emit\('toolChange', null\)/)
    const trainingSource = await readFile(trainingPath, 'utf8')
    // 工具条停靠训练控制台底部（用户 D1 验收反馈改定：不遮挡图表），内容区滚动观察
    expect(trainingSource).toMatch(/class="console-scroll"/)
    expect(trainingSource).toMatch(/class="draw-toolbar"/)
    expect(trainingSource).toMatch(/DRAW_TOOLS/)
    expect(trainingSource).toMatch(/drawTool = drawTool === tool\.name \? null : tool\.name/)
    // 画线模式下 Space/B/S 禁用（防误推进/误交易）、Esc 退出、状态条提示
    expect(trainingSource).toMatch(/if \(drawTool\.value\) \{/)
    expect(trainingSource).toMatch(/event\.key === 'Escape'/)
    expect(trainingSource).toMatch(/\['b', 'B', 's', 'S'\]\.includes\(event\.key\)/)
    expect(trainingSource).toMatch(/画线模式：/)
    expect(trainingSource).toMatch(/:draw-tool="drawTool"/)
    // 绝对定位文本为已裁剪功能（M3 拍板），不得回潮
    expect(source).not.toMatch(/absoluteTexts|__absoluteText/)
  })

  it('replaces the library right-click delete with an edit/delete context menu and supports Delete-key removal (D2)', async () => {
    const source = await readFile(chartPath, 'utf8')
    // 右键接管：preventDefault 抑制库默认"右键即删除"，改为弹出菜单；取点中右键＝取消绘制
    expect(source).toMatch(/onRightClick: event => \{/)
    expect(source).toMatch(/event\.preventDefault\?\.\(\)/)
    expect(source).toMatch(/if \(\(event\.overlay as RuntimeOverlay\)\.isDrawing\(\)\) \{/)
    expect(source).toMatch(/cancelDrawing\(\); emit\('toolChange', null\); return/)
    expect(source).toMatch(/编辑划线/)
    expect(source).toMatch(/删除画线/)
    // 编辑面板四类参数：颜色/粗细/样式/端点价位（不编辑横坐标），确定走 overrideOverlay
    expect(source).toMatch(/type: 'color'|type="color"/)
    expect(source).toMatch(/端点\{\{ i \+ 1 \}\}价位/)
    expect(source).toMatch(/value="solid">实线/)
    expect(source).toMatch(/overrideOverlay\(\{ id: form\.id, styles: \{ line \}, points \}\)/)
    // Delete 删除选中画线（选中态由 onSelected/onDeselected 跟踪）
    expect(source).toMatch(/function deleteSelected\(\): boolean/)
    expect(source).toMatch(/onSelected: event => \{ selectedOverlayId\.value = event\.overlay\.id \}/)
    // 菜单/面板锚定图表宿主层内（口径修订七），打开期间拦截训练热键
    expect(source).toMatch(/function onGlobalPointerDown\(event: PointerEvent\): void/)
    expect(source).toMatch(/function onPanelKeydown\(event: KeyboardEvent\): void/)
    const trainingSource = await readFile(trainingPath, 'utf8')
    expect(trainingSource).toMatch(/event\.key === 'Delete'/)
    expect(trainingSource).toMatch(/deleteSelected\(\)/)
    // 默认样式（用户 D2 验收反馈）：1px 虚线；端点价位回读按价格两位小数取整
    const themeSource = await readFile(new URL('../../web/src/theme.ts', import.meta.url), 'utf8')
    expect(themeSource).toMatch(/line: \{ color: DRAW_DEFAULT_COLOR, size: 1, style: 'dashed', dashedValue: \[4, 4\] \}/)
    expect(source).toMatch(/size: line\.size \?\? 1/)
    expect(source).toMatch(/Number\(\(point\.value \?\? 0\)\.toFixed\(2\)\)/)
    // 编辑表单状态：多选选项卡式（每选中对象一表单）；默认 1px 虚线
    expect(source).toMatch(/type EditForm = \{ id: string; label: string; color: string; size: number; style: 'solid' \| 'dashed' \| 'dotted'; values: number\[\] \}/)
    // D2 补丁：编辑面板标题栏可拖拽（避免遮挡 K 线），拖动中钳制在图表宿主内
    expect(source).toMatch(/function onPanelTitlePointerDown\(event: PointerEvent\): void/)
    expect(source).toMatch(/setPointerCapture\?\.\(event\.pointerId\)/)
    expect(source).toMatch(/panel-title" title="按住标题栏拖动面板"/)
    // D3 验收反馈修复：纵轴缩放自研接管——轴上起拖持续到松手（不随指针移出轴中断），
    // 且框选拖拽不再叠加库对手动纵轴的纵向平移（画线整体上下移动的根因）
    expect(source).toMatch(/function onHostMouseDown\(event: MouseEvent\): void/)
    expect(source).toMatch(/function dispatchSyntheticAxisMove\(event: PointerEvent\): void/)
    expect(source).toMatch(/let axisScaleDrag = false/)
    expect(source).toMatch(/clientX: axisScaleDragX, clientY: event\.clientY/)
    expect(source).toMatch(/host\.value\.addEventListener\('mousedown', onHostMouseDown, true\)/)
    // D3 验收反馈修复：7px 命中与库 2px figure 命中的落差补齐（按画线不再触发整图平移）＋中键拖拽平移整个主图
    expect(source).toMatch(/function onHostMouseDownBubble\(event: MouseEvent\): void/)
    expect(source).toMatch(/hit\.startPressedMove\(\{ dataIndex: coord\.dataIndex, value: coord\.value \}\)/)
    expect(source).toMatch(/store\.setPressedOverlayInfo\(\{ paneId, overlay: hit, figureType: 'other', figureIndex: -1, figure: null \}\)/)
    // 选中态补齐：库 figure 点击分派对水平全宽线体等几何不可靠（Act2e 实证），命中即补齐持久选中
    expect(source).toMatch(/if \(store\.getClickOverlayInfo\(\)\?\.overlay\?\.id !== hit\.id\) \{/)
    expect(source).toMatch(/if \(event\.button === 1\) \{/)
    expect(source).toMatch(/function hitTestUserOverlay\(clientX: number, clientY: number\)/)
    // D3 验收反馈修复：中键纵向平移不受 Space/Home 限制（强制手动模式）＋中键不拖画线（临时锁定）＋射线/直线命中延伸
    expect(source).toMatch(/forEach\(axis => axis\.setAutoCalcTickFlag\(false\)\)/)
    expect(source).toMatch(/userOverlays\.forEach\(overlay => \{ overlay\.lock = true \}\)/)
    // 射线/直线命中几何按图元覆盖范围延伸（overlayHitGeometry）
    expect(source).toMatch(/builtInGeometry\(overlay.name, pts, bounds\)/)
    // 虚线段长统一为库默认 [4,4]（编辑前后渲染一致）；字段改无关联 div 结构（label 点击区溢出修复）
    expect(themeSource).toMatch(/dashedValue: \[4, 4\]/)
    expect(source).toMatch(/dashedValue: form\.style === 'dotted' \? \[2, 4\] : \[4, 4\]/)
    expect(source).toMatch(/class="field-row"/)
    expect(source).not.toMatch(/<label[^>]*class="field-row"/)
  })

  it('registers the ray tool in the drawing registry (D3)', async () => {
    // D3/D4/D5~D7：射线/直线/水平线系入注册表（库内置；命中几何延伸见 overlayHitGeometry）
    const drawToolsSource = await readFile(new URL('../../web/src/drawTools.ts', import.meta.url), 'utf8')
    expect(drawToolsSource).toMatch(/\{ name: 'rayLine', label: '射线' \}/)
    expect(drawToolsSource).toMatch(/\{ name: 'straightLine', label: '直线' \}/)
    expect(drawToolsSource).toMatch(/\{ name: 'horizontalStraightLine', label: '水平直线' \}/)
    expect(drawToolsSource).toMatch(/\{ name: 'horizontalSegment', label: '水平线段' \}/)
    expect(drawToolsSource).toMatch(/\{ name: 'horizontalRayLine', label: '水平射线' \}/)
    const chartSource = await readFile(chartPath, 'utf8')
    // 水平系命中几何与库渲染范围一致：水平直线单点全宽、水平射线沿点2方向延伸到边
    expect(chartSource).toMatch(/builtInGeometry\(overlay.name, pts, bounds\)/)
    expect(chartSource).toMatch(/DRAW_TOOLS.find\(tool => tool.name === name\)/)
  })

  it('supports drawing multi-select: ctrl+click, multi-mode box select, batch delete, tabbed edit panel', async () => {
    const source = await readFile(chartPath, 'utf8')
    // 左键点选画线（Ctrl 组合或多选模式下普通左键——用户 D4 验收反馈）：加入/移出多选集合（点空白清空）
    expect(source).toMatch(/if \(\(event\.ctrlKey \|\| props\.multiSelect\) && !props\.drawTool && event\.button === 0\) \{/)
    expect(source).toMatch(/function toggleMultiSelect\(id: string\): void/)
    // 多选模式：主图空白框选拖拽变为划线批量选中（不缩放 K 线）
    expect(source).toMatch(/multiSelect\?: boolean/)
    expect(source).toMatch(/if \(props\.multiSelect\) \{/)
    expect(source).toMatch(/function selectDrawingsInRect\(/)
    expect(source).toMatch(/class="multi-rect"/)
    // 橡皮筋矩形必须是 ref（multiRect 不可见缺陷两连：const 赋值报错→let 丢响应性；视觉元素必须可断言）
    expect(source).toMatch(/const multiRect = ref<\{ left: number; top: number; width: number; height: number \} \| null>\(null\)/)
    expect(source).toMatch(/multiRect\.value = \{/)
    expect(source).toMatch(/multiRect\.value = null/)
    // 选中标识＝自绘锚点层（库只为 hover/click 选中态绘制锚点，box 选中的画线两者皆非）；
    // 线体绝不变色（与用户自定义线色不冲突）；点空白解除库持久选中（框选拦截吞掉库解除链路的回归）
    expect(source).toMatch(/const anchorDots = ref<Array<\{ key: string; x: number; y: number \}>>\(\[\]\)/)
    expect(source).toMatch(/function updateAnchorDots\(\): void/)
    expect(source).toMatch(/function deselectLibrarySelected\(\): void/)
    expect(source).toMatch(/deselectLibrarySelected\(\)/)
    expect(source).toMatch(/class="anchor-dot"/)
    expect(source).toMatch(/if \(multiSelectedIds\.value\.length\) updateAnchorDots\(\)/)
    expect(source).not.toMatch(/DRAW_MULTI_SELECT_COLOR/)
    expect(source).not.toMatch(/applySelectionVisual|clearSelectionVisual/)
    // 主副图同权：框选/多选/Ctrl 点选/冒泡补齐的门限用 isDrawPane（非 x 轴 pane 一律生效）
    expect(source).toMatch(/function isDrawPane\(paneId: string \| null\): boolean/)
    expect(source).toMatch(/if \(!isDrawPane\(paneIdAt\(event\.clientY\)\)\) return/)
    // 画线命中几何按 overlay.paneId 转换（副图画线的坐标在自己 pane 内）；absolute:true＝host 坐标系（副图 pane top≠0）
    expect(source).toMatch(/\{ paneId: overlay\.paneId \|\| 'candle_pane', absolute: true \}/)
    expect(source).toMatch(/\{ paneId, absolute: true \}/)
    // 选项卡式编辑面板：标签＝类型+中文序号，确定批量应用全部表单
    expect(source).toMatch(/class="edit-tabs"/)
    expect(source).toMatch(/label: labelBase \+ \(cnNums\[n - 1\] \?\? String\(n\)\)/)
    // 批量删除：多选集合非空＝只删集合（画线完成时库的选中态不追加，防误删第三条——journey 抓出）
    expect(source).toMatch(/const ids = multiSelectedIds\.value\.length \? \[\.\.\.multiSelectedIds\.value\] : \(selectedOverlayId\.value \? \[selectedOverlayId\.value\] : \[\]\)/)
    // 多选模式关闭：清空多选集合与选中标识
    expect(source).toMatch(/watch\(\(\) => props\.multiSelect, on => \{ if \(!on\) clearMultiSelection\(\) \}\)/)
    const themeSource = await readFile(new URL('../../web/src/theme.ts', import.meta.url), 'utf8')
    // 锚点常态/选中态常量同源（theme 全局默认供库 hover/click 选中锚点引用；多选视觉走自绘层，颜色与之一致）
    expect(themeSource).toMatch(/export const DRAW_POINT_DEFAULT = \{ color: DRAW_DEFAULT_COLOR, borderColor: '#ffffff', borderSize: 1, radius: 5 \}/)
    expect(themeSource).toMatch(/export const DRAW_POINT_ACTIVE = \{ color: DRAW_DEFAULT_COLOR, borderColor: '#ffffff', borderSize: 2, radius: 7 \}/)
    const trainingSource = await readFile(trainingPath, 'utf8')
    expect(trainingSource).toMatch(/:multi-select="multiSelectMode"/)
    expect(trainingSource).toMatch(/function toggleMultiSelectMode\(\): void/)
    expect(trainingSource).toMatch(/if \(multiSelectMode.value\) return '多选模式'/)
  })

  it('maps ArrowUp to zoom-in and ArrowDown to zoom-out', async () => {
    const source = await readFile(trainingPath, 'utf8')
    expect(source).toMatch(/ArrowUp[\s\S]{0,120}?zoomBy\(1 \/ 1\.3\)/)
    expect(source).toMatch(/ArrowDown[\s\S]{0,120}?zoomBy\(1\.3\)/)
  })

  it('slims MACD histogram bars to 2/5 of the default width', async () => {
    const source = await readFile(new URL('../../web/src/indicators.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/barSpace\.halfGapBar \* 2 \* 0\.4/)
  })

  it('keeps the blind toggle out of the creation form (V1 shows stock info openly)', async () => {
    const source = await readFile(new URL('../../web/src/views/Launcher.vue', import.meta.url), 'utf8')
    expect(source).not.toMatch(/const blind|blind: blind\.value|双盲模式/)
  })

  it('keeps price-axis wheel scaling separate from chart panning and out of box select', async () => {
    const source = await readFile(chartPath, 'utf8')
    expect(source).toMatch(/function isOverPriceAxis\(/)
    // 主副图同权：轴判定遍历全部绘图 pane 的 y 轴矩形（left+width/top+height，right/bottom 恒 0 不可用）
    expect(source).toMatch(/const zone = chart\.getSize\(pane\.id, 'yAxis'\)/)
    expect(source).toMatch(/x >= zone\.left && x <= zone\.left \+ zone\.width && y >= zone\.top && y <= zone\.top \+ zone\.height/)
    // 滚轮：轴上直接返回（交给库原生纵轴缩放），不平移
    expect(source).toMatch(/if \(isOverPriceAxis\(event\.clientX, event\.clientY\)\) return[\s\S]{0,160}scrollByDistance/s)
    // 按下：轴上不进入框选；空白按下先解除持久选中，多选模式分支在框选启动之前（框选缩放被多选模式接管）
    expect(source).toMatch(/if \(isOverPriceAxis\(event\.clientX, event\.clientY\)\) return[\s\S]{0,240}if \(props\.multiSelect\) \{[\s\S]{0,460}selecting = true/s)
  })

  it('restores y-axis auto-fit before programmatic zooms so box select never drifts the chart out of view', async () => {
    const source = await readFile(chartPath, 'utf8')
    expect(source).toMatch(/function restoreYAxisAutoFit\(\): void/)
    expect(source).toMatch(/getYAxes\(\{\}\)/)
    expect(source).toMatch(/setAutoCalcTickFlag\?\.\(true\)/)
    // 框选右滑/左滑、键盘缩放、Home 复位四条路径都要先恢复自动适配
    expect(source).toMatch(/restoreYAxisAutoFit\(\)[\s\S]{0,300}setBarSpace/s)
    const zoom = await exerciseChartZoom(1 / 1.3)
    expect(zoom.actions).toEqual(['auto-fit', 'spacing', 'anchor:0', 'visible-count', 'viewport'])
    expect(zoom.barSpace).toBeGreaterThan(6)
    expect(source).toMatch(/resetView\(userInitiated = true\): void \{[\s\S]{0,160}restoreYAxisAutoFit\(\)/s)
  }
  )

  it('shows a lean title and duration meta, and a lean OHLC-only candle legend', async () => {
    const trainingSource = await readFile(trainingPath, 'utf8')
    expect(trainingSource).toMatch(/`\$\{training\.name \?\? ''\} · \$\{training\.code \?\? ''\}`/)
    expect(trainingSource).toMatch(/时长 \{\{ tierLabel \}\}/)
    expect(trainingSource).not.toMatch(/档<\//)
    expect(trainingSource).toMatch(/'2Y': '2年'/)
    const themeSource = await readFile(new URL('../../web/src/theme.ts', import.meta.url), 'utf8')
    expect(themeSource).toMatch(/title: \{ show: false, color: tooltipText \}/)
    const legendBlock = themeSource.match(/candleLegendTemplate[\s\S]{0,400}/)?.[0] ?? ''
    expect(legendBlock).toMatch(/开 |高 |低 |收 /)
    expect(legendBlock).not.toMatch(/成交量|时间/)
  })

  it('supports zooming below 10 visible bars and dynamically loads earlier history', async () => {
    const source = await readFile(chartPath, 'utf8')
    expect(source).toMatch(/const MIN_COUNT = 1/)
    expect(source).toMatch(/const BAR_SPACE_MAX = 300/)
    expect(source).toMatch(/barSpaceLimit\.max = BAR_SPACE_MAX/)
    expect(source).toMatch(/clampBarSpace\(/)
    expect(source).toMatch(/type === 'forward'/)
    expect(source).toMatch(/async function loadEarlierBars\(/)
    expect(source).toMatch(/fetchEarlier\?: \(before: string, count: number\) =>/)
    expect(source).toMatch(/loadedData = \[\.\.\.older, \.\.\.loadedData\]/)
    // date 必须随 KLineData 保留，否则 before 参数丢失导致重复加载整个窗口
    expect(source).toMatch(/volume: bar\.volume, date: bar\.date \}/)
    expect(source).toMatch(/!first\?\.date \|\| loadingForward/)
    // 前插后不得做锚定/补偿滚动：库的 forward 前插自锚定，额外滚动会引发视图塌缩与加载风暴
    expect(source).not.toMatch(/scrollToDataIndex\(newIndex \+ 1\)|scrollToDataIndex\(prevTo \+ older\.length\)/)
    const trainingSource = await readFile(trainingPath, 'utf8')
    expect(trainingSource).toMatch(/async function fetchEarlier\(/)
    expect(trainingSource).toMatch(/:has-more-bars="hasMoreBars" :fetch-earlier="fetchEarlier"/)
    expect(trainingSource).toMatch(/MAX_VISIBLE_BARS/)
  })
})
