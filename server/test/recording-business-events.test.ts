import { describe, expect, it } from 'vitest'
import { businessEvents, isBusinessAction } from '../../web/src/recording/businessEvents'
import type { Action, RecordingEvent, RecordingEventOutcome } from '../../web/src/recording/types'

// REC-02 业务口径：业务列表/计数只突出完成的买卖与图形/文字变更，一次操作计一次（started 去重）。
// cancelled/no-op 与 interrupted（暂停、续录补齐的悬挂操作）排除；明确的拒单/失败交易按“拒单标注”计入。
// 推进、工具/主题/视口/周期/图表加载/保存与生命周期元事件不是业务，但仍保留在时间轴数据里。

function makeEvent(overrides: Partial<RecordingEvent> & { seq: number }): RecordingEvent {
  return {
    opId: `op-${overrides.seq}`,
    segmentId: 'seg-1',
    elapsedMs: overrides.seq * 100,
    phase: 'finished',
    action: 'training.trade',
    source: 'ui',
    outcome: 'accepted',
    ...overrides,
  }
}

describe('isBusinessAction', () => {
  it('买卖与图形/文字创建、编辑、移动、删除、撤销、重做、清空属于业务', () => {
    const business: Action[] = [
      'training.trade',
      'chart.drawing.create',
      'chart.drawing.edit',
      'chart.drawing.move',
      'chart.drawing.delete',
      'chart.drawing.undo',
      'chart.drawing.redo',
      'chart.drawing.clear',
    ]
    for (const action of business) expect(isBusinessAction(action)).toBe(true)
  })

  it('推进、工具/主题/视口/周期/加载/保存、画线取消与生命周期动作不属于业务', () => {
    const notBusiness: Action[] = [
      'training.create',
      'training.advance',
      'training.settle',
      'training.abandon',
      'chart.load',
      'chart.timeframe',
      'chart.viewport',
      'chart.tool',
      'chart.drawing.cancel',
      'drawings.save',
      'ui.theme',
      'recording.pause',
      'recording.resume',
      'session.interrupted',
    ]
    for (const action of notBusiness) expect(isBusinessAction(action)).toBe(false)
  })
})

describe('businessEvents', () => {
  it('只保留完成的业务动作：started 去重、cancelled/interrupted 排除、推进不算业务', () => {
    const events: RecordingEvent[] = [
      makeEvent({ seq: 1, phase: 'started', action: 'training.trade' }),
      makeEvent({ seq: 2, action: 'training.trade', result: { plan: { filled: true } } }),
      makeEvent({ seq: 3, phase: 'started', action: 'chart.drawing.create' }),
      makeEvent({ seq: 4, action: 'chart.drawing.create' }),
      makeEvent({ seq: 5, action: 'chart.drawing.cancel' }),
      makeEvent({ seq: 6, outcome: 'cancelled', action: 'chart.drawing.move' }),
      makeEvent({ seq: 7, outcome: 'interrupted', action: 'chart.drawing.clear' }),
      makeEvent({ seq: 8, action: 'training.advance' }),
    ]
    expect(businessEvents(events).map(event => event.seq)).toEqual([2, 4])
  })

  it('明确的拒绝/失败/未知结局交易计入业务（拒单标注、结果未知不静默丢失）', () => {
    const outcomes: RecordingEventOutcome[] = ['accepted', 'rejected', 'failed', 'unknown']
    const events = outcomes.map((outcome, index) => makeEvent({ seq: index + 1, outcome }))
    expect(businessEvents(events)).toHaveLength(4)
  })

  it('旧文件兼容：创建样板、工具/主题/加载/保存、暂停恢复与推进不计入，图形与交易保留', () => {
    const events: RecordingEvent[] = [
      makeEvent({ seq: 1, action: 'training.create', phase: 'started' }),
      makeEvent({ seq: 2, action: 'training.create' }),
      makeEvent({ seq: 3, action: 'ui.theme' }),
      makeEvent({ seq: 4, action: 'chart.tool' }),
      makeEvent({ seq: 5, action: 'chart.load' }),
      makeEvent({ seq: 6, action: 'drawings.save' }),
      makeEvent({ seq: 7, action: 'recording.pause' }),
      makeEvent({ seq: 8, action: 'recording.resume' }),
      makeEvent({ seq: 9, action: 'training.advance' }),
      makeEvent({ seq: 10, action: 'training.settle' }),
      makeEvent({ seq: 11, action: 'chart.drawing.create' }),
      makeEvent({ seq: 12, phase: 'started', action: 'chart.drawing.move' }),
      makeEvent({ seq: 13, action: 'chart.drawing.move' }),
      makeEvent({ seq: 14, action: 'training.trade', outcome: 'rejected' }),
    ]
    expect(businessEvents(events).map(event => event.seq)).toEqual([11, 13, 14])
  })

  it('旧文件可能缺少 outcome：完成态业务动作仍计入', () => {
    expect(businessEvents([makeEvent({ seq: 1, outcome: undefined })])).toHaveLength(1)
    expect(businessEvents([makeEvent({ seq: 2, phase: 'started', outcome: undefined })])).toHaveLength(0)
  })

  it('空列表返回空结果，输入列表不被修改', () => {
    const events = [makeEvent({ seq: 1 }), makeEvent({ seq: 2, action: 'chart.load' })]
    const snapshot = [...events]
    expect(businessEvents(events)).toHaveLength(1)
    expect(events).toEqual(snapshot)
    expect(businessEvents([])).toEqual([])
  })
})
