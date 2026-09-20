<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { theme } from '../theme'
import { useRecording } from '../recording/useRecording'
import type { ChartCapture } from '../recording/types'
import KlineChart from '../components/KlineChart.vue'
import {
  abandonTraining, advanceTraining, fetchTrainingBars, settleTraining, tradeTraining, fetchDrawings, saveDrawings,
  type Bar, type Tier, type Timeframe, type TrainingSnapshot,
} from '../api'
import { DRAW_TOOLS } from '../drawTools'
import { SerialDrawingSaver, type Drawing } from '../drawingState'
import { DrawingOutbox } from '../drawingOutbox'
import type { DrawingPriceBasis } from '../drawingPriceBasis'
import { cycleDirection, nextTimeframe, MAX_VISIBLE_BARS } from '../chartNavigation'
import { DEFAULT_FAVORITE_TOOLS, loadFavoriteTools, moveFavoriteTool, saveFavoriteTools } from '../toolFavorites'
import { dataOutcomeSeq, dataRefreshOutcome, dataStatus, dataUpdating, refreshDataNow } from '../dataStatus'
import { Undo2, Redo2, Trash2, ChevronDown, ChevronUp, Settings2, Check, RotateCcw, GripVertical, Plus, Minus, ArrowLeft, ArrowRight, Info, StepForward, RefreshCw, SkipForward } from 'lucide-vue-next'

const props = defineProps<{ snapshot: TrainingSnapshot; recordingOptions?: { enabled: boolean; params?: Record<string, string | number> } }>()
const emit = defineEmits<{ ended: [] }>()

