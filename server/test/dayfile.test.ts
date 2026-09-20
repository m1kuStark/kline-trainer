import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { parseDayBuffer, readDayFileRange, readLastDayDate } from '../src/tdx/dayfile.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function record(date: number, open: number, high: number, low: number, close: number, amount: number, volume: number) {
  const buffer = Buffer.alloc(32)
  buffer.writeInt32LE(date, 0)
  buffer.writeInt32LE(Math.round(open * 100), 4)
  buffer.writeInt32LE(Math.round(high * 100), 8)
  buffer.writeInt32LE(Math.round(low * 100), 12)
  buffer.writeInt32LE(Math.round(close * 100), 16)
  buffer.writeFloatLE(amount, 20)
  buffer.writeInt32LE(volume, 24)
  return buffer
}

describe('TDX .day parser', () => {
  it('treats an empty file as an empty series', () => {
    expect(parseDayBuffer(Buffer.alloc(0))).toEqual([])
  })

  it('parses the 32-byte little-endian record format', () => {
    const bars = parseDayBuffer(record(20260901, 10.01, 10.5, 9.8, 10.2, 123456.5, 9876))

    expect(bars).toEqual([
      {
        date: '2026-09-01',
        open: 10.01,
        high: 10.5,
        low: 9.8,
        close: 10.2,
        amount: 123456.5,
        volume: 9876,
      },
    ])
  })

  it('rejects files whose length is not divisible by 32', () => {
    expect(() => parseDayBuffer(Buffer.alloc(31))).toThrow(/32-byte records/)
  })

  it('rejects impossible calendar dates stored in a record', () => {
    expect(() => parseDayBuffer(record(20260230, 1, 2, 0.5, 1.5, 10, 100))).toThrow(/invalid date/i)
  })

  it('returns an inclusive date range without reading future records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kline-day-'))
    const file = join(dir, 'sh600519.day')
    await writeFile(file, Buffer.concat([
      record(20260901, 1, 2, 0.5, 1.5, 10, 100),
      record(20260902, 2, 3, 1.5, 2.5, 20, 200),
      record(20260903, 3, 4, 2.5, 3.5, 30, 300),
    ]))

    try {
      await expect(readDayFileRange(file, '2026-09-02', '2026-09-02')).resolves.toEqual([
        expect.objectContaining({ date: '2026-09-02', close: 2.5 }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid date-range inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kline-day-range-'))
    const file = join(dir, 'sh600519.day')
    await writeFile(file, record(20260901, 1, 2, 0.5, 1.5, 10, 100))

    try {
      await expect(readDayFileRange(file, '2026-02-30')).rejects.toThrow(/invalid date/i)
      await expect(readDayFileRange(file, '2026-09-02', '2026-09-01')).rejects.toThrow(/from.*to/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the date from the final record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kline-last-date-'))
    const file = join(dir, 'sh600519.day')
    await writeFile(file, Buffer.concat([
      record(20260901, 1, 2, 0.5, 1.5, 10, 100),
      record(20260903, 3, 4, 2.5, 3.5, 30, 300),
    ]))
    try {
      await expect(readLastDayDate(file)).resolves.toBe('2026-09-03')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
