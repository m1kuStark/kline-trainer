<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import KlineChart from '../components/KlineChart.vue'
import type { Timeframe } from '../api'
import type { ChartCaptureView, RecordingFile, RecordingGap } from '../recording/types'
import type { CompactRecordingFile } from '../recording/compactTypes'
import { compactRecording } from '../recording/compactCodec'
import {
  DailyReplaySession,
  DAY_SPEEDS,
  availablePeriods,
  observationBars,
} from '../recording/dailyReplay'
import type { BusinessItem } from '../recording/dailyReplay'
import {
  replayEventWindow,
  replayNextWindowAnchor,
  replayPrevWindowAnchor,
  replayStepInWindow,
} from '../recording/compactReplay'
import { describeGap, gapCoveringSeq, summarizeGaps } from '../recording/replay'
import { cycleDirection, nextTimeframe } from '../chartNavigation'

// REC-03 按交易日回放：完全离线，只消费传入的已校验录制（v1 或 v2 紧凑）。
// 倒退/前进/空格=一个已录交易日；观察周期（日/周/月）与播放日期独立，跨日保持；
// 图表实例不随日期重建（仅当日画线内容变化时重挂并还原当前视窗），缩放/平移跨日保留。
// 周月只由「当日已见日线」前端聚合；旧文件缺当日日线时如实只展示可用周期并提示。
const props = defineProps<{ recording: RecordingFile | CompactRecordingFile }>()
const emit = defineEmits<{ close: [] }>()

const SPEED_MS = DAY_SPEEDS.map(seconds => seconds * 1000)

const dayIndex = ref(0)
const playing = ref(false)
/** 播放间隔档位下标（秒/日），间隔变化即时重排唯一计时器 */
const speedIndex = ref(2)
/** 用户偏好周期；当日不可用时观察自动落到可用周期，恢复后优先回到偏好 */
const preferredTf = ref<Timeframe>('1D')
const observationTf = ref<Timeframe>('1D')
const windowAnchor = ref(0)
/** 画线内容代数：仅当日画线集变化时递增，驱动图表重挂以还原该日最终画线 */
const drawingEpoch = ref(0)
const replayView = ref<ChartCaptureView | null>(null)
const chartRef = ref<InstanceType<typeof KlineChart> | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let replayViewClearFrame: number | null = null

const compactFile = computed(() =>
  props.recording.schemaVersion === 2 ? props.recording : compactRecording(props.recording),
)
const session = computed(() => new DailyReplaySession(compactFile.value))
const dayCount = computed(() => session.value.dayCount)
const day = computed(() => session.value.day(dayIndex.value))
const state = computed(() => session.value.state(dayIndex.value))
const observation = computed(() => observationBars(state.value, observationTf.value))
const periods = computed(() => availablePeriods(state.value))
const noCheckpoints = computed(() => compactFile.value.checkpoints.length === 0)
const gaps = computed(() => compactFile.value.gaps)
const gapSummary = computed(() => summarizeGaps(gaps.value))
// 与当日区间相交的缺口：按日推进时如实保留缺口提示
const dayGap = computed<RecordingGap | null>(() => {
  const range = day.value
  return gaps.value.find(gap =>
    gap.afterSeq <= range.lastSeq && (gap.resumedAtSeq === null || gap.resumedAtSeq >= range.firstSeq),
  ) ?? null
})
const stepGap = computed(() => gapCoveringSeq(gaps.value, day.value.lastSeq))

const dayLabel = computed(() => {
  const total = dayCount.value
  if (total === 0) return '无交易日'
  return `第 ${dayIndex.value + 1} / ${total} 日 · ${state.value.date}`
})
const businessItems = computed(() => session.value.businessItems)
const dayTail = computed(() => {
  const items = businessItems.value
  let tail: BusinessItem | null = null
  for (const item of items) {
    if (item.dayIndex !== day.value.index) continue
    tail = item
  }
  return tail
})
const dayText = computed(() => {
  if (state.value.stale) return '当日无快照 · 显示最近一次已记录状态'
  const tail = dayTail.value
  return tail ? tail.label + outcomeSuffix(tail.outcome) : '当日无业务操作'
})

