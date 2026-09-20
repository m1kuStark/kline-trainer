import { open, readFile } from 'node:fs/promises'

export interface DayBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  amount: number
  volume: number
}

const RECORD_SIZE = 32

function formatDate(value: number): string {
  const year = Math.floor(value / 10000)
  const month = Math.floor((value % 10000) / 100)
  const day = value % 100
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 1990 || year > 2100 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`TDX .day record contains invalid date ${value}`)
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

export function isDayDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value
}

function validateDateInput(value: string, field: 'from' | 'to'): void {
  if (!isDayDate(value)) throw new Error(`${field} contains invalid date ${value}`)
}

export function parseDayBuffer(buffer: Uint8Array): DayBar[] {
  if (buffer.byteLength % RECORD_SIZE !== 0) {
    throw new Error(`TDX .day files must contain 32-byte records; got ${buffer.byteLength} bytes`)
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const bars: DayBar[] = []
  for (let offset = 0; offset < buffer.byteLength; offset += RECORD_SIZE) {
    bars.push({
      date: formatDate(view.getInt32(offset, true)),
      open: view.getInt32(offset + 4, true) / 100,
      high: view.getInt32(offset + 8, true) / 100,
      low: view.getInt32(offset + 12, true) / 100,
      close: view.getInt32(offset + 16, true) / 100,
      amount: view.getFloat32(offset + 20, true),
      volume: view.getInt32(offset + 24, true),
    })
  }
  return bars
}

export async function readDayFile(filePath: string): Promise<DayBar[]> {
  return parseDayBuffer(await readFile(filePath))
}

function lowerBound(bars: DayBar[], date: string): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (bars[middle].date < date) low = middle + 1
    else high = middle
  }
  return low
}

export async function readDayFileRange(filePath: string, from?: string, to?: string): Promise<DayBar[]> {
  if (from) validateDateInput(from, 'from')
  if (to) validateDateInput(to, 'to')
  if (from && to && from > to) throw new Error(`from date ${from} must not be after to date ${to}`)
  const bars = await readDayFile(filePath)
  const start = from ? lowerBound(bars, from) : 0
  const end = to ? lowerBound(bars, to) + (bars[lowerBound(bars, to)]?.date === to ? 1 : 0) : bars.length
  return bars.slice(start, end)
}

export async function readLastDayDate(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size === 0) return null
    if (info.size % RECORD_SIZE !== 0) throw new Error(`TDX .day files must contain 32-byte records; got ${info.size} bytes`)
    const buffer = Buffer.alloc(RECORD_SIZE)
    await handle.read(buffer, 0, RECORD_SIZE, info.size - RECORD_SIZE)
    return formatDate(buffer.readInt32LE(0))
  } finally {
    await handle.close()
  }
}
