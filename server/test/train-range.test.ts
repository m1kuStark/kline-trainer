import { describe, expect, it } from 'vitest'
import { planTrainingRange, presetDates } from '../src/train/range.js'
import type { TrainingRangeInput, TrainingRangeRequest } from '../src/train/range.js'

// 合成夹具：仅按公历星期一~五生成"交易日"，不用真实日历、不通达信目录、不写任何库。
function weekdays(from: string, through: string): string[] {
  const out: string[] = []
  let cursor = from
  while (cursor <= through) {
    const [year, month, day] = cursor.split('-').map(Number)
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    if (weekday >= 1 && weekday <= 5) out.push(cursor)
    const next = new Date(Date.UTC(year, month - 1, day) + 86400000)
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  }
  return out
}

// 2026-01-01(四)…01-30(五)：22 根；today 01-31(六)。
const JAN = weekdays('2026-01-01', '2026-01-30')
// 2026-09-01(二)…09-22(二)：16 根；today 09-23(三)。
const SEP = weekdays('2026-09-01', '2026-09-22')
// 2024-01-29(一)…02-29(四，闰年)：24 根。
const FEB24 = weekdays('2024-01-29', '2024-02-29')

function plan(request: TrainingRangeRequest, dates: readonly string[], today: string, knownClosedDates?: readonly string[]) {
  return planTrainingRange({ request, dates, today, knownClosedDates } satisfies TrainingRangeInput)
}

function invalidHostile(input: unknown): void {
  const result = planTrainingRange(input as TrainingRangeInput)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.code).toBe('INVALID_INPUT')
}

describe('presetDates 自然月回溯', () => {
  it('半年回溯返回固定 today 终点', () => {
    expect(presetDates('2026-09-23', 6)).toEqual({ startDate: '2026-03-23', endDate: '2026-09-23' })
  })

  it('非闰年二月与三十日月做月末裁剪', () => {
    expect(presetDates('2026-03-31', 1).startDate).toBe('2026-02-28')
    expect(presetDates('2026-05-31', 1).startDate).toBe('2026-04-30')
  })

  it('闰年二月保留 29 日', () => {
    expect(presetDates('2024-03-31', 1).startDate).toBe('2024-02-29')
  })

  it('跨年十二个月回溯', () => {
    expect(presetDates('2025-02-28', 12)).toEqual({ startDate: '2024-02-28', endDate: '2025-02-28' })
  })

  it('非法 today 或月份明确抛错而不是给假窗口', () => {
    expect(() => presetDates('2026-9-23', 6)).toThrow()
    expect(() => presetDates('2026-13-01', 6)).toThrow()
    expect(() => presetDates('2026-09-23', 5 as 6)).toThrow()
    expect(() => presetDates('2026-09-23', 0 as 1)).toThrow()
  })
})