const snapshot = ref<TrainingSnapshot>(props.snapshot)
const bars = ref<Bar[]>([])
// Recording always uses daily bars observed at this exact advance date. A weekly
// or monthly viewing choice must not make the shared recording lose daily detail.
const dailyForRecording = shallowRef<{ date: string | null; bars: Bar[] } | null>(null)
const hasMoreBars = ref(true)
const tf = ref<Timeframe>('1D')
const chartCostPrice = ref<number | null>(null)
const drawingPriceBasis = ref<DrawingPriceBasis | null>(null)
const loading = ref(false)
const message = ref(props.snapshot.training.status === 'running' ? '训练就绪' : '已结束')
const errorMessage = ref('')
const visibleCount = ref(150)
const chartViewport = ref<{ visibleDate: string | null; latestDate: string | null; atLatest: boolean }>({ visibleDate: null, latestDate: null, atLatest: true })
const weight = ref(50)
const customWeight = ref<number | null>(null)
const sellShares = ref<number | null>(null)
const chartRef = ref<InstanceType<typeof KlineChart> | null>(null)
const settledView = ref<TrainingSnapshot | null>(null)
const endAction = ref<'settle' | 'abandon' | null>(null)
const keepRecording = ref(true)
const finishingSession = ref(false)
const endError = ref('')
// 画线模式状态：null＝默认模式；非 null＝画线模式（控制台工具条点击切换，Esc 退出）
const drawTool = ref<string | null>(null)
const toolbarCollapsed = ref(false)
const customizingTools = ref(false)
const otherToolsExpanded = ref(false)
const favoriteToolNames = ref(loadFavoriteTools(localStorage))
const favoriteTools = computed(() => favoriteToolNames.value.flatMap(name => DRAW_TOOLS.find(tool => tool.name === name) ?? []))
const otherTools = computed(() => DRAW_TOOLS.filter(tool => !favoriteToolNames.value.includes(tool.name)))
const favoriteStorageError = ref(false)
const draggedTool = ref<string | null>(null)
const toolDropTarget = ref<{ list: 'favorites' | 'other'; index: number } | null>(null)
// 多选模式：框选拖拽变为划线批量选中（与画线取点模式互斥）
const multiSelectMode = ref(false)
const magnet = ref<'normal' | 'weak_magnet' | 'strong_magnet'>('weak_magnet')
const initialDrawings = ref<Drawing[] | null>(null)
const historyState = ref({ undo: false, redo: false })
const textPanelOpen = ref(false)
const drawingSaveStatus = ref('载入画线')
const drawingLoadError = ref(false)
const drawingSaveError = ref('')
const legacyDrawingNotice = ref('')
let pendingDrawings: Drawing[] | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let drawingRevision = 0
let closing = false
const drawingTrainingId = props.snapshot.training.id
const recording = useRecording({
  snapshot: () => snapshot.value,
  ui: () => ({ theme: theme.value, tool: drawTool.value, magnet: magnet.value, multiSelect: multiSelectMode.value }),
  enabled: props.recordingOptions?.enabled ?? true,
  createdParams: props.recordingOptions?.params,
  ready: () => !loading.value && initialDrawings.value !== null,
  readChart: () => chartRef.value?.captureState() ?? null,
  canonicalChart: canonicalRecordingChart,
})
function canonicalRecordingChart(): ChartCapture | null {
  if (loading.value || initialDrawings.value === null) return null
  const capture = chartRef.value?.captureState()
  const daily = dailyForRecording.value
  if (!capture || !daily || daily.date !== snapshot.value.training.currentDate) return null
  const source = tf.value === '1D' ? capture.bars : daily.bars
  if (!source.length) return null
  const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`)
  return { ...capture, timeframe: '1D', bars: source,
    // Replay owns its viewport, so viewing gestures do not become timeline noise.
    view: { fromTimestamp: timestamp(source[Math.max(0, source.length - 150)].date), toTimestamp: timestamp(source[source.length - 1].date), barSpace: 6, paneHeights: {} } }
}
const preparingRecording = computed(() => !recording.ready.value && !recording.error.value)
async function captureRecording(): Promise<void> {
  await nextTick()
  try {
    const capture = chartRef.value?.captureState()
    if (capture) recording.capture(capture)
  } catch (error) { recording.fail(error) }
}
watch(theme, value => { const op = recording.begin('ui.theme', { theme: value }); recording.finish(op, 'accepted') })
const outbox = new DrawingOutbox(localStorage, `trainer.drawings.${drawingTrainingId}.${props.snapshot.training.createdAt}`)
const saver = new SerialDrawingSaver(items => saveDrawings(drawingTrainingId, items, closing && new TextEncoder().encode(JSON.stringify(items)).length < 60_000))
async function loadDrawings(): Promise<void> {
  drawingLoadError.value = false
  drawingSaveError.value = ''
  try {
    const remote = (await fetchDrawings(drawingTrainingId)).drawings
    const recovered = outbox.read()
    initialDrawings.value = recovered ?? remote
    legacyDrawingNotice.value = initialDrawings.value.some(item => item.paneId === 'candle_pane' && !item.priceBasis)
      ? '旧画线缺少创建时的复权基准，已保留原价；历史偏移未自动修正。' : ''
    drawingSaveStatus.value = '已保存'
    if (recovered) onDrawingsChange(recovered)
    await captureRecording()
  } catch (error) {
    drawingLoadError.value = true
    drawingSaveStatus.value = '画线加载失败'
    drawingSaveError.value = error instanceof Error ? error.message : '无法读取画线'
  }
}
function onDrawingsChange(items: Drawing[]): void {
  pendingDrawings = items
  drawingRevision++
  drawingSaveStatus.value = '待保存'
  try { outbox.write(items) } catch { drawingSaveStatus.value = '本地备份失败' }
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushDrawings() }, 1200)
}
async function flushDrawings(): Promise<boolean> {
  clearTimeout(saveTimer)
  if (!pendingDrawings || initialDrawings.value === null) return true
  const items = pendingDrawings
  const revision = drawingRevision
  drawingSaveStatus.value = '保存中'
  drawingSaveError.value = ''
  const recordingOp = recording.begin('drawings.save', { revision, count: items.length })
  try {
    await saver.save(items)
    outbox.acknowledge(items)
    if (revision === drawingRevision) { pendingDrawings = null; drawingSaveStatus.value = '已保存' }
    recording.finish(recordingOp, 'accepted')
    return true
  } catch (error) {
    recording.rejected(recordingOp, error)
    drawingSaveStatus.value = '保存失败'
    drawingSaveError.value = error instanceof Error ? error.message : '无法连接本地服务'
    return false
  }
}
function flushOnPageHide(): void { closing = true; void flushDrawings() }
function flushOnHidden(): void { if (document.visibilityState === 'hidden') void flushDrawings() }
window.addEventListener('pagehide', flushOnPageHide)
document.addEventListener('visibilitychange', flushOnHidden)
onUnmounted(() => {
  clearTimeout(saveTimer)
  void flushDrawings()
  window.removeEventListener('pagehide', flushOnPageHide)
  document.removeEventListener('visibilitychange', flushOnHidden)
})
void loadDrawings()
function toggleMultiSelectMode(): void {
  multiSelectMode.value = !multiSelectMode.value
  if (multiSelectMode.value) drawTool.value = null
}
watch(drawTool, tool => { if (tool) multiSelectMode.value = false })

function updateFavoriteTools(names: string[]): void {
  favoriteToolNames.value = names
  favoriteStorageError.value = !saveFavoriteTools(localStorage, names)
}
function toggleToolCustomization(): void {
  customizingTools.value = !customizingTools.value
  draggedTool.value = null
  toolDropTarget.value = null
  if (customizingTools.value) {
    toolbarCollapsed.value = false
    drawTool.value = null
    multiSelectMode.value = false
    chartRef.value?.clearMultiSelection()
  }
}
function shiftFavoriteTool(name: string, offset: number): void {
  updateFavoriteTools(moveFavoriteTool(favoriteToolNames.value, name, favoriteToolNames.value.indexOf(name) + offset))
}
function startToolDrag(event: DragEvent, name: string): void {
  if (!customizingTools.value || !event.dataTransfer) { event.preventDefault(); return }
  draggedTool.value = name
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', name)
}
function endToolDrag(): void {
  draggedTool.value = null
  toolDropTarget.value = null
}
function dragOverTools(event: DragEvent, list: 'favorites' | 'other', index?: number): void {
  if (!customizingTools.value || !draggedTool.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  let position = index ?? favoriteToolNames.value.length
  if (index !== undefined) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    if (event.clientX > rect.left + rect.width / 2) position++
  }
  toolDropTarget.value = { list, index: position }
}
function dropTool(event: DragEvent): void {
  event.preventDefault()
  const name = draggedTool.value
  const target = toolDropTarget.value
  if (customizingTools.value && name && target) {
    const oldIndex = favoriteToolNames.value.indexOf(name)
    const insertionIndex = target.index - (oldIndex >= 0 && oldIndex < target.index ? 1 : 0)
    updateFavoriteTools(moveFavoriteTool(favoriteToolNames.value, name, target.list === 'other' ? null : insertionIndex))
  }
  endToolDrag()
}
function onToolbarKeydown(event: KeyboardEvent): void {
  if (customizingTools.value) {
    if (event.key === 'Escape') { event.preventDefault(); toggleToolCustomization() }
    event.stopPropagation()
  }
}

const training = computed(() => snapshot.value.training)
const account = computed(() => snapshot.value.account)
const returnPct = computed(() => ((account.value.equity - training.value.initialCash) / training.value.initialCash) * 100)
const isTyping = (event: KeyboardEvent) => event.isComposing || !!(event.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]')
const tierLabel = computed(() => ({ '1M': '1个月', '3M': '3个月', '6M': '6个月', '1Y': '1年', '2Y': '2年' }[training.value.tier as Tier] ?? training.value.tier))
const statusText = computed(() => {
  if (multiSelectMode.value) return '多选模式'
  if (!drawTool.value) return message.value
  const label = DRAW_TOOLS.find(tool => tool.name === drawTool.value)?.label ?? drawTool.value
  return `画线模式：${label}`
})

let loadVersion = 0
async function load(): Promise<void> {
  const requestVersion = ++loadVersion
  const timeframe = tf.value
  loading.value = true
  errorMessage.value = ''
  const recordingOp = recording.begin('chart.load', { timeframe })
  try {
    const [payload, daily] = await Promise.all([
      fetchTrainingBars(training.value.id, timeframe),
      timeframe === '1D' ? Promise.resolve(null) : fetchTrainingBars(training.value.id, '1D'),
    ])
    if (requestVersion !== loadVersion) { recording.finish(recordingOp, 'cancelled', { reason: '已被新请求替代' }); return }
    const canonical = daily ?? payload
    if (canonical.training.currentDate !== payload.training.currentDate) throw new Error('训练日期已改变，请刷新图表后继续录制')
    dailyForRecording.value = { date: canonical.training.currentDate, bars: canonical.bars }
    snapshot.value = { training: payload.training, account: payload.account, trades: payload.trades }
    drawingPriceBasis.value = payload.drawingPriceBasis ?? null
    bars.value = payload.bars
    chartCostPrice.value = payload.chartCostPrice ?? null
    hasMoreBars.value = payload.hasMore
    await nextTick()
    if (requestVersion !== loadVersion) { recording.finish(recordingOp, 'cancelled'); return }
    loading.value = false
    recording.finish(recordingOp, 'accepted', { timeframe, bars: payload.bars.length })
    await captureRecording()
  } catch (error) {
    recording.rejected(recordingOp, error)
    if (requestVersion !== loadVersion) return
    errorMessage.value = error instanceof Error ? error.message : '加载失败'
  } finally {
    if (requestVersion === loadVersion) loading.value = false
  }
}

// 动态历史加载：视窗移动到已加载窗口之前时，向服务端分批取更早的 K 线（每批 300 根）
async function fetchEarlier(before: string, count: number): Promise<{ bars: Bar[]; hasMore: boolean }> {
  const payload = await fetchTrainingBars(training.value.id, tf.value, { before, count })
  return { bars: payload.bars, hasMore: payload.hasMore }
}

async function advance(): Promise<void> {
  if (loading.value || preparingRecording.value || training.value.status !== 'running') return
  loading.value = true
  errorMessage.value = ''
  const recordingOp = recording.begin('training.advance')
  try {
    const result = await advanceTraining(training.value.id)
    snapshot.value = result.snapshot
    chartCostPrice.value = result.snapshot.account.costPrice
    recording.finish(recordingOp, 'accepted', { settled: result.settled })
    await recording.refreshContext()
    if (result.settled) {
      settledView.value = result.snapshot
      setTrainingUrl()
      message.value = `已到期结算：结算日 ${snapshot.value.training.settleDate}`
    } else {
      message.value = `推进至 ${snapshot.value.training.currentDate ?? '今日'}，收盘 ${result.bar ? result.bar.close.toFixed(2) : '--'}`
    }
    await load()
  } catch (error) {
    recording.rejected(recordingOp, error)
    errorMessage.value = error instanceof Error ? error.message : '推进失败'
  } finally {
    loading.value = false
  }
}

async function trade(side: 'buy' | 'sell'): Promise<void> {
  if (loading.value || preparingRecording.value || training.value.status !== 'running') return
  loading.value = true
  errorMessage.value = ''
  const payload = side === 'sell' && sellShares.value
    ? { side, shares: sellShares.value }
    : { side, weightPct: customWeight.value ?? weight.value }
  const recordingOp = recording.begin('training.trade', payload)
  try {
    const result = await tradeTraining(training.value.id, payload)
    snapshot.value = result.snapshot
    chartCostPrice.value = result.snapshot.account.costPrice
    recording.finish(recordingOp, 'accepted', { plan: result.plan })
    message.value = `${side === 'buy' ? '买入' : '卖出'}成交：${result.plan.shares} 股 @ ${result.plan.price.toFixed(2)}`
    sellShares.value = null
    customWeight.value = null
    await load()
  } catch (error) {
    recording.rejected(recordingOp, error)
    errorMessage.value = error instanceof Error ? error.message : '交易失败'
  } finally {
    loading.value = false
  }
}

async function settle(): Promise<void> {
  if (loading.value || preparingRecording.value || training.value.status !== 'running') return
  loading.value = true
  const recordingOp = recording.begin('training.settle')
  try {
    const result = await settleTraining(training.value.id)
    snapshot.value = result
    recording.finish(recordingOp, 'accepted')
    settledView.value = result
    setTrainingUrl()
    message.value = `已提前结算：结算日 ${result.training.settleDate}`
    await load()
  } catch (error) {
    recording.rejected(recordingOp, error)
    errorMessage.value = error instanceof Error ? error.message : '结算失败'
  } finally {
    loading.value = false
  }
}

async function abandon(): Promise<void> {
  if (loading.value || preparingRecording.value || training.value.status !== 'running') return
  loading.value = true
  const recordingOp = recording.begin('training.abandon')
  try {
    await abandonTraining(training.value.id)
    snapshot.value = { ...snapshot.value, training: { ...snapshot.value.training, status: 'abandoned' } }
    recording.finish(recordingOp, 'accepted')
    await recording.flush()
  } catch (error) {
    recording.rejected(recordingOp, error)
    errorMessage.value = error instanceof Error ? error.message : '操作失败'
  } finally {
    loading.value = false
  }
}

function requestEnd(action: 'settle' | 'abandon'): void {
  if (loading.value || preparingRecording.value || training.value.status !== 'running') return
  keepRecording.value = true
  endError.value = ''
  endAction.value = action
}
async function confirmEnd(): Promise<void> {
  if (!endAction.value || finishingSession.value) return
  finishingSession.value = true
  endError.value = ''
  try {
    if (!await flushDrawings()) throw new Error(drawingSaveError.value || '请先重试保存画线')
    const action = endAction.value
    if (training.value.status === 'running') {
      if (action === 'settle') await settle()
      else await abandon()
    }
    if (training.value.status === 'running') throw new Error(errorMessage.value || '训练尚未结束，请重试')
    await recording.finishSession(keepRecording.value)
    endAction.value = null
    if (action === 'abandon') emit('ended')
  } catch (error) { endError.value = error instanceof Error ? error.message : String(error) }
  finally { finishingSession.value = false }
}
async function backToLauncher(): Promise<void> {
  if (finishingSession.value) return
  finishingSession.value = true
  endError.value = ''
  try {
    if (!await flushDrawings()) throw new Error(drawingSaveError.value || '请先重试保存画线')
    await recording.finishSession(keepRecording.value)
    emit('ended')
  } catch (error) { endError.value = error instanceof Error ? error.message : String(error) }
  finally { finishingSession.value = false }
}
async function prepareForLibrary(): Promise<boolean> {
  if (loading.value || preparingRecording.value || drawTool.value || textPanelOpen.value) return false
  if (!await flushDrawings()) return false
  await recording.flush()
  return !recording.error.value && !recording.status.value.error
}
defineExpose({ prepareForLibrary })
function setTrainingUrl(): void {
  const url = new URL(location.href)
  url.searchParams.set('training', String(drawingTrainingId))
  history.replaceState(null, '', url)
}

function onKeydown(event: KeyboardEvent): void {
  if (preparingRecording.value || endAction.value || settledView.value || finishingSession.value) return
  if (customizingTools.value) {
    if (event.key === 'Escape') { event.preventDefault(); toggleToolCustomization() }
    if (event.code === 'Space' || ['b', 'B', 's', 'S', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home'].includes(event.key)) event.preventDefault()
    return
  }
  if (isTyping(event)) return
  if (textPanelOpen.value) return
  const direction = cycleDirection(event)
  if (direction && !drawTool.value) {
    event.preventDefault()
    tf.value = nextTimeframe(tf.value, direction)
    return
  }
  if (event.ctrlKey || event.metaKey) {
    if (drawTool.value) { if (['z', 'y'].includes(event.key.toLowerCase())) event.preventDefault(); return }
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? chartRef.value?.redoDrawing() : chartRef.value?.undoDrawing(); return }
    if (event.key.toLowerCase() === 'y') { event.preventDefault(); chartRef.value?.redoDrawing(); return }
  }
  // 多选模式：Esc 退出并清空多选（KlineChart 内部处理面板 Esc）；其余键照常（Delete 走批量删除）
  if (multiSelectMode.value && event.key === 'Escape') {
    event.preventDefault()
    multiSelectMode.value = false
    chartRef.value?.clearMultiSelection()
    return
  }
  // 画线模式下 Space/B/S 禁用（防误推进/误交易），Esc 退出画线模式；方向键/Home 照常
  if (drawTool.value) {
    if (event.key === 'Escape') { event.preventDefault(); drawTool.value = null; return }
    if (event.code === 'Space' || ['b', 'B', 's', 'S'].includes(event.key)) { event.preventDefault(); return }
  }
  if (event.code === 'Space') { event.preventDefault(); void advance() }
  // Delete 删除选中的用户画线（引擎标记不可选中、不受影响）
  if (event.key === 'Delete') { event.preventDefault(); chartRef.value?.deleteSelected() }
  // 对齐通达信模拟训练习惯：B 买入、S 卖出（与按钮同一撮合路径）
  if (event.key === 'b' || event.key === 'B') { event.preventDefault(); void trade('buy') }
  if (event.key === 's' || event.key === 'S') { event.preventDefault(); void trade('sell') }
  // 对齐直觉方向：↑ 放大（可见 K 线变少变粗），↓ 缩小（可见 K 线变多变细）
  if (event.key === 'ArrowUp') { event.preventDefault(); chartRef.value?.zoomBy(1 / 1.3) }
  if (event.key === 'ArrowDown') { event.preventDefault(); chartRef.value?.zoomBy(1.3) }
  if (event.key === 'ArrowLeft') { event.preventDefault(); chartRef.value?.moveCrosshair(-1) }
  if (event.key === 'ArrowRight') { event.preventDefault(); chartRef.value?.moveCrosshair(1) }
  if (event.key === 'Home') { event.preventDefault(); chartRef.value?.resetView() }
}

window.addEventListener('keydown', onKeydown)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// ===== 日线数据小更新按钮（紧凑操作栏，固定尺寸不挤图表） =====
// 更新结果通过全局状态轻提示：终态到达后按钮短暂变绿"✓"（或红"!"），不弹模态
const miniFlash = ref<'ok' | 'fail' | null>(null)
let miniFlashTimer: ReturnType<typeof setTimeout> | undefined
watch(dataOutcomeSeq, () => {
  const outcome = dataRefreshOutcome.value
  miniFlash.value = outcome === 'updated' ? 'ok' : outcome === 'failed' ? 'fail' : null
  clearTimeout(miniFlashTimer)
  if (miniFlash.value) miniFlashTimer = setTimeout(() => { miniFlash.value = null }, 2600)
})
onUnmounted(() => clearTimeout(miniFlashTimer))
const miniLabel = computed(() => {
  if (dataUpdating.value) return '更新中'
  if (miniFlash.value === 'ok') return '✓'
  if (miniFlash.value === 'fail') return '!'
  return '更新'
})
const miniTitle = computed(() => {
  if (dataUpdating.value) return '日线数据更新中'
  if (miniFlash.value === 'fail') return dataStatus.value?.lastResult?.message ?? '更新失败，点击重试'
  if (dataStatus.value?.needsUpdate) return `日线数据待更新（截止 ${dataStatus.value.sourceMaxDate ?? '未知'}），点击更新`
  return '检查并更新日线数据'
})
function onMiniRefresh(): void {
  void refreshDataNow()
}

watch(tf, (value, previous) => {
  const op = recording.begin('chart.timeframe', { from: previous, to: value })
  // Chart data will be captured only after the matching load finishes.
  loading.value = true
  recording.finish(op, 'accepted')
  void load()
})
void load()
</script>

<template>
  <div class="training-shell">
    <header class="training-topbar" :inert="preparingRecording" @keydown.space.stop>
      <div class="training-context">
        <div class="workspace-title" :title="training.blind ? `盲训 · ${tierLabel}` : `${training.name ?? ''} · ${training.code ?? ''}`">
          {{ training.blind ? `盲训 · ${tierLabel}` : `${training.name ?? ''} · ${training.code ?? ''}` }}
        </div>
        <div class="training-current-date">当前 <strong>{{ training.currentDate }}</strong></div>
        <div class="timeframe-tabs" role="tablist" aria-label="K线周期">
          <button v-for="item in (['1D', '1W', '1M'] as Timeframe[])" :key="item" role="tab" :aria-selected="tf === item" :class="{ selected: tf === item }" @click="tf = item">{{ item === '1D' ? '日K' : item === '1W' ? '周K' : '月K' }}</button>
        </div>
        <details class="training-details" @keydown.esc.prevent.stop="($event.currentTarget as HTMLDetailsElement).open = false">
          <summary title="训练详情" aria-label="训练详情"><Info :size="15" /></summary>
          <div class="training-meta">
            <span>{{ training.adjustMode === 'forward' ? '前复权' : '不复权' }}（已锁定）</span>
            <span>起始 {{ training.startDate }}</span>
            <span>当前 <strong>{{ training.currentDate }}</strong></span>
            <span>计划结束 {{ training.plannedEnd }}</span>
            <span>时长 {{ tierLabel }}</span>
            <span v-if="legacyDrawingNotice" class="legacy-drawing-notice">{{ legacyDrawingNotice }}</span>
          </div>
        </details>
      </div>
      <div class="training-actions">
        <button class="ghost-button data-refresh-btn" :class="{ 'is-updating': dataUpdating, attention: dataStatus?.needsUpdate && !dataUpdating, 'flash-ok': miniFlash === 'ok', 'flash-fail': miniFlash === 'fail' }" :disabled="dataUpdating" :title="miniTitle" :aria-label="`日线数据更新：${miniTitle}`" @click="onMiniRefresh">{{ miniLabel }}</button>
        <button class="ghost-button compact-icon-button" title="刷新图表" aria-label="刷新图表" :disabled="loading" @click="load"><RefreshCw :size="14" /></button>
        <button class="ghost-button compact-icon-button" title="回到最新K线" aria-label="回到最新K线" :disabled="loading" @click="chartRef?.resetView()"><SkipForward :size="14" /></button>
        <button class="advance-button" :disabled="loading || training.status !== 'running'" title="推进下一日（空格）" @click="advance"><StepForward :size="14" />推进下一日</button>
        <template v-if="training.status === 'running'"><button class="ghost-button" @click="requestEnd('settle')">提前结算</button><button class="ghost-button danger" @click="requestEnd('abandon')">放弃训练</button></template>
        <button v-else class="ghost-button" @click="backToLauncher">返回首页</button>
      </div>
    </header>


    <section class="status-strip" aria-live="polite">
      <span class="status-message" :title="errorMessage || statusText" :class="{ 'error-text': errorMessage }">{{ errorMessage || statusText }}</span>
      <span class="shortcut-hint" title="空格：推进下一日；[ / ]：日周月周期；Home：回到最新；↑ / ↓：缩放；Del：删除选中画线；B / S：买入卖出；Ctrl+Z / Ctrl+Y：撤销重做。输入、弹窗和画线取点期间部分快捷键暂停。">空格 下一日 · [ ] 周期 · Home 最新 · ↑↓ 缩放 · Del 删线</span>
      <span v-if="loading" class="loading-dot">处理中</span>
      <span v-if="chartViewport.visibleDate" class="viewport-date chart-date-status">{{ tf === '1D' ? '可见至' : tf === '1W' ? '右端周K' : '右端月K' }} {{ chartViewport.visibleDate }}</span>
      <span v-if="chartViewport.latestDate && chartViewport.latestDate !== chartViewport.visibleDate" class="viewport-date latest-date">{{ tf === '1D' ? '末根' : tf === '1W' ? '最新周K' : '最新月K' }} {{ chartViewport.latestDate }}</span>
      <span class="view-count" title="当前同屏K线根数 / 同屏上限">{{ visibleCount }} / {{ MAX_VISIBLE_BARS }} 根</span>
    </section>



    <section class="training-grid" :inert="preparingRecording">
      <div class="chart-panel">
        <KlineChart
          ref="chartRef" :bars="bars" :trades="snapshot.trades"
          :cost-price="account.costPrice" :chart-cost-price="chartCostPrice"
          :drawing-price-basis="drawingPriceBasis"
          :timeframe="tf" :has-more-bars="hasMoreBars" :fetch-earlier="fetchEarlier"
          :draw-tool="drawTool" :multi-select="multiSelectMode"
          :magnet="magnet" :saved-drawings="initialDrawings"
          @chart-capture="recording.capture" @operation="recording.operation" @capture-error="recording.fail"
          @visible-count="visibleCount = $event"
          @viewport-dates="chartViewport = $event"
          @tool-change="drawTool = $event"
          @drawings-change="onDrawingsChange" @history-change="historyState = $event" @panel-change="textPanelOpen = $event"
        />
      </div>

      <aside class="trade-panel">
        <Teleport to="#training-recording-controls">
        <div class="recording-strip" @keydown.space.stop>
          <label><input type="checkbox" aria-label="记录操作" :checked="recording.enabled.value" :disabled="loading || !recording.ready.value || recording.finalized.value" @change="recording.toggle" />记录操作</label>
          <span role="status" :class="{ 'error-text': recording.label.value === '记录失败' }">{{ recording.label.value }} · {{ recording.businessEventCount.value }} 次操作</span>
          <button class="ghost-button" :disabled="loading || !recording.ready.value || (recording.finalized.value && !recording.hasRetainedFile.value)" @click="recording.exportFile">导出录制</button>
          <span v-if="recording.notice.value || recording.error.value || recording.status.value.error" class="recording-feedback" :class="{ 'error-text': recording.error.value || recording.status.value.error }" role="alert">{{ recording.error.value || recording.status.value.error || recording.notice.value }}</span>
          <button v-if="recording.label.value === '记录失败'" class="ghost-button" @click="recording.retry">重试录制保存</button>
        </div>
        </Teleport>
        <div class="console-scroll">
        <div class="panel-heading"><span>训练账户</span><span class="live-mark">● {{ training.status === 'running' ? '进行中' : '已结束' }}</span></div>
        <div class="equity-block">
          <span>账户权益</span>
          <strong>¥{{ account.equity.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }}</strong>
          <em :class="returnPct >= 0 ? 'up' : 'down'">{{ returnPct >= 0 ? '+' : '' }}{{ returnPct.toFixed(2) }}%</em>
        </div>
        <div class="account-stats">
          <div><span>可用资金</span><strong>¥{{ account.cash.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }}</strong></div>
          <div><span>持仓市值</span><strong>¥{{ account.marketValue.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }}</strong></div>
          <div><span>持仓（可卖）</span><strong>{{ account.shares }}（{{ account.availableShares }}）</strong></div>
          <div><span>摊薄成本</span><strong>{{ account.costPrice ? account.costPrice.toFixed(2) : '--' }}</strong></div>
        </div>

        <div class="panel-divider"></div>
        <div class="order-heading"><span>下单</span><small>按当日收盘价成交</small></div>
        <div class="weight-grid">
          <button v-for="w in [10, 20, 25, 30, 50, 75, 100]" :key="w" :class="{ selected: weight === w && customWeight === null }" @click="weight = w; customWeight = null">{{ w }}%</button>
          <input v-model.number="customWeight" type="number" min="1" max="100" placeholder="自定义%" />
        </div>
        <div class="shares-row">
          <input v-model.number="sellShares" type="number" min="1" placeholder="按股数卖出（选填）" />
          <small>留空则按左侧比例卖出</small>
        </div>
        <div class="trade-actions">
          <button class="trade-action buy" :disabled="training.status !== 'running'" @click="trade('buy')">买入</button>
          <button class="trade-action sell" :disabled="training.status !== 'running'" @click="trade('sell')">卖出</button>
        </div>

        <div class="panel-divider"></div>
        <div class="order-heading"><span>成交记录</span><small>{{ snapshot.trades.length }} 笔</small></div>
        <div class="trade-log">
          <div v-for="item in [...snapshot.trades].reverse()" :key="item.seq" class="trade-row">
            <span :class="item.side === 'buy' ? 'up' : 'down'">{{ item.side === 'buy' ? 'B' : 'S' }}{{ item.seq }}</span>
            <span>{{ item.date }}</span>
            <span>{{ item.shares }}股 @ {{ item.price.toFixed(2) }}</span>
          </div>
          <div v-if="!snapshot.trades.length" class="trade-empty">暂无成交</div>
        </div>
        </div>
        <div class="draw-toolbar" :class="{ 'is-collapsed': toolbarCollapsed, 'has-other-tools': otherToolsExpanded || customizingTools, 'is-customizing': customizingTools }" @keydown="onToolbarKeydown">
          <div class="drawing-toolbar-heading">
            <button class="tool-collapse" :disabled="customizingTools" :title="toolbarCollapsed ? '展开画线工具条' : '折叠画线工具条'" :aria-label="toolbarCollapsed ? '展开画线工具条' : '折叠画线工具条'" :aria-expanded="!toolbarCollapsed" @click="toolbarCollapsed = !toolbarCollapsed"><ChevronDown v-if="toolbarCollapsed" :size="14"/><ChevronUp v-else :size="14"/></button>
            <span>常用工具</span>
            <button v-if="customizingTools" class="tool-reset" title="恢复默认常用工具" aria-label="恢复默认常用工具" @click="updateFavoriteTools([...DEFAULT_FAVORITE_TOOLS])"><RotateCcw :size="13"/></button>
            <button class="tool-customize-toggle" :class="{ active: customizingTools }" :aria-pressed="customizingTools" :disabled="textPanelOpen" @click="toggleToolCustomization"><Check v-if="customizingTools" :size="13"/><Settings2 v-else :size="13"/>{{ customizingTools ? '完成自定义' : '自定义常用' }}</button>
          </div>
          <template v-if="!toolbarCollapsed">
            <div class="toolbar-tool-lists">
              <div class="favorite-tools tool-list" :class="{ 'accepting-drop': customizingTools && draggedTool }" @dragover="dragOverTools($event, 'favorites')" @drop.stop="dropTool">
                <template v-for="(tool, index) in favoriteTools" :key="tool.name">
                  <div class="tool-item" :class="{ 'is-dragged': draggedTool === tool.name }" @dragover.stop="dragOverTools($event, 'favorites', index)">
                    <span v-if="toolDropTarget?.list === 'favorites' && toolDropTarget.index === index" class="toolbar-drop-indicator" aria-hidden="true"></span>
                    <span v-if="toolDropTarget?.list === 'favorites' && toolDropTarget.index === favoriteTools.length && index === favoriteTools.length - 1" class="toolbar-drop-indicator at-end" aria-hidden="true"></span>
                    <button
                      :data-tool-name="tool.name" :draggable="customizingTools"
                      :disabled="!customizingTools && (initialDrawings === null || textPanelOpen)"
                      :class="{ active: drawTool === tool.name }" :title="customizingTools ? `拖动排序：${tool.label}` : tool.label"
                      @dragstart="startToolDrag($event, tool.name)" @dragend="endToolDrag"
                      @mousedown="!customizingTools && $event.preventDefault()"
                      @click="!customizingTools && (drawTool = drawTool === tool.name ? null : tool.name)"
                    ><GripVertical v-if="customizingTools" :size="12"/>{{ tool.label }}</button>
                    <div v-if="customizingTools" class="tool-item-actions">
                      <button :disabled="index === 0" :title="`${tool.label}前移`" :aria-label="`${tool.label}前移`" @click="shiftFavoriteTool(tool.name, -1)"><ArrowLeft :size="12"/></button>
                      <button :disabled="index === favoriteTools.length - 1" :title="`${tool.label}后移`" :aria-label="`${tool.label}后移`" @click="shiftFavoriteTool(tool.name, 1)"><ArrowRight :size="12"/></button>
                      <button :title="`移出常用：${tool.label}`" :aria-label="`移出常用：${tool.label}`" @click="updateFavoriteTools(moveFavoriteTool(favoriteToolNames, tool.name, null))"><Minus :size="12"/></button>
                    </div>
                  </div>
                </template>
                <span v-if="toolDropTarget?.list === 'favorites' && !favoriteTools.length" class="toolbar-drop-indicator" aria-hidden="true"></span>
                <span v-if="!favoriteTools.length" class="tool-list-empty">暂无常用工具</span>
              </div>
              <button class="other-tools-toggle" :aria-expanded="otherToolsExpanded || customizingTools" :disabled="customizingTools" @click="otherToolsExpanded = !otherToolsExpanded"><ChevronUp v-if="otherToolsExpanded || customizingTools" :size="13"/><ChevronDown v-else :size="13"/>其他工具 <span>{{ otherTools.length }}</span></button>
              <div v-if="otherToolsExpanded || customizingTools" class="other-tools tool-list" :class="{ 'accepting-drop': customizingTools && draggedTool }" @dragover="dragOverTools($event, 'other')" @drop.stop="dropTool">
                <span v-if="toolDropTarget?.list === 'other'" class="toolbar-drop-indicator" aria-hidden="true"></span>
                <div v-for="tool in otherTools" :key="tool.name" class="tool-item" :class="{ 'is-dragged': draggedTool === tool.name }">
                  <button
                    :data-tool-name="tool.name" :draggable="customizingTools"
                    :disabled="!customizingTools && (initialDrawings === null || textPanelOpen)"
                    :class="{ active: drawTool === tool.name }" :title="customizingTools ? `拖入常用：${tool.label}` : tool.label"
                    @dragstart="startToolDrag($event, tool.name)" @dragend="endToolDrag"
                    @mousedown="!customizingTools && $event.preventDefault()"
                    @click="!customizingTools && (drawTool = drawTool === tool.name ? null : tool.name)"
                  ><GripVertical v-if="customizingTools" :size="12"/>{{ tool.label }}</button>
                  <div v-if="customizingTools" class="tool-item-actions"><button :title="`加入常用：${tool.label}`" :aria-label="`加入常用：${tool.label}`" @click="updateFavoriteTools(moveFavoriteTool(favoriteToolNames, tool.name, favoriteToolNames.length))"><Plus :size="12"/></button></div>
                </div>
                <span v-if="!otherTools.length" class="tool-list-empty">全部工具已加入常用</span>
              </div>
            </div>
            <div class="drawing-toolbar-actions">
              <button :class="{ active: multiSelectMode }" :disabled="customizingTools" title="多选模式：框选批量选中划线后批量编辑/删除" @mousedown.prevent @click="toggleMultiSelectMode">多选</button>
              <button title="撤销" aria-label="撤销" :disabled="customizingTools || !historyState.undo || !!drawTool || textPanelOpen" @click="chartRef?.undoDrawing()"><Undo2 :size="14"/></button>
              <button title="重做" aria-label="重做" :disabled="customizingTools || !historyState.redo || !!drawTool || textPanelOpen" @click="chartRef?.redoDrawing()"><Redo2 :size="14"/></button>
              <button title="清空" aria-label="清空" :disabled="customizingTools || initialDrawings === null || !!drawTool || textPanelOpen" @click="chartRef?.clearDrawings()"><Trash2 :size="14"/></button>
              <select v-model="magnet" :disabled="customizingTools" aria-label="吸附"><option value="normal">关闭</option><option value="weak_magnet">弱吸附</option><option value="strong_magnet">强吸附</option></select>
            </div>
          </template>
          <div class="drawing-save-footer">
            <span class="drawing-save-status" :class="{ 'save-error': drawingSaveError }" :title="drawingSaveError || drawingSaveStatus" role="status">{{ drawingSaveStatus }}</span>
            <button v-if="drawingLoadError" @click="loadDrawings">重新加载</button>
            <button v-if="drawingSaveStatus === '保存失败'" @click="flushDrawings">重试保存</button>
            <span v-if="favoriteStorageError" class="favorite-storage-error" title="常用工具未能写入浏览器存储，刷新后会恢复之前的设置">常用未保存</span>
          </div>
        </div>
      </aside>
    </section>

    <div v-if="endAction" class="settle-mask" role="dialog" aria-modal="true" aria-label="结束训练" @keydown.stop>
      <div class="settle-panel">
        <h2>{{ endAction === 'abandon' ? '放弃本轮训练' : '提前结算本轮训练' }}</h2>
        <p>{{ endAction === 'abandon' ? '放弃后成绩不进入排行榜，已有交易和画线仍保留。' : '结算后结束本轮交易，仍可查看图表和回放。' }}</p>
        <label class="keep-recording"><input v-model="keepRecording" type="checkbox" :disabled="finishingSession || recording.finalized.value" />保留到本机训练历史</label>
        <p class="form-hint">不勾选仅丢弃本轮录像，不删除交易成绩和画线。</p>
        <p v-if="endError" class="error-text" role="alert">{{ endError }}</p>
        <button class="trade-action buy" :disabled="finishingSession" @click="confirmEnd">{{ endAction === 'abandon' ? '确认放弃' : '确认结算' }}</button>
        <button class="ghost-button" :disabled="finishingSession" @click="recording.exportFile">导出录像</button>
        <button class="ghost-button" :disabled="finishingSession" @click="endAction = null">继续训练</button>
      </div>
    </div>
    <div v-else-if="settledView" class="settle-mask" role="dialog" aria-modal="true" aria-label="训练结算" @keydown.stop>
      <div class="settle-panel">
        <h2>{{ settledView.training.earlySettle ? '提前结算' : '到期结算' }}</h2>
        <div class="settle-grid">
          <div><span>结算日</span><strong>{{ settledView.training.settleDate }}</strong></div>
          <div><span>初始资金</span><strong>¥{{ settledView.training.initialCash.toLocaleString('zh-CN') }}</strong></div>
          <div><span>最终权益</span><strong>¥{{ settledView.account.equity.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }}</strong></div>
          <div>
            <span>总收益率</span>
            <strong :class="returnPct >= 0 ? 'up' : 'down'">
              {{ returnPct >= 0 ? '+' : '' }}{{ returnPct.toFixed(2) }}%
            </strong>
          </div>
          <div><span>交易笔数</span><strong>{{ settledView.trades.length }}</strong></div>
          <div><span>训练区间</span><strong>{{ settledView.training.startDate }} ~ {{ settledView.training.settleDate }}</strong></div>
        </div>
        <label class="keep-recording"><input v-model="keepRecording" type="checkbox" :disabled="finishingSession || recording.finalized.value" />保留到本机训练历史</label>
        <p v-if="endError" class="error-text" role="alert">{{ endError }}</p>
        <button class="trade-action buy" :disabled="finishingSession" @click="backToLauncher">完成，返回首页</button>
        <button class="ghost-button" :disabled="loading || !recording.ready.value || (recording.finalized.value && !recording.hasRetainedFile.value)" @click="recording.exportFile">导出本场录制</button>
        <button class="ghost-button" @click="settledView = null">继续查看图表</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recording-strip { position: relative; display: flex; align-items: center; gap: 8px; font-size: 11px; white-space: nowrap; }
.recording-strip label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.recording-strip .ghost-button { padding: 2px 7px; font-size: 11px; }
.recording-feedback { position: absolute; right: 0; top: 28px; z-index: 30; max-width: min(360px, 70vw); padding: 8px; white-space: normal; overflow-wrap: anywhere; background: var(--surface-background, #fff); border: 1px solid var(--surface-border, #dfe5eb); border-radius: 4px; }
.shortcut-hint { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10px; }
.keep-recording { display: flex; align-items: center; gap: 8px; margin: 12px 0; font-size: 14px; }
.legacy-drawing-notice { white-space: normal; line-height: 1.5; }
</style>
