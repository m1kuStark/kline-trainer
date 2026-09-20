// REC-02 业务口径：web/src/recording/businessEvents.ts
// 业务列表/计数只突出「完成的买卖」与「图形/文字变更」（用户阶段验收行为5/返修合同REC-02）：
// started 去重、cancelled/no-op 排除，明确的拒单/失败交易按拒单标注计入。
// 推进构成交易日轴但不是业务动作；工具/主题/视口/周期/加载/保存与暂停/恢复/中断等
// 生命周期元事件同样排除——它们仍留在录制事件流里（时间轴数据），只是不进业务口径。
// 旧文件兼容：不修改既有历史，只按本口径筛选展示。
import type { Action, RecordingEvent } from './types'

/** 业务动作白名单：买卖与图形/文字变更；画线取消（chart.drawing.cancel）是 no-op 不算业务 */
const BUSINESS_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'training.trade',
  'chart.drawing.create',
  'chart.drawing.edit',
  'chart.drawing.move',
  'chart.drawing.delete',
  'chart.drawing.undo',
  'chart.drawing.redo',
  'chart.drawing.clear',
])

/** 结局排除表：cancelled 是显式 no-op；interrupted 是暂停/中断补齐的生命周期元数据。
 * accepted/rejected/failed/unknown 均计入——拒单要标注，结果未知不能静默丢失。 */
const EXCLUDED_OUTCOMES: ReadonlySet<NonNullable<RecordingEvent['outcome']>> = new Set([
  'cancelled',
  'interrupted',
])

/** 该动作是否属于业务口径（不含完成态判断；与 businessEvents 的事件过滤配套使用） */
export function isBusinessAction(action: Action): boolean {
  return BUSINESS_ACTIONS.has(action)
}

/** 从事件流筛选业务事件：仅 finished 的业务动作，去 started 重复、去 cancelled/interrupted */
export function businessEvents(events: readonly RecordingEvent[]): RecordingEvent[] {
  return events.filter(
    event =>
      event.phase === 'finished' &&
      BUSINESS_ACTIONS.has(event.action) &&
      !(event.outcome !== undefined && EXCLUDED_OUTCOMES.has(event.outcome)),
  )
}
