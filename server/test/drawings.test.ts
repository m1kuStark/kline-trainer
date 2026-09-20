import Fastify from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { registerApi } from '../src/api.js'
import { migrateDatabase } from '../src/db.js'

async function openApp(databasePath = ':memory:') {
  const database = new DatabaseSync(databasePath)
  migrateDatabase(database)
  const app = Fastify()
  await registerApi(app, { host: '127.0.0.1', port: 0, databasePath, tdxRoot: null }, database)
  return { app, database, close: async () => { await app.close(); database.close() } }
}

function insertTraining(database: DatabaseSync, status = 'running'): number {
  return Number(database.prepare(`
    INSERT INTO trainings (tier, code, name, start_date, planned_end, status, initial_cash, created_at)
    VALUES ('1M', '600000', '600000', '2026-07-01', '2026-08-01', ?, 100000, '2026-07-01T00:00:00Z')
  `).run(status).lastInsertRowid)
}

const segment = {
  id: 'line-1', name: 'segment', paneId: 'candle_pane',
  points: [{ timestamp: 1782864000000, value: 10.25 }, { timestamp: 1782950400000, value: 11.5 }],
  styles: { line: { color: '#facc15', size: 1, style: 'dashed', dashedValue: [4, 4] } },
}

describe('training drawing persistence', () => {
  it('saves and restores both curse-line timestamp and value anchors in their original order', async () => {
    const { app, database, close } = await openApp()
    try {
      const url = `/api/trainings/${insertTraining(database)}/drawings`
      const curse = { ...segment, id: 'curse-1', name: 'curseLine',
        points: [{ timestamp: 1782950400000, value: 20 }, { timestamp: 1782864000000, value: 10 }],
      }
      const saved = await app.inject({ method: 'PUT', url, payload: [curse] })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toEqual({ drawings: [curse] })
      expect((await app.inject({ method: 'GET', url })).json()).toEqual({ drawings: [curse] })
    } finally {
      await close()
    }
  })

  it('rejects malformed or unsafe drawing payloads without overwriting the saved drawings', async () => {
    const { app, database, close } = await openApp()
    try {
      const id = insertTraining(database)
      const url = `/api/trainings/${id}/drawings`
      await app.inject({ method: 'PUT', url, payload: [segment] })
      const invalidPayloads: Array<[string, unknown]> = [
        ['wrapped array', { drawings: [segment] }], ['null', null], ['scalar', 'text'],
        ['null drawing', [null]], ['missing fields', [{}]],
        ['unknown name', [{ ...segment, name: 'unknown' }]],
        ['engine trade mark', [{ ...segment, name: 'bsMark' }]],
        ['engine cost line', [{ ...segment, name: 'costLine' }]],
        ['runtime pane id', [{ ...segment, paneId: 'indicator_pane_3' }]],
        ['blank id', [{ ...segment, id: '  ' }]],
        ['oversized id', [{ ...segment, id: 'x'.repeat(129) }]],
        ['duplicate id', [segment, segment]],
        ['missing points', [{ id: 'x', name: 'segment' }]],
        ['empty points', [{ ...segment, points: [] }]],
        ['null point', [{ ...segment, points: [null] }]],
        ['missing timestamp', [{ ...segment, points: [{ value: 10 }] }]],
        ['missing value', [{ ...segment, points: [{ timestamp: 1782864000000 }] }]],
        ['string timestamp', [{ ...segment, points: [{ timestamp: '1782864000000', value: 10 }] }]],
        ['null value', [{ ...segment, points: [{ timestamp: 1782864000000, value: null }] }]],
        ['dataIndex point', [{ ...segment, points: [{ timestamp: 1782864000000, value: 10, dataIndex: 3 }] }]],
        ['nonobject styles', [{ ...segment, styles: 'yellow' }]],
        ['nonboolean lock', [{ ...segment, lock: 'true' }]],
        ['nonboolean visible', [{ ...segment, visible: 1 }]],
        ['oversized text', [{ ...segment, extendData: { text: 'x'.repeat(8193) } }]],
        ['object text', [{ ...segment, name: 'textAnnotation', extendData: { text: { html: '<b>bad</b>' } } }]],
        ['dangerous key', [{ ...segment, styles: { constructor: { prototype: { polluted: true } } } }]],
        ['deep data', [{ ...segment, extendData: Array.from({ length: 10 }).reduce<unknown>(value => ({ next: value }), 1) }]],
        ['too many points', [{ ...segment, points: Array.from({ length: 257 }, () => segment.points[0]) }]],
        ['too many drawings', Array.from({ length: 501 }, (_, index) => ({ ...segment, id: `line-${index}` }))],
      ]
      for (const [label, payload] of invalidPayloads) {
        const response = await app.inject({ method: 'PUT', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
        expect(response.statusCode, label).toBe(400)
        expect(response.json().error, label).toEqual(expect.any(String))
        expect((await app.inject({ method: 'GET', url })).json(), label).toEqual({ drawings: [segment] })
      }
      for (const payload of ['[', '[{"id":"bad","name":"segment","points":[{"timestamp":1e400,"value":10}]}]']) {
        const response = await app.inject({ method: 'PUT', url, payload, headers: { 'content-type': 'application/json' } })
        expect(response.statusCode).toBe(400)
      }
      const supportedNames = [
        'brush', 'fibonacciLine', 'horizontalRayLine', 'horizontalSegment', 'horizontalStraightLine',
        'parallelStraightLine', 'priceChannelLine', 'priceLine', 'rayLine', 'segment', 'simpleAnnotation',
        'simpleTag', 'straightLine', 'verticalRayLine', 'verticalSegment', 'verticalStraightLine',
        'rectangle', 'circle', 'arc', 'arrowLine', 'bullArrow', 'bearArrow', 'percentageLine', 'curseLine', 'textAnnotation', 'polyline',
      ]
      const drawings = supportedNames.map(name => ({ ...segment, id: name, name, extendData: { text: 'plain text', ratios: [0, 0.5, 1] } }))
      expect((await app.inject({ method: 'PUT', url, payload: drawings })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url })).json()).toEqual({ drawings })
    } finally {
      await close()
    }
  })

  it('stores optional priceBasis metadata verbatim for basis-aware persistence', async () => {
    const { app, database, close } = await openApp()
    try {
      const url = `/api/trainings/${insertTraining(database)}/drawings`
      const based = { ...segment, priceBasis: { scale: 0.5, offset: -0.12 } }
      const saved = await app.inject({ method: 'PUT', url, payload: [based] })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toEqual({ drawings: [based] })
      expect((await app.inject({ method: 'GET', url })).json()).toEqual({ drawings: [based] })
    } finally {
      await close()
    }
  })

  it('rejects invalid priceBasis metadata without overwriting the saved drawings', async () => {
    const { app, database, close } = await openApp()
    try {
      const id = insertTraining(database)
      const url = `/api/trainings/${id}/drawings`
      const based = { ...segment, priceBasis: { scale: 0.5, offset: -0.12 } }
      await app.inject({ method: 'PUT', url, payload: [based] })
      const invalidBases: Array<[string, unknown]> = [
        ['null basis', null],
        ['string basis', 'identity'],
        ['array basis', [1, 0]],
        ['zero scale', { scale: 0, offset: 0 }],
        ['negative scale', { scale: -1, offset: 0 }],
        ['string scale', { scale: '1', offset: 0 }],
        ['missing offset', { scale: 1 }],
        ['missing scale', { offset: 0 }],
        ['extra key', { scale: 1, offset: 0, mode: 'forward' }],
        ['null offset', { scale: 1, offset: null }],
        ['infinite scale', { scale: Number.POSITIVE_INFINITY, offset: 0 }],
      ]
      for (const [label, priceBasis] of invalidBases) {
        const response = await app.inject({ method: 'PUT', url, payload: [{ ...segment, priceBasis }], headers: { 'content-type': 'application/json' } })
        expect(response.statusCode, label).toBe(400)
        expect(response.json().error, label).toEqual(expect.any(String))
        expect((await app.inject({ method: 'GET', url })).json(), label).toEqual({ drawings: [based] })
      }
    } finally {
      await close()
    }
  })

  it('enforces the 256 KiB wire limit without corrupting the previous save', async () => {
    const { app, database, close } = await openApp()
    try {
      const url = `/api/trainings/${insertTraining(database)}/drawings`
      await app.inject({ method: 'PUT', url, payload: [segment] })
      const oversized = await app.inject({ method: 'PUT', url, payload: ' '.repeat(256 * 1024 - 1) + '[]', headers: { 'content-type': 'application/json' } })
      expect(oversized.statusCode).toBe(413)
      expect((await app.inject({ method: 'GET', url })).json()).toEqual({ drawings: [segment] })
      const atLimit = await app.inject({ method: 'PUT', url, payload: ' '.repeat(256 * 1024 - 2) + '[]', headers: { 'content-type': 'application/json' } })
      expect(atLimit.statusCode).toBe(200)
      expect(atLimit.json()).toEqual({ drawings: [] })
    } finally {
      await close()
    }
  })

  it('rejects invalid identifiers and nonexistent trainings for both read and write', async () => {
    const { app, database, close } = await openApp()
    try {
      insertTraining(database)
      for (const method of ['GET', 'PUT'] as const) {
        for (const id of ['invalid', '1.5', '0', '-1', '9007199254740992']) {
          const response = await app.inject({ method, url: `/api/trainings/${id}/drawings`, ...(method === 'PUT' ? { payload: [] } : {}) })
          expect(response.statusCode, `${method} invalid id ${id}`).toBe(400)
          expect(response.json().error).toEqual(expect.any(String))
        }
        const missing = await app.inject({ method, url: '/api/trainings/9876/drawings', ...(method === 'PUT' ? { payload: [] } : {}) })
        expect(missing.statusCode, `${method} nonexistent training`).toBe(404)
      }
      expect(database.prepare('SELECT COUNT(*) AS count FROM drawings').get()).toEqual({ count: 0 })
    } finally {
      await close()
    }
  })

  it('replaces drawings independently by training and restores them after the database reopens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trainer-drawings-'))
    const path = join(directory, 'training.sqlite')
    let context = await openApp(path)
    try {
      const runningId = insertTraining(context.database)
      const settledId = insertTraining(context.database, 'settled')
      const url = `/api/trainings/${runningId}/drawings`
      const settledUrl = `/api/trainings/${settledId}/drawings`
      const empty = await context.app.inject({ method: 'GET', url })
      expect(empty.statusCode).toBe(200)
      expect(empty.json()).toEqual({ drawings: [] })

      const text = {
        id: 'note-1', name: 'textAnnotation', paneId: 'MACD',
        points: [{ timestamp: 1782864000000, value: -0.12 }],
        extendData: { text: '<b>plain text</b>\nSecond line', size: 14, bold: true, italic: false },
        lock: false, visible: true,
      }
      const saved = await context.app.inject({ method: 'PUT', url, payload: [segment, text] })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toEqual({ drawings: [segment, text] })
      expect((await context.app.inject({ method: 'GET', url: settledUrl })).json()).toEqual({ drawings: [] })
      const settledDrawings = [{ ...segment, id: 'volume-1', paneId: 'VOL' }]
      expect((await context.app.inject({ method: 'PUT', url: settledUrl, payload: settledDrawings })).statusCode).toBe(200)

      await context.close()
      context = await openApp(path)
      expect((await context.app.inject({ method: 'GET', url })).json()).toEqual({ drawings: [segment, text] })
      expect((await context.app.inject({ method: 'GET', url: settledUrl })).json()).toEqual({ drawings: settledDrawings })
      expect((await context.app.inject({ method: 'PUT', url, payload: [text] })).json()).toEqual({ drawings: [text] })
      expect((await context.app.inject({ method: 'GET', url })).json()).toEqual({ drawings: [text] })
      expect((await context.app.inject({ method: 'PUT', url, payload: [] })).json()).toEqual({ drawings: [] })
      expect((await context.app.inject({ method: 'GET', url })).json()).toEqual({ drawings: [] })
      expect(context.database.prepare('SELECT training_id, updated_at FROM drawings').all()).toEqual([
        { training_id: runningId, updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
        { training_id: settledId, updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      ])
      context.database.prepare('DELETE FROM trainings WHERE id = ?').run(settledId)
      expect(context.database.prepare('SELECT training_id FROM drawings WHERE training_id = ?').get(settledId)).toBeUndefined()
    } finally {
      await context.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
