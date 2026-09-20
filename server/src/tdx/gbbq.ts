import { readFile } from 'node:fs/promises'
import type { DayBar } from './dayfile.js'
import type { TdxMarket } from './stocks.js'

const RECORD_SIZE = 29
const ENCRYPTED_SIZE = 24

// Fixed 4,176-byte lookup table used by the TDX gbbq block cipher.
const KEY_BYTES = Buffer.from(
  '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',
  'base64',
)

export interface AdjustmentEvent {
  market: TdxMarket
  code: string
  date: string
  category: 1
  dividend: number
  rightsPrice: number
  bonusShares: number
  rightsShares: number
  m: number
  c: number
}

export interface AdjustmentSegment {
  from: string | null
  to: string | null
  a: number
  b: number
}

function keyUInt32(offset: number): number {
  return KEY_BYTES.readUInt32LE(offset)
}

function decryptBlock(block: Uint8Array): Buffer {
  if (block.byteLength !== 8) throw new Error('TDX gbbq encrypted blocks must contain 8 bytes')
  const encrypted = Buffer.from(block.buffer, block.byteOffset, block.byteLength)
  let number = (keyUInt32(0x44) ^ encrypted.readUInt32LE(0)) >>> 0
  let previous = encrypted.readUInt32LE(4)
  for (let round = 0x40; round > 3; round -= 4) {
    let mixed = keyUInt32(((number & 0xff0000) >>> 16) * 4 + 0x448)
    mixed = (mixed + keyUInt32((number >>> 24) * 4 + 0x48)) >>> 0
    mixed = (mixed ^ keyUInt32(((number & 0xff00) >>> 8) * 4 + 0x848)) >>> 0
    mixed = (mixed + keyUInt32((number & 0xff) * 4 + 0xc48)) >>> 0
    mixed = (mixed ^ keyUInt32(round)) >>> 0
    const current = number
    number = (previous ^ mixed) >>> 0
    previous = current
  }
  previous = (previous ^ keyUInt32(0)) >>> 0
  const clear = Buffer.allocUnsafe(8)
  clear.writeUInt32LE(previous, 0)
  clear.writeUInt32LE(number, 4)
  return clear
}

function formatGbbqDate(value: number): string | null {
  const text = value.toString().padStart(8, '0')
  if (!/^\d{8}$/.test(text)) return null
  const year = Number(text.slice(0, 4))
  const month = Number(text.slice(4, 6))
  const day = Number(text.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  const formatted = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  return parsed.toISOString().slice(0, 10) === formatted ? formatted : null
}

export function parseGbbqBuffer(buffer: Uint8Array): AdjustmentEvent[] {
  if (buffer.byteLength < 4) throw new Error('TDX gbbq file is missing its record count')
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const recordCount = bytes.readUInt32LE(0)
  if (bytes.byteLength !== 4 + recordCount * RECORD_SIZE) {
    throw new Error(`TDX gbbq record count ${recordCount} does not match ${bytes.byteLength} bytes`)
  }

  const marketByExchange: Partial<Record<number, TdxMarket>> = { 0: 'sz', 1: 'sh', 2: 'bj' }
  const events: AdjustmentEvent[] = []
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 4 + index * RECORD_SIZE
    const clear = Buffer.allocUnsafe(RECORD_SIZE)
    for (let encryptedOffset = 0; encryptedOffset < ENCRYPTED_SIZE; encryptedOffset += 8) {
      decryptBlock(bytes.subarray(offset + encryptedOffset, offset + encryptedOffset + 8)).copy(clear, encryptedOffset)
    }
    bytes.copy(clear, ENCRYPTED_SIZE, offset + ENCRYPTED_SIZE, offset + RECORD_SIZE)
    if (clear[12] !== 1) continue

    const market = marketByExchange[clear[0]]
    const code = clear.subarray(1, 8).toString('latin1').replace(/\0+$/, '')
    const date = formatGbbqDate(clear.readUInt32LE(8))
    if (!market || !/^\d{6}$/.test(code) || !date) continue
    const dividend = clear.readFloatLE(13)
    const rightsPrice = clear.readFloatLE(17)
    const bonusShares = clear.readFloatLE(21)
    const rightsShares = clear.readFloatLE(25)
    if (![dividend, rightsPrice, bonusShares, rightsShares].every(Number.isFinite)) continue
    const m = (10 + bonusShares + rightsShares) / 10
    const c = (dividend - rightsPrice * rightsShares) / 10
    if (m <= 0 || !Number.isFinite(c)) continue
    events.push({
      market, code, date, category: 1,
      dividend, rightsPrice, bonusShares, rightsShares, m, c,
    })
  }
  return events
}

export async function readGbbqFile(filePath: string): Promise<AdjustmentEvent[]> {
  return parseGbbqBuffer(await readFile(filePath))
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - 1)
  return value.toISOString().slice(0, 10)
}

export function buildForwardAdjustmentSegments(events: AdjustmentEvent[]): AdjustmentSegment[] {
  const ordered = [...events].sort((left, right) => right.date.localeCompare(left.date))
  const segments: AdjustmentSegment[] = []
  let upper: string | null = null
  let a = 1
  let b = 0
  for (const event of ordered) {
    segments.push({ from: event.date, to: upper, a, b })
    a /= event.m
    b -= a * event.c
    upper = previousDate(event.date)
  }
  segments.push({ from: null, to: upper, a, b })
  return segments
}

function segmentForDate(segments: AdjustmentSegment[], date: string): AdjustmentSegment {
  return segments.find(segment =>
    (segment.from === null || date >= segment.from) &&
    (segment.to === null || date <= segment.to),
  ) ?? { from: null, to: null, a: 1, b: 0 }
}

export function applyForwardAdjustment(bars: DayBar[], events: AdjustmentEvent[], baseDate = bars.at(-1)?.date): DayBar[] {
  const effectiveEvents = baseDate ? events.filter(event => event.date <= baseDate) : []
  if (!effectiveEvents.length) return bars.map(bar => ({ ...bar }))
  const segments = buildForwardAdjustmentSegments(effectiveEvents)
  return bars.map(bar => {
    const { a, b } = segmentForDate(segments, bar.date)
    return {
      ...bar,
      open: bar.open * a + b,
      high: bar.high * a + b,
      low: bar.low * a + b,
      close: bar.close * a + b,
    }
  })
}
