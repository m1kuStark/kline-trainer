// REC-PLAYER：回放纯 helper（检查点选择、播放间隔、事件与缺口说明）。
// 只消费已通过 validateRecording 的 RecordingFile 数据；不触 DOM、不引存储/录制器/训练与图表 API。
import type { Action, RecordingCheckpoint, RecordingEvent, RecordingEventOutcome, RecordingEventSource, RecordingGap } from './types'

/** 单步播放等待上限：真实间隔过长时按此截断，避免回放在稀疏区段长时间停住 */
export const MAX_STEP_WAIT_MS = 2000

/**
 * 最近 afterSeq <= seq 的检查点；没有满足条件的返回 null（首步可能无检查点）。
 * 校验合同保证 afterSeq 非递减，遇到第一个未来检查点即停：即使数组异常也不前窥未来状态。
 * 同 afterSeq 的多个检查点取数组靠后者（更完整状态）。
 */
export function checkpointForSeq(checkpoints: readonly RecordingCheckpoint[], seq: number): RecordingCheckpoint | null {
  let selected: RecordingCheckpoint | null = null
  for (const checkpoint of checkpoints) {
    if (checkpoint.afterSeq > seq) break
    selected = checkpoint
  }
  return selected
}

/**
 * 覆盖第 seq 步的录制缺口：缺口是暂停期间未记录的时间/操作区间，不产生缺失的事件序号
 * （真实录制 pause 的 afterSeq=N 与 resume 的 resumedAtSeq=N+1 永远相邻）。
 * 在两个边界步命中：暂停边界步 seq=afterSeq 与恢复边界步 seq=resumedAtSeq；
 * 未恢复的缺口自 afterSeq 起延续到末尾（含 afterSeq=0 的初始第 0 步）。无命中返回 null。
 */
export function gapCoveringSeq(gaps: readonly RecordingGap[], seq: number): RecordingGap | null {
  for (const gap of gaps) {
    if (seq < gap.afterSeq) continue
    if (gap.resumedAtSeq === null || seq <= gap.resumedAtSeq) return gap
  }
  return null
}

/**
 * 当前步播放到下一步的等待毫秒：用相邻事件的 elapsedMs 差按倍速缩放，封顶 MAX_STEP_WAIT_MS。
 * seq 为当前步（下一步事件下标即 seq）；已是最后一步、倍速非正数或间隔为零都返回 0（立即推进/不推进）。
 */
export function stepWaitMs(events: readonly RecordingEvent[], seq: number, speed: number): number {
  const next = events[seq]
  if (next === undefined || !(speed > 0)) return 0
  const previousElapsedMs = seq > 0 ? events[seq - 1]?.elapsedMs ?? 0 : 0
  const delta = Math.max(0, next.elapsedMs - previousElapsedMs)
  return Math.min(delta / speed, MAX_STEP_WAIT_MS)
}

const ACTION_LABELS: Record<Action, string> = {
  'training.create': '创建训练',
  'training.advance': '推进交易日',
  'training.trade': '下单交易',
  'training.settle': '结算训练',
  'training.abandon': '放弃训练',
  'chart.load': '加载图表',
  'chart.timeframe': '切换周期',
  'chart.viewport': '调整视窗',
  'chart.tool': '切换画线工具',
  'chart.drawing.create': '新增画线',
  'chart.drawing.edit': '编辑画线',
  'chart.drawing.move': '移动画线',
  'chart.drawing.delete': '删除画线',
  'chart.drawing.undo': '撤销画线',
  'chart.drawing.redo': '重做画线',
  'chart.drawing.cancel': '取消画线',
  'chart.drawing.clear': '清空画线',
  'drawings.save': '保存画线',
  'ui.theme': '切换主题',
  'recording.pause': '暂停录制',
  'recording.resume': '恢复录制',
  'session.interrupted': '录制中断',
}

const SOURCE_LABELS: Record<RecordingEventSource, string> = {
  ui: '界面',
  keyboard: '键盘',
  chart: '图表',
  system: '系统',
}

const OUTCOME_LABELS: Record<RecordingEventOutcome, string> = {
  accepted: '完成',
  rejected: '被拒绝',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被中断',
  unknown: '结果未知',
}

/** 事件的中文说明：动作 · 来源 · 阶段/结果（如「推进交易日 · 键盘 · 完成」） */
export function describeEvent(event: RecordingEvent): string {
  const parts = [ACTION_LABELS[event.action], SOURCE_LABELS[event.source]]
  if (event.phase === 'started') parts.push('开始')
  else parts.push(OUTCOME_LABELS[event.outcome ?? 'unknown'])
  return parts.join(' · ')
}

/** 缺口的中文提示：描述暂停期间未记录的时间/操作区间，不声称存在缺失的事件序号 */
export function describeGap(gap: RecordingGap): string {
  const from = gap.afterSeq === 0 ? '会话开始' : `第 ${gap.afterSeq} 个事件后`
  if (gap.resumedAtSeq === null) return `录制自${from}暂停，此后未记录`
  return `录制自${from}暂停，至第 ${gap.resumedAtSeq} 个事件恢复，期间的操作未记录`
}

/** 常驻摘要：不受当前步影响的未记录区间总数；无缺口返回 null */
export function summarizeGaps(gaps: readonly RecordingGap[]): string | null {
  if (gaps.length === 0) return null
  return `本录制含 ${gaps.length} 段未记录区间`
}