function outcomeSuffix(outcome: BusinessItem['outcome']): string {
  if (outcome === 'rejected') return '（拒单）'
  if (outcome === 'failed') return '（失败）'
  if (outcome === 'unknown') return '（结果未知）'
  return ''
}

const finerDataHint = computed(() => {
  if (state.value.dailyBars || !state.value.fallback) return null
  return `此日期仅记录了${PERIOD_NAMES[state.value.fallback.timeframe]}快照，缺少当日日线`
})
const PERIOD_NAMES: Record<Timeframe, string> = { '1D': '日K', '1W': '周K', '1M': '月K' }

const metaShort = computed(() => {
  const file = compactFile.value
  const parts = [
    file.trainingKey ?? `会话 ${file.sessionId}`,
    `${dayCount.value} 个交易日`,
    `${businessItems.value.length} 条业务操作`,
  ]
  return parts.join(' · ')
})
const metaFull = computed(() => {
  const file = compactFile.value
  return [
    `训练 ${file.trainingKey ?? '未知'}`,
    `会话 ${file.sessionId}`,
    `版本 ${file.app.version}`,
    `提交 ${file.app.gitCommit}`,
    file.complete ? '尾段已闭合' : '尾段未闭合',
    `${file.events.length} 个事件 · ${file.checkpoints.length} 个检查点`,
  ].join(' · ')
})

const KEY_HINT = '空格 下一日 · PgUp/PgDn 前后日 · [ ] 周期 · ↑↓ 缩放 · ←→ 十字线 · Home 最新'

function money(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function clearTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
}

function stopPlayback(): void {
  playing.value = false
  clearTimer()
}

/** 播放调度：固定「秒/日」一个唯一计时器；末日停止；卸载/暂停/手动步进统一重排或清除 */
function scheduleNext(): void {
  timer = setTimeout(() => {
    timer = undefined
    if (!playing.value) return
    if (dayIndex.value >= dayCount.value - 1) {
      playing.value = false
      return
    }
    dayIndex.value += 1
    scheduleNext()
  }, SPEED_MS[speedIndex.value])
}

function togglePlay(): void {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (dayCount.value === 0) return
  if (dayIndex.value >= dayCount.value - 1) dayIndex.value = 0
  playing.value = true
  scheduleNext()
}

/** 前后一日（按钮/键盘）：不打断播放，仅按新日期重排计时器 */
function stepDay(delta: 1 | -1): void {
  if (dayCount.value === 0) return
  const target = Math.min(Math.max(dayIndex.value + delta, 0), dayCount.value - 1)
  if (target === dayIndex.value) {
    if (delta === 1) stopPlayback()
    return
  }
  dayIndex.value = target
  if (playing.value) {
    clearTimer()
    scheduleNext()
  }
}

/** 手动定位（滑杆/操作列表跳转）：暂停播放 */
function seekDay(target: number): void {
  stopPlayback()
  if (dayCount.value === 0) return
  dayIndex.value = Math.min(Math.max(target, 0), dayCount.value - 1)
}

watch(speedIndex, () => {
  if (playing.value) {
    clearTimer()
    scheduleNext()
  }
})

function setObservation(timeframe: Timeframe): void {
  if (!periods.value.includes(timeframe)) return
  preferredTf.value = timeframe
  observationTf.value = timeframe
}

// 日期变化后当前观察周期不可用（旧文件缺日线）：自动落到可用周期，偏好重新可用时切回。
// immediate：挂载首日即缺日线（旧文件首日只有周/月快照）时也必须落位，否则首日停在
// 不可用的 1D 上只剩空态；回落不改偏好，偏好恢复可用后自动切回。
watch(state, current => {
  const available = availablePeriods(current)
  if (available.length === 0) return
  if (!available.includes(observationTf.value)) {
    observationTf.value = available.includes(preferredTf.value) ? preferredTf.value : available[available.length - 1]!
    return
  }
  if (observationTf.value !== preferredTf.value && available.includes(preferredTf.value)) {
    observationTf.value = preferredTf.value
  }
}, { immediate: true })

function captureViewSafely(): ChartCaptureView | null {
  try {
    return chartRef.value?.captureState().view ?? null
  } catch {
    return null
  }
}

