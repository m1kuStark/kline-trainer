import type { DatabaseSync } from 'node:sqlite'
import { loadAdjustmentEvents } from '../tdx/adjustment-cache.js'
import { buildForwardAdjustmentSegments } from '../tdx/gbbq.js'
import { HttpError } from './engine.js'

// 固定并行接口（docs/engineering/stage-feedback-20260919.md DRAW-02）：
// DrawingPriceBasis 表示已发生权息的累计仿射变换，显示价 = 原始价 * scale + offset；
// 无权息事件或不复权为 1/0。旧基准到新基准的统一变换见 web/src/drawingPriceBasis.ts。
export interface DrawingPriceBasis {
  scale: number
  offset: number
}

// 图表级基准取 buildForwardAdjustmentSegments 最老一段的累计 a/b，即截至推进日全部已发生
// 事件的复合变换。锚定在部分权息之后的历史K线同样正确：推进只新增更新的事件，相邻两次基准
// 满足 F_new = G_new ∘ F_old，画线投影 F_new ∘ F_old⁻¹ = G_new 恰好抵消两份基准共有的早先
// 事件，各年代锚点只吃到新发生事件的变换。只按推进日截断权息（事件 <= current_date ??
// start_date），未来事件不参与，返回值不含任何日期，不暴露盲训推进位置。
export function drawingPriceBasis(database: DatabaseSync, trainingId: number): DrawingPriceBasis {
  if (!Number.isSafeInteger(trainingId) || trainingId < 1) throw new HttpError(400, 'id 必须是正整数')
  // current_date 与 SQLite 的 CURRENT_DATE 关键字同名：必须加引号按列名解析，否则查到的是当天日期。
  const row = database.prepare(`
    SELECT market, code, adjust_mode, "current_date", start_date FROM trainings WHERE id = ?
  `).get(trainingId) as
    | { market: string; code: string; adjust_mode: 'forward' | 'raw'; current_date: string | null; start_date: string }
    | undefined
  if (!row) throw new HttpError(404, 'Training not found')
  if (row.adjust_mode !== 'forward') return { scale: 1, offset: 0 }
  const current = row.current_date ?? row.start_date
  const events = loadAdjustmentEvents(database, row.market as 'sh' | 'sz' | 'bj', row.code)
    .filter(event => event.date <= current)
  if (!events.length) return { scale: 1, offset: 0 }
  const oldest = buildForwardAdjustmentSegments(events).at(-1)
  return oldest ? { scale: oldest.a, offset: oldest.b } : { scale: 1, offset: 0 }
}
