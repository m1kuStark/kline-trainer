import { describe, expect, it } from 'vitest'
import { DrawingOutbox } from '../../web/src/drawingOutbox'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

const line = {
  id: 'line-1', name: 'segment', paneId: 'candle_pane',
  points: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 12 }],
  styles: { line: { color: '#facc15', dashedValue: [4, 4] } },
}

describe('drawing recovery outbox', () => {
  it('persists synchronous snapshots across new instances with independent training keys and no aliases', () => {
    const storage = memoryStorage()
    const first = new DrawingOutbox(storage, 'training-1')
    expect(first.read()).toBeNull()
    const drawings = structuredClone([line])
    first.write(drawings)
    drawings[0].points[0].value = 999
    const reopened = new DrawingOutbox(storage, 'training-1')
    expect(reopened.read()).toEqual([line])
    const restored = reopened.read()!
    restored[0].points[0].value = -100
    expect(reopened.read()).toEqual([line])
    expect(new DrawingOutbox(storage, 'training-2').read()).toBeNull()
    first.write([])
    expect(reopened.read()).toEqual([])
  })

  it('keeps a newer snapshot when an older save finishes and clears only the acknowledged snapshot', () => {
    const storage = memoryStorage()
    const outbox = new DrawingOutbox(storage, 'training-1')
    const newer = [{ ...line, id: 'line-2' }]
    outbox.write([line])
    outbox.write(newer)
    outbox.acknowledge([line])
    expect(outbox.read()).toEqual(newer)
    outbox.acknowledge(structuredClone(newer))
    expect(outbox.read()).toBeNull()
    outbox.acknowledge(newer)
    expect(outbox.read()).toBeNull()
    outbox.write([])
    outbox.acknowledge(newer)
    expect(outbox.read()).toEqual([])
    outbox.acknowledge([])
    expect(outbox.read()).toBeNull()
  })

  it('reports malformed recovery data without discarding it', () => {
    const storage = memoryStorage()
    const outbox = new DrawingOutbox(storage, 'training-1')
    for (const raw of ['[', 'null', '{}', '[null]', '[{}]', JSON.stringify([{ ...line, points: [{ timestamp: '1000', value: 10 }] }])]) {
      storage.setItem('training-1', raw)
      expect(() => outbox.read()).toThrow(/drawing.*recovery|recovery.*drawing/i)
      expect(storage.getItem('training-1')).toBe(raw)
    }
  })

  it('surfaces storage read, quota and deletion failures so the caller can retain unsaved state', () => {
    const failure = new Error('storage unavailable')
    const storage = memoryStorage()
    const badRead = new DrawingOutbox({ ...storage, getItem: () => { throw failure } }, 'training-1')
    expect(() => badRead.read()).toThrow(failure)
    expect(() => badRead.acknowledge([line])).toThrow(failure)
    const badWrite = new DrawingOutbox({ ...storage, setItem: () => { throw failure } }, 'training-1')
    expect(() => badWrite.write([line])).toThrow(failure)
    const badDelete = new DrawingOutbox({ ...storage, removeItem: () => { throw failure } }, 'training-1')
    badDelete.write([line])
    expect(() => badDelete.acknowledge([line])).toThrow(failure)
    expect(badDelete.read()).toEqual([line])
  })
})