describe('preset 自然月窗口', () => {
  it('2026-01 起一个月：终点 02-01 落在周末，尾段全周末时允许取末根', () => {
    // today 取 02-02：终点 02-01 不晚于 today，才进入尾段周末判定（终点 > today 一律 INSUFFICIENT_DATA）。
    const result = plan({ mode: 'preset', startDate: '2026-01-01', months: 1 }, JAN, '2026-02-02')
    expect(result).toEqual({
      ok: true,
      mode: 'preset',
      requestedStart: '2026-01-01',
      requestedEnd: '2026-02-01',
      startDate: '2026-01-01',
      endDate: '2026-01-30',
      barCount: 22,
      notes: expect.arrayContaining([
        expect.stringContaining('仅按现有日线'),
        expect.stringContaining('尾段'),
      ]),
    })
  })

  it('闰年窗口：2024-01-31 起一个月裁剪到 02-29 并覆盖到月末', () => {
    const result = plan({ mode: 'preset', startDate: '2024-01-31', months: 1 }, FEB24, '2024-03-01')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.requestedEnd).toBe('2024-02-29')
      expect(result.startDate).toBe('2024-01-31')
      expect(result.endDate).toBe('2024-02-29')
      expect(result.barCount).toBe(22)
    }
  })

  it('自然月推算终点晚于 today 返回 INSUFFICIENT_DATA，不截短到今天', () => {
    const result = plan({ mode: 'preset', startDate: '2026-01-15', months: 1 }, JAN, '2026-01-31')
    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_DATA' })
    if (!result.ok) expect(result.message).toContain('不截短')
  })

  it('显式 endDate 圈定系统日期回推窗口', () => {
    const result = plan({ mode: 'preset', startDate: '2026-01-05', months: 3, endDate: '2026-01-16' }, JAN, '2026-01-31')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.requestedStart).toBe('2026-01-05')
      expect(result.requestedEnd).toBe('2026-01-16')
      expect(result.startDate).toBe('2026-01-05')
      expect(result.endDate).toBe('2026-01-16')
      expect(result.barCount).toBe(10)
    }
  })

  it('显式 endDate 早于 startDate 或晚于 today 都是 INVALID_INPUT', () => {
    expect(plan({ mode: 'preset', startDate: '2026-01-16', months: 3, endDate: '2026-01-05' }, JAN, '2026-01-31'))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(plan({ mode: 'preset', startDate: '2026-01-01', months: 1, endDate: '2026-02-05' }, JAN, '2026-01-31'))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('尾段缺口全为周末：09-18(五) 末根可以撑到 09-20(日) 终点', () => {
    const result = plan({ mode: 'preset', startDate: '2026-09-14', months: 3, endDate: '2026-09-20' }, SEP, '2026-09-23')
    expect(result).toEqual({
      ok: true,
      mode: 'preset',
      requestedStart: '2026-09-14',
      requestedEnd: '2026-09-20',
      startDate: '2026-09-14',
      endDate: '2026-09-18',
      barCount: 5,
      notes: expect.arrayContaining([expect.stringContaining('仅按现有日线')]),
    })
  })

  it('尾段工作日在 knownClosedDates 中：末日休市可取末根', () => {
    const result = plan(
      { mode: 'preset', startDate: '2026-09-01', months: 1, endDate: '2026-09-23' },
      SEP,
      '2026-09-23',
      ['2026-09-23'],
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.endDate).toBe('2026-09-22')
      expect(result.barCount).toBe(16)
    }
  })

  it('尾段含未证实工作日返回 UNCONFIRMED_COVERAGE 并点名日期', () => {
    const result = plan({ mode: 'preset', startDate: '2026-09-01', months: 1, endDate: '2026-09-23' }, SEP, '2026-09-23')
    expect(result).toMatchObject({ ok: false, code: 'UNCONFIRMED_COVERAGE' })
    if (!result.ok) expect(result.message).toContain('2026-09-23')
  })

  it('窗口内没有任何日线（周末对周末）返回 INSUFFICIENT_DATA', () => {
    const result = plan({ mode: 'preset', startDate: '2026-09-19', months: 1, endDate: '2026-09-20' }, SEP, '2026-09-23')
    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_DATA' })
  })
})

describe('latest 钉定末根', () => {
  it('从起点对齐到本地最后一根', () => {
    const result = plan({ mode: 'latest', startDate: '2026-01-12' }, JAN, '2026-01-31')
    expect(result).toEqual({
      ok: true,
      mode: 'latest',
      requestedStart: '2026-01-12',
      requestedEnd: null,
      startDate: '2026-01-12',
      endDate: '2026-01-30',
      barCount: 15,
      notes: expect.arrayContaining([expect.stringContaining('仅按现有日线')]),
    })
  })

  it('九月夹具钉定 09-22 末根', () => {
    const result = plan({ mode: 'latest', startDate: '2026-09-01' }, SEP, '2026-09-23')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.endDate).toBe('2026-09-22')
      expect(result.barCount).toBe(16)
    }
  })
})

describe('bars 按根数', () => {
  it('N=1 成功且只含首根', () => {
    const result = plan({ mode: 'bars', startDate: '2026-01-01', count: 1 }, JAN, '2026-01-31')
    expect(result).toEqual({
      ok: true,
      mode: 'bars',
      requestedStart: '2026-01-01',
      requestedEnd: null,
      startDate: '2026-01-01',
      endDate: '2026-01-01',
      barCount: 1,
      notes: expect.arrayContaining([expect.stringContaining('仅按现有日线')]),
    })
  })

  it('恰好取完可用根数成功', () => {
    const result = plan({ mode: 'bars', startDate: '2026-01-01', count: 22 }, JAN, '2026-01-31')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.endDate).toBe('2026-01-30')
  })

  it('超过可用根数明确失败不截短', () => {
    expect(plan({ mode: 'bars', startDate: '2026-01-01', count: 23 }, JAN, '2026-01-31'))
      .toMatchObject({ ok: false, code: 'INSUFFICIENT_DATA' })
  })

  it('月中起点按对齐首根数三根', () => {
    const result = plan({ mode: 'bars', startDate: '2026-09-14', count: 3 }, SEP, '2026-09-23')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.startDate).toBe('2026-09-14')
      expect(result.endDate).toBe('2026-09-16')
      expect(result.barCount).toBe(3)
    }
  })

  it('起点落在周末时对齐下一根且只算 N 根', () => {
    const result = plan({ mode: 'bars', startDate: '2026-09-19', count: 1 }, SEP, '2026-09-23')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.startDate).toBe('2026-09-21')
      expect(result.barCount).toBe(1)
      expect(result.notes.join('\n')).toContain('对齐')
    }
  })

  it('对齐后可用 7 根要 8 根返回 INSUFFICIENT_DATA', () => {
    expect(plan({ mode: 'bars', startDate: '2026-09-14', count: 8 }, SEP, '2026-09-23'))
      .toMatchObject({ ok: false, code: 'INSUFFICIENT_DATA' })
  })
})