// 画线内容跨日变化：图表必须还原该日最终画线（组件内 savedDrawings 只恢复一次），
// 因此仅此时重挂图表；重挂前捕获当前视窗、挂载后按原视窗恢复，缩放/平移不被打断。
watch(() => state.value?.drawingsRef ?? null, (next, previous) => {
  if (previous === undefined || next === previous) return
  const view = captureViewSafely()
  drawingEpoch.value += 1
  if (view) {
    replayView.value = view
    if (replayViewClearFrame !== null) cancelAnimationFrame(replayViewClearFrame)
    replayViewClearFrame = requestAnimationFrame(() => {
      replayViewClearFrame = requestAnimationFrame(() => {
        replayViewClearFrame = null
        replayView.value = null
      })
    })
  }
})

// 业务操作列表窗口：锚点为 1 起始的操作位次（复用事件窗口算术），随当前日移动，翻页只动锚点
const businessWindow = computed(() => replayEventWindow(windowAnchor.value, businessItems.value.length))
const activeBusinessPos = computed(() => {
  const items = businessItems.value
  let pos = -1
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.dayIndex <= dayIndex.value) pos = index
    else break
  }
  return pos
})
watch(activeBusinessPos, pos => {
  const position = pos + 1
  if (!replayStepInWindow(position, businessWindow.value)) windowAnchor.value = Math.max(position, 1)
})
const windowItems = computed(() => {
  const items = businessItems.value
  const list: Array<BusinessItem & { pos: number }> = []
  for (let pos = businessWindow.value.first - 1; pos <= businessWindow.value.last - 1; pos += 1) {
    const item = items[pos]
    if (item) list.push({ ...item, pos })
  }
  return list
})
const atFirstGroup = computed(() => businessWindow.value.first <= 1)
const atLastGroup = computed(() => businessWindow.value.last >= businessItems.value.length)

function showPrevGroup(): void {
  windowAnchor.value = replayPrevWindowAnchor(businessWindow.value)
}

function showNextGroup(): void {
  windowAnchor.value = replayNextWindowAnchor(businessWindow.value, businessItems.value.length)
}

function onBusinessClick(item: BusinessItem & { pos: number }): void {
  seekDay(item.dayIndex)
  windowAnchor.value = item.pos + 1
}

