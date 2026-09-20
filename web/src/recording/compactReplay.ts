// REC-01 v2回放纯逻辑：轻量检查点二分选择与有界事件窗口。
// 只消费已通过校验的紧凑录制数据；不触 DOM、不引存储/录制器/训练与图表 API。
import type { CompactCheckpoint } from './compactTypes'

/** 操作列表单屏窗口上限：界面一次最多渲染的事件条数 */
export const REPLAY_EVENT_WINDOW = 100

/** 事件窗口边界：first/last 为事件真实 seq（1..事件总数），last < first 表示空窗口 */
export interface ReplayEventWindow {
  first: number
  last: number
}

/**
 * 最近 afterSeq <= seq 的轻量检查点下标；没有满足条件的返回 null（首步可能无检查点）。
 * 校验合同保证 afterSeq 非递减，二分只定位覆盖当前步的最后一个下标：
 * 同 afterSeq 取靠后者（更完整状态），不返回任何只覆盖未来步骤的检查点。
 */
export function compactCheckpointIndexForSeq(
  checkpoints: readonly CompactCheckpoint[],
  seq: number,
): number | null {
  let low = 0
  let high = checkpoints.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((checkpoints[mid] as CompactCheckpoint).afterSeq <= seq) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found === -1 ? null : found
}

/**
 * 以 anchor 步为中心、最多 size 项的事件 seq 窗口（稳定边界）：
 * 边界只由 anchor 决定并夹取到 1..totalEvents，起点/终点同样补满整窗；
 * totalEvents 为 0 时返回空窗口（first=1、last=0）。anchor=0（初始步）落在首窗。
 */
export function replayEventWindow(anchorSeq: number, totalEvents: number, size = REPLAY_EVENT_WINDOW): ReplayEventWindow {
  if (totalEvents <= 0) return { first: 1, last: 0 }
  const width = Math.min(Math.max(size, 1), totalEvents)
  const anchor = Math.min(Math.max(anchorSeq, 0), totalEvents)
  const first = Math.min(Math.max(anchor - ((width - 1) >> 1), 1), totalEvents - width + 1)
  return { first, last: first + width - 1 }
}

/** 步 seq 是否在窗口内：第 0 步视作首窗的一部分（首窗总是覆盖初始状态） */
export function replayStepInWindow(seq: number, window: ReplayEventWindow): boolean {
  const lower = window.first === 1 ? 0 : window.first
  return seq >= lower && seq <= window.last
}

/** 上一组窗口的锚点：尽量整窗前移（新窗口末项 = 当前首项 − 1），起点夹取到首窗 */
export function replayPrevWindowAnchor(current: ReplayEventWindow, size = REPLAY_EVENT_WINDOW): number {
  const first = Math.max(1, current.first - size)
  return first + ((size - 1) >> 1)
}

/** 下一组窗口的锚点：尽量整窗后移（新窗口首项 = 当前末项 + 1），终点夹取保持整窗 */
export function replayNextWindowAnchor(current: ReplayEventWindow, totalEvents: number, size = REPLAY_EVENT_WINDOW): number {
  if (totalEvents <= 0) return 0
  const width = Math.min(Math.max(size, 1), totalEvents)
  const first = Math.min(totalEvents - width + 1, current.last + 1)
  return first + ((width - 1) >> 1)
}
