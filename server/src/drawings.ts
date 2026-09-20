import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from './train/engine.js'

export const DRAWINGS_BODY_LIMIT = 256 * 1024

const DRAWING_NAMES = new Set([
  'brush', 'fibonacciLine', 'horizontalRayLine', 'horizontalSegment', 'horizontalStraightLine',
  'parallelStraightLine', 'priceChannelLine', 'priceLine', 'rayLine', 'segment', 'simpleAnnotation',
  'simpleTag', 'straightLine', 'verticalRayLine', 'verticalSegment', 'verticalStraightLine',
  'rectangle', 'circle', 'arc', 'arrowLine', 'bullArrow', 'bearArrow', 'percentageLine', 'curseLine', 'textAnnotation', 'polyline',
])
const DRAWING_FIELDS = new Set(['id', 'name', 'paneId', 'points', 'styles', 'extendData', 'groupId', 'lock', 'visible', 'priceBasis'])
const PANE_IDS = new Set(['candle_pane', 'VOL', 'MACD'])
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type DrawingJson = null | boolean | number | string | DrawingJson[] | { [key: string]: DrawingJson }

export interface Drawing {
  id: string
  name: string
  paneId?: 'candle_pane' | 'VOL' | 'MACD'
  points: Array<{ timestamp: number; value: number }>
  styles?: { [key: string]: DrawingJson } | null
  extendData?: DrawingJson
  groupId?: string
  lock?: boolean
  visible?: boolean
  /** 画线数值所属的前复权基准（显示价 = 原始价 * scale + offset）；旧画线缺省，存 JSON 不动表结构 */
  priceBasis?: { scale: number; offset: number }
}

export function readDrawings(database: DatabaseSync, trainingId: number): Drawing[] {
  requireTraining(database, trainingId)
  const row = database.prepare('SELECT payload FROM drawings WHERE training_id = ?').get(trainingId) as { payload: string } | undefined
  return row ? JSON.parse(row.payload) as Drawing[] : []
}

export function writeDrawings(database: DatabaseSync, trainingId: number, payload: unknown): Drawing[] {
  requireTraining(database, trainingId)
  const drawings = validateDrawings(payload)
  const serialized = JSON.stringify(drawings)
  if (Buffer.byteLength(serialized, 'utf8') > DRAWINGS_BODY_LIMIT) throw new HttpError(413, 'Drawings exceed 256 KiB')
  database.prepare(`
    INSERT INTO drawings (training_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(training_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(trainingId, serialized, new Date().toISOString())
  return drawings
}

function validateDrawings(payload: unknown): Drawing[] {
  if (!Array.isArray(payload) || payload.length > 500) invalid('drawings must be an array of at most 500 items')
  const ids = new Set<string>()
  for (const drawing of payload) {
    if (!isRecord(drawing)) invalid('each drawing must be an object')
    if (Object.keys(drawing).some(key => !DRAWING_FIELDS.has(key))) invalid('unsupported drawing field')
    if (!isIdentifier(drawing.id) || ids.has(drawing.id)) invalid('drawing ids must be unique nonempty strings of at most 128 characters')
    ids.add(drawing.id)
    if (typeof drawing.name !== 'string' || !DRAWING_NAMES.has(drawing.name)) invalid('unsupported drawing name')
    if (drawing.paneId !== undefined && (typeof drawing.paneId !== 'string' || !PANE_IDS.has(drawing.paneId))) invalid('paneId must be candle_pane, VOL or MACD')
    if (!Array.isArray(drawing.points) || drawing.points.length < 1 || drawing.points.length > 256) invalid('drawing points must contain 1 to 256 anchors')
    for (const point of drawing.points) {
      if (!isRecord(point) || Object.keys(point).some(key => key !== 'timestamp' && key !== 'value') ||
          typeof point.timestamp !== 'number' || !Number.isFinite(point.timestamp) ||
          typeof point.value !== 'number' || !Number.isFinite(point.value)) {
        invalid('drawing anchors require finite timestamp and value only')
      }
    }
    if (drawing.styles !== undefined && drawing.styles !== null && !isRecord(drawing.styles)) invalid('styles must be an object or null')
    for (const key of ['lock', 'visible']) {
      if (drawing[key] !== undefined && typeof drawing[key] !== 'boolean') invalid(`${key} must be boolean`)
    }
    if (drawing.groupId !== undefined && !isIdentifier(drawing.groupId)) invalid('invalid groupId')
    if (isRecord(drawing.extendData) && drawing.extendData.text !== undefined && typeof drawing.extendData.text !== 'string') invalid('annotation text must be a plain string')
    if (drawing.styles !== undefined) validateJson(drawing.styles)
    if (drawing.extendData !== undefined) validateJson(drawing.extendData)
    if (drawing.priceBasis !== undefined) {
      const basis = drawing.priceBasis as { [key: string]: DrawingJson } | undefined
      if (!isRecord(basis) || Object.keys(basis).length !== 2 ||
          typeof basis.scale !== 'number' || !Number.isFinite(basis.scale) || basis.scale <= 0 ||
          typeof basis.offset !== 'number' || !Number.isFinite(basis.offset)) {
        invalid('priceBasis must be an object with exactly positive finite scale and finite offset')
      }
    }
  }
  return payload as Drawing[]
}

// Bound recursive style/extension data while retaining the library's nested JSON shapes.
function validateJson(value: unknown, depth = 0): void {
  if (depth > 8) invalid('drawing data exceeds maximum nesting depth')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string' && value.length <= 8192) return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value) && value.length <= 1024) {
    for (const item of value) validateJson(item, depth + 1)
    return
  }
  if (isRecord(value) && Object.keys(value).length <= 128) {
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 128 || UNSAFE_KEYS.has(key)) invalid('invalid drawing data key')
      validateJson(item, depth + 1)
    }
    return
  }
  invalid('drawing data must be bounded JSON with finite numbers and strings of at most 8192 characters')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function invalid(message: string): never {
  throw new HttpError(400, message)
}

function requireTraining(database: DatabaseSync, trainingId: number): void {
  if (!Number.isSafeInteger(trainingId) || trainingId < 1) throw new HttpError(400, 'id must be a positive safe integer')
  if (!database.prepare('SELECT id FROM trainings WHERE id = ?').get(trainingId)) throw new HttpError(404, 'Training not found')
}