describe('历史与数据边界', () => {
  it('请求早于本地首根返回 BEFORE_HISTORY 且不声称早于上市', () => {
    const result = plan({ mode: 'latest', startDate: '2025-12-01' }, JAN, '2026-01-31')
    expect(result).toMatchObject({ ok: false, code: 'BEFORE_HISTORY' })
    if (!result.ok) {
      expect(result.message).toContain('本地首根')
      // 合同要求不得把本地缺口说成"早于上市"，必须以免责口吻说明。
      expect(result.message).toContain('不代表早于上市')
    }
  })

  it('请求起点晚于本地末根返回 AFTER_DATA', () => {
    expect(plan({ mode: 'preset', startDate: '2026-01-31', months: 1 }, JAN, '2026-01-31'))
      .toMatchObject({ ok: false, code: 'AFTER_DATA' })
  })

  it('dates 为空返回 NO_DATA', () => {
    expect(plan({ mode: 'latest', startDate: '2026-01-01' }, [], '2026-01-31'))
      .toMatchObject({ ok: false, code: 'NO_DATA' })
  })
})

describe('异常输入从 JS 调用不静默成功', () => {
  it('input 为 null 返回 INVALID_INPUT 而不是抛出假成功', () => {
    invalidHostile(null)
  })

  it('dates 形状问题全部 INVALID_INPUT', () => {
    const base = { mode: 'latest', startDate: '2026-01-05' } as const
    invalidHostile({ request: base, dates: ['2026-01-05', '2026-01-02'], today: '2026-01-31' }) // 乱序
    invalidHostile({ request: base, dates: ['2026-01-05', '2026-01-05'], today: '2026-01-31' }) // 重复
    invalidHostile({ request: base, dates: ['2026-01-02', '2026-02-02'], today: '2026-01-31' }) // 晚于 today
    invalidHostile({ request: base, dates: ['2026-1-5'], today: '2026-01-31' }) // 格式
    invalidHostile({ request: base, dates: ['2026-13-01'], today: '2026-01-31' }) // 非法月
    invalidHostile({ request: base, dates: ['20260105'], today: '2026-01-31' }) // 非 ISO
    invalidHostile({ request: base, dates: '2026-01-05', today: '2026-01-31' }) // 非数组
    invalidHostile({ request: base, dates: undefined, today: '2026-01-31' }) // 缺字段
  })

  it('today 或 startDate 非法返回 INVALID_INPUT', () => {
    invalidHostile({ request: { mode: 'latest', startDate: '2026-01-05' }, dates: JAN, today: '明天' })
    invalidHostile({ request: { mode: 'latest', startDate: '2026-01-05' }, dates: JAN, today: undefined })
    invalidHostile({ request: { mode: 'latest', startDate: '2026-1-5' }, dates: JAN, today: '2026-01-31' })
  })

  it('request 形状问题全部 INVALID_INPUT', () => {
    invalidHostile({ request: null, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'weekly', startDate: '2026-01-05' }, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'preset', startDate: '2026-01-05' }, dates: JAN, today: '2026-01-31' }) // 缺 months
    invalidHostile({ request: { mode: 'preset', startDate: '2026-01-05', months: 5 }, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'bars', startDate: '2026-01-05' }, dates: JAN, today: '2026-01-31' }) // 缺 count
    invalidHostile({ request: { mode: 'bars', startDate: '2026-01-05', count: 0 }, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'bars', startDate: '2026-01-05', count: -3 }, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'bars', startDate: '2026-01-05', count: 2.5 }, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'bars', startDate: '2026-01-05', count: Number.NaN }, dates: JAN, today: '2026-01-31' })
    invalidHostile({ request: { mode: 'bars', startDate: '2026-01-05', count: '5' }, dates: JAN, today: '2026-01-31' })
    invalidHostile({
      request: { mode: 'bars', startDate: '2026-01-05', count: Number.MAX_SAFE_INTEGER + 1 },
      dates: JAN,
      today: '2026-01-31',
    })
  })

  it('knownClosedDates 含非法日期返回 INVALID_INPUT', () => {
    invalidHostile({
      request: { mode: 'preset', startDate: '2026-09-01', months: 1, endDate: '2026-09-23' },
      dates: SEP,
      today: '2026-09-23',
      knownClosedDates: ['2026-09-31'],
    })
  })
})