// 键盘仲裁与训练页同口径：输入态与组合键不抢；只读回放绝不写成交/编辑图形
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if ((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.code === 'Space') { event.preventDefault(); stepDay(1); return }
  if (event.key === 'PageUp') { event.preventDefault(); stepDay(-1); return }
  if (event.key === 'PageDown') { event.preventDefault(); stepDay(1); return }
  const direction = cycleDirection(event)
  if (direction) {
    event.preventDefault()
    const available = periods.value
    if (available.length === 0) return
    const current = available.indexOf(observationTf.value) >= 0 ? observationTf.value : available[available.length - 1]!
    setObservation(nextTimeframe(current, direction))
    return
  }
  if (event.key === 'ArrowUp') { event.preventDefault(); chartRef.value?.zoomBy(1 / 1.3); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); chartRef.value?.zoomBy(1.3); return }
  if (event.key === 'ArrowLeft') { event.preventDefault(); chartRef.value?.moveCrosshair(-1); return }
  if (event.key === 'ArrowRight') { event.preventDefault(); chartRef.value?.moveCrosshair(1); return }
  if (event.key === 'Home') { event.preventDefault(); chartRef.value?.resetView(); return }
  // B/S/Delete 在回放中无写入口：吞掉以防误触浏览器行为
  if (event.key === 'Delete' || ['b', 'B', 's', 'S'].includes(event.key)) event.preventDefault()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  stopPlayback()
  if (replayViewClearFrame !== null) cancelAnimationFrame(replayViewClearFrame)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <section class="replay-shell">
    <header class="replay-head">
      <div class="replay-title">
        <h2>录制回放</h2>
        <p class="replay-meta" :title="metaFull">{{ metaShort }}</p>
      </div>
      <button class="replay-close" type="button" aria-label="关闭回放" @click="emit('close')">关闭回放</button>
    </header>

    <p v-if="noCheckpoints" class="replay-empty">
      <strong>暂无可展示状态</strong>
      <span>录制文件中没有检查点，无法回放图表与账户。</span>
    </p>

    <div v-else class="replay-body">
      <div class="replay-main">
        <div class="replay-status">
          <strong class="replay-day">{{ dayLabel }}</strong>
          <div class="replay-tabs" role="tablist" aria-label="观察周期">
            <button
              v-for="timeframe in (['1D', '1W', '1M'] as const)"
              :key="timeframe"
              type="button"
              role="tab"
              :aria-selected="observationTf === timeframe"
              :disabled="!periods.includes(timeframe)"
              @click="setObservation(timeframe)"
            >{{ PERIOD_NAMES[timeframe] }}</button>
          </div>
          <span class="replay-event-text" :title="dayText">{{ dayText }}</span>
          <span v-if="dayGap" class="replay-gap" role="alert" :title="describeGap(dayGap)">缺口</span>
          <span v-if="stepGap && stepGap !== dayGap" class="replay-gap" role="alert" :title="describeGap(stepGap)">缺口</span>
          <span v-if="gapSummary" class="replay-gap-summary" :title="gapSummary">{{ gapSummary }}</span>
          <span v-if="finerDataHint" class="replay-gap" role="alert" :title="finerDataHint">缺日线</span>
        </div>

        <div class="replay-chart">
          <KlineChart
            v-if="observation && state"
            ref="chartRef"
            :key="drawingEpoch"
            :read-only="true"
            :bars="observation.bars"
            :trades="state.training?.trades ?? []"
            :cost-price="state.training?.account.costPrice ?? null"
            :chart-cost-price="state.costPrice"
            :timeframe="observation.timeframe"
            :saved-drawings="state.drawings"
            :replay-view="replayView ?? undefined"
          />
          <div v-else class="replay-chart-empty">
            <strong>该日期没有图表快照</strong>
            <span v-if="state.stale">此日期未捕获图表状态。</span>
            <span v-else>此检查点未捕获图表数据。</span>
          </div>
        </div>

        <div class="replay-controls">
          <button type="button" :disabled="dayIndex <= 0" aria-label="回到第一天" @click="seekDay(0)">首日</button>
          <button type="button" :disabled="dayIndex <= 0" aria-label="上一日" @click="stepDay(-1)">上一日</button>
          <button
            v-if="!playing"
            type="button"
            class="replay-play"
            :disabled="dayCount === 0"
            aria-label="播放录制"
            @click="togglePlay"
          >播放</button>
          <button v-else type="button" class="replay-play" aria-label="暂停回放" @click="togglePlay">暂停</button>
          <button type="button" :disabled="dayIndex >= dayCount - 1" aria-label="下一日" @click="stepDay(1)">下一日</button>
          <button type="button" :disabled="dayIndex >= dayCount - 1" aria-label="跳到最后一天" @click="seekDay(dayCount - 1)">末日</button>
          <label class="replay-speed">
            间隔
            <select v-model.number="speedIndex" aria-label="每日播放时长">
              <option v-for="(ms, index) in SPEED_MS" :key="ms" :value="index">{{ DAY_SPEEDS[index] }} 秒/日</option>
            </select>
          </label>
          <input
            class="replay-range"
            type="range"
            min="0"
            :max="Math.max(dayCount - 1, 0)"
            step="1"
            :value="dayIndex"
            aria-label="回放日期"
            @input="seekDay(Number(($event.target as HTMLInputElement).value))"
          >
          <span class="replay-hint" :title="KEY_HINT">{{ KEY_HINT }}</span>
        </div>
      </div>

      <aside class="replay-side">
        <section class="replay-panel">
          <h3>账户摘要</h3>
          <template v-if="state.training">
            <p class="replay-account-title">
              {{ state.training.training.code ?? '未知代码' }} {{ state.training.training.name ?? '' }}
              · {{ state.date }}
            </p>
            <dl class="replay-account">
              <div><dt>总权益</dt><dd>{{ money(state.training.account.equity) }}</dd></div>
              <div><dt>现金</dt><dd>{{ money(state.training.account.cash) }}</dd></div>
              <div><dt>市值</dt><dd>{{ money(state.training.account.marketValue) }}</dd></div>
              <div><dt>持仓</dt><dd>{{ state.training.account.shares }} 股</dd></div>
              <div><dt>可用</dt><dd>{{ state.training.account.availableShares }} 股</dd></div>
              <div>
                <dt>成本价</dt>
                <dd>{{ state.training.account.costPrice === null ? '—' : money(state.training.account.costPrice) }}</dd>
              </div>
            </dl>
            <p v-if="state.stale" class="replay-panel-note">当日范围无快照，以上为此前最近一次已记录状态。</p>
          </template>
          <p v-else class="replay-panel-empty">该日期没有账户快照。</p>
        </section>

        <section class="replay-panel replay-events">
          <h3>业务操作</h3>
          <p v-if="businessItems.length === 0" class="replay-panel-empty">录制中没有买卖与图形变更。</p>
          <template v-else>
            <div class="replay-window-nav">
              <button
                type="button"
                :disabled="atFirstGroup"
                title="上一组操作"
                aria-label="上一组操作"
                @click="showPrevGroup"
              ><ChevronUp :size="14" aria-hidden="true" />上一组</button>
              <span class="replay-window-range">操作 {{ businessWindow.first }}–{{ businessWindow.last }}</span>
              <button
                type="button"
                :disabled="atLastGroup"
                title="下一组操作"
                aria-label="下一组操作"
                @click="showNextGroup"
              >下一组<ChevronDown :size="14" aria-hidden="true" /></button>
            </div>
            <ol class="replay-event-list">
              <li v-for="item in windowItems" :key="item.seq">
                <button
                  type="button"
                  :class="{ active: item.dayIndex === dayIndex }"
                  :aria-current="item.dayIndex === dayIndex ? 'true' : undefined"
                  @click="onBusinessClick(item)"
                >
                  <span class="event-seq">{{ item.pos + 1 }}</span>
                  <span class="event-text">{{ item.label }}{{ outcomeSuffix(item.outcome) }}</span>
                </button>
              </li>
            </ol>
          </template>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
