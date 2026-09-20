// 来源选择链：本地 TDX 可用 → 用 TDX；否则已注册且可用的在线源 → 用之；否则 none。

import { listOnlineSources } from './source.js'
import type { DailySource } from './source.js'

export interface SourceSelection {
  /** 选中的来源；null＝无任何可用来源 */
  source: DailySource | null
  tdxAvailable: boolean
  onlineConfigured: boolean
  /** 已注册在线源名（未配置为 null） */
  onlineProvider: string | null
}

export async function selectSource(tdxSource: DailySource | null): Promise<SourceSelection> {
  const tdxAvailable = tdxSource !== null && await tdxSource.available()
  if (tdxSource && tdxAvailable) {
    const online = listOnlineSources()
    return { source: tdxSource, tdxAvailable: true, onlineConfigured: online.length > 0, onlineProvider: online[0]?.name ?? null }
  }
  const online = listOnlineSources()
  for (const candidate of online) {
    if (await candidate.available()) {
      return { source: candidate, tdxAvailable: false, onlineConfigured: true, onlineProvider: candidate.name }
    }
  }
  return { source: null, tdxAvailable, onlineConfigured: online.length > 0, onlineProvider: online[0]?.name ?? null }
}

/** 简化版：只返回选中的来源（无可用来源时为 null）。 */
export async function pickSource(tdxSource: DailySource | null): Promise<DailySource | null> {
  return (await selectSource(tdxSource)).source
}
