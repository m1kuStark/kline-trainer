import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { registerApi } from '../src/api.js'
import { migrateDatabase } from '../src/db.js'

const segment = {
  id: 'legacy-line', name: 'segment', paneId: 'candle_pane',
  points: [{ timestamp: 1782864000000, value: 10.25 }, { timestamp: 1782950400000, value: 11.5 }],
}
const note = {
  id: 'legacy-note', name: 'textAnnotation', paneId: 'MACD',
  points: [{ timestamp: 1782864000000, value: -0.12 }],
  extendData: { text: 'Saved before settlement' },
}

describe('legacy drawing schema migration', () => {
  it('preserves legacy payloads across repeated migration and enables drawing API writes', async () => {
    const database = new DatabaseSync(':memory:')
    const app = Fastify()
    try {
      database.exec(`
        CREATE TABLE trainings (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tier TEXT NOT NULL, code TEXT NOT NULL,
          name TEXT NOT NULL, start_date TEXT NOT NULL, planned_end TEXT NOT NULL,
          status TEXT NOT NULL, blind INTEGER NOT NULL DEFAULT 0,
          adjust_mode TEXT NOT NULL DEFAULT 'forward', initial_cash REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE drawings (
          training_id INTEGER PRIMARY KEY, payload TEXT NOT NULL
        );
      `)
      const insertTraining = database.prepare(`
        INSERT INTO trainings (id, tier, code, name, start_date, planned_end, status, initial_cash, created_at)
        VALUES (?, '1M', '600000', '600000', '2026-07-01', '2026-08-01', ?, 100000, '2026-07-01T00:00:00Z')
      `)
      insertTraining.run(11, 'running')
      insertTraining.run(21, 'settled')
      insertTraining.run(31, 'running')
      const legacyRows = [
        { training_id: 11, payload: JSON.stringify([segment], null, 2) },
        { training_id: 21, payload: JSON.stringify([note], null, 2) },
      ]
      for (const row of legacyRows) {
        database.prepare('INSERT INTO drawings (training_id, payload) VALUES (?, ?)').run(row.training_id, row.payload)
      }
      await registerApi(app, { host: '127.0.0.1', port: 0, databasePath: ':memory:', tdxRoot: null }, database)
      const replacement = [{ ...segment, id: 'edited-line' }]
      const failedSave = await app.inject({ method: 'PUT', url: '/api/trainings/11/drawings', payload: replacement })
      expect(failedSave.statusCode).toBe(500)
      expect(database.prepare('SELECT training_id, payload FROM drawings ORDER BY training_id').all()).toEqual(legacyRows)

      for (let run = 0; run < 2; run++) {
        migrateDatabase(database)
        expect(database.prepare('SELECT training_id, payload FROM drawings ORDER BY training_id').all()).toEqual(legacyRows)
      }
      for (const [id, drawings] of [[11, [segment]], [21, [note]], [31, []]] as const) {
        const response = await app.inject({ method: 'GET', url: `/api/trainings/${id}/drawings` })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.json()).toEqual({ drawings })
      }
      for (const id of [11, 21, 31]) {
        const url = `/api/trainings/${id}/drawings`
        const saved = await app.inject({ method: 'PUT', url, payload: replacement })
        expect(saved.statusCode, saved.body).toBe(200)
        expect(saved.json()).toEqual({ drawings: replacement })
        expect((await app.inject({ method: 'GET', url })).json()).toEqual({ drawings: replacement })
      }

      const savedRows = database.prepare('SELECT * FROM drawings ORDER BY training_id').all()
      expect(savedRows).toEqual([11, 21, 31].map(training_id => ({
        training_id, payload: JSON.stringify(replacement),
        updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      })))
      migrateDatabase(database)
      expect(database.prepare('SELECT * FROM drawings ORDER BY training_id').all()).toEqual(savedRows)
      expect(database.prepare('SELECT status FROM trainings WHERE id = 21').get()).toEqual({ status: 'settled' })
    } finally {
      await app.close()
      database.close()
    }
  })
})