/* 主题色变量仅在 body.dark 下定义，浅色按全局浅色底给同源回退值 */
.replay-shell {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - var(--topbar-h, 28px));
  min-width: 0;
  min-height: 0;
  color: var(--text-primary, #172033);
  background: var(--surface-background, #f4f6f9);
}
.replay-head {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  background: var(--surface-background, #ffffff);
  border-bottom: 1px solid var(--surface-border, #e1e6ec);
  min-width: 0;
}
.replay-title { min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.replay-title h2 { margin: 0; font-size: 14px; white-space: nowrap; }
.replay-meta {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted, #5d7087);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.replay-close {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--surface-border, #d8e0e8);
  background: var(--control-background, #ffffff);
  color: var(--text-secondary, #617286);
}
.replay-close:hover { border-color: #94bec5; color: var(--text-primary, #1c6076); }
.replay-empty {
  margin: 24px auto;
  padding: 18px 26px;
  display: grid;
  gap: 6px;
  justify-items: center;
  border: 1px solid var(--surface-border, #dfe5eb);
  border-radius: 6px;
  background: var(--surface-background, #ffffff);
  color: var(--text-secondary, #64748a);
  font-size: 12px;
}
.replay-empty strong { font-size: 14px; color: var(--text-primary, #3c4d62); }
.replay-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 264px;
  gap: 10px;
  padding: 10px 12px 12px;
}
.replay-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.replay-status {
  flex: 0 0 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
}
.replay-day { white-space: nowrap; font-variant-numeric: tabular-nums; }
.replay-tabs { display: flex; gap: 2px; flex: 0 0 auto; }
.replay-tabs button {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  border: 1px solid var(--surface-border, #d8e0e8);
  border-radius: 4px;
  background: var(--control-background, #ffffff);
  color: var(--text-secondary, #38596d);
  white-space: nowrap;
}
.replay-tabs button:hover:not(:disabled) { border-color: #94bec5; color: var(--text-primary, #1c6076); }
.replay-tabs button:disabled { opacity: 0.4; cursor: not-allowed; }
.replay-tabs button[aria-selected='true'] {
  background: var(--surface-selected, #e3eef3);
  color: var(--text-primary, #1c3a4a);
  font-weight: 650;
  border-color: #94bec5;
}
.replay-event-text {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary, #33455c);
}
.replay-gap {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 1px 8px;
  border-radius: 3px;
  color: #b45309;
  background: rgba(180, 83, 9, 0.12);
}
body.dark .replay-gap { color: #e0a35a; background: rgba(224, 163, 90, 0.16); }
/* 常驻摘要：任何日期都保留未记录区间总数，仅提示存在、不随日消失 */
.replay-gap-summary {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 1px 8px;
  border-radius: 3px;
  color: var(--text-muted, #5d7087);
  background: var(--surface-hover, #eef3f7);
}
body.dark .replay-gap-summary { color: var(--text-muted, #8a98a9); background: rgba(138, 152, 169, 0.18); }
.replay-chart { position: relative; flex: 1; min-height: 0; border: 1px solid var(--surface-border, #dfe5eb); background: var(--chart-background, #ffffff); }
.replay-chart-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  color: var(--text-muted, #98a5b4);
  font-size: 12px;
}
.replay-chart-empty strong { font-size: 14px; color: var(--text-secondary, #3c4d62); }
.replay-controls {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0 0;
  min-width: 0;
}
.replay-controls > button {
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--surface-border, #d8e0e8);
  background: var(--control-background, #ffffff);
  color: var(--text-secondary, #38596d);
  white-space: nowrap;
}
.replay-controls > button:hover:not(:disabled) { border-color: #94bec5; color: var(--text-primary, #1c6076); }
.replay-controls > button:disabled { opacity: 0.45; cursor: not-allowed; }
.replay-play { font-weight: 650; min-width: 64px; }
.replay-speed {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted, #5d7087);
  white-space: nowrap;
}
.replay-speed select {
  height: 30px;
  border: 1px solid var(--surface-border, #d5dde7);
  border-radius: 4px;
  background: var(--control-background, #ffffff);
  color: var(--text-primary, #233044);
  font-size: 12px;
  padding: 0 4px;
}
.replay-range { flex: 1 1 60px; min-width: 40px; accent-color: #2e8191; }
.replay-hint {
  flex: 1 1 auto;
  font-size: 11px;
  color: var(--text-muted, #8a98a9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  text-align: right;
}
.replay-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; }
.replay-panel {
  border: 1px solid var(--surface-border, #dfe5eb);
  background: var(--surface-background, #ffffff);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.replay-panel h3 { margin: 0 0 8px; font-size: 13px; }
.replay-panel-empty { margin: 0; font-size: 12px; color: var(--text-muted, #94a2b2); }
.replay-panel-note { margin: 8px 0 0; font-size: 11px; color: var(--text-muted, #8a98a9); }
.replay-account-title {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary, #62748a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.replay-account {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
}
.replay-account dt { font-size: 11px; color: var(--text-muted, #8a98a9); }
.replay-account dd {
  margin: 2px 0 0;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.replay-events { flex: 1; min-height: 0; }
.replay-window-nav {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 0 0 6px;
}
.replay-window-nav button {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--surface-border, #d8e0e8);
  background: var(--control-background, #ffffff);
  color: var(--text-secondary, #38596d);
  white-space: nowrap;
}
.replay-window-nav button:hover:not(:disabled) { border-color: #94bec5; color: var(--text-primary, #1c6076); }
.replay-window-nav button:disabled { opacity: 0.45; cursor: not-allowed; }
.replay-window-range {
  font-size: 11px;
  color: var(--text-muted, #8a98a9);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.replay-event-list {
  margin: 0;
  padding: 0;
  list-style: none;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.replay-event-list button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 4px 6px;
  font-size: 12px;
  border-radius: 3px;
  color: var(--text-secondary, #33455c);
  min-width: 0;
}
.replay-event-list button:hover { background: var(--surface-hover, #eef3f7); }
.replay-event-list button.active { background: var(--surface-selected, #e3eef3); color: var(--text-primary, #1c3a4a); font-weight: 600; }
.event-seq { flex: 0 0 26px; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-muted, #94a2b2); }
.replay-event-list button.active .event-seq { color: inherit; }
.event-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
