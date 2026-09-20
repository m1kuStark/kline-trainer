import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { TdxMarket } from './stocks.js'

export interface StockName {
  code: string
  market: TdxMarket
  name: string
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('gb18030').decode(bytes).replace(/\0/g, '').trim()
}

function marketFromCode(code: string): TdxMarket {
  if (code.startsWith('6') || code.startsWith('68')) return 'sh'
  if (code.startsWith('8') || code.startsWith('4')) return 'bj'
  return 'sz'
}

function cleanName(value: string): string {
  return value.replace(/[\u0000\xff]+/g, '').trim()
}

export async function parseTnfFile(filePath: string, market: TdxMarket): Promise<StockName[]> {
  const bytes = await readFile(filePath)
  const results = new Map<string, StockName>()
  for (let offset = 0; offset <= bytes.length - 6; offset += 1) {
    if (offset > 0 && bytes[offset - 1] >= 0x30 && bytes[offset - 1] <= 0x39) continue
    const code = Buffer.from(bytes.subarray(offset, offset + 6)).toString('ascii')
    if (!/^\d{6}$/.test(code)) continue
    const next = bytes[offset + 6]
    if (next >= 0x30 && next <= 0x39) continue
    if (marketFromCode(code) !== market) continue
    const rawName = bytes.subarray(offset + 31, Math.min(bytes.length, offset + 63))
    const zero = rawName.indexOf(0)
    const name = cleanName(decodeText(zero >= 0 ? rawName.subarray(0, zero) : rawName)) || code
    if (!/[\u4e00-\u9fffA-Za-z]/.test(name)) continue
    results.set(code, { code, market, name })
    offset += 5
  }
  return [...results.values()]
}

interface DbfField { name: string; length: number; offset: number }

export async function parseBaseDbf(filePath: string): Promise<StockName[]> {
  const bytes = await readFile(filePath)
  if (bytes.length < 33) return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = view.getUint16(8, true)
  const recordLength = view.getUint16(10, true)
  const recordCount = view.getUint32(4, true)
  const fields: DbfField[] = []
  for (let offset = 32; offset + 32 <= headerLength - 1; offset += 32) {
    if (bytes[offset] === 0x0d) break
    const name = decodeText(bytes.subarray(offset, offset + 11)).replace(/\0/g, '')
    fields.push({ name, length: bytes[offset + 16], offset: 0 })
  }
  let cursor = 1
  for (const field of fields) { field.offset = cursor; cursor += field.length }
  const codeField = fields.find(field => /GPDM|CODE|证券代码/i.test(field.name))
  const nameField = fields.find(field => /GPMC|NAME|证券简称/i.test(field.name))
  if (!codeField || !nameField) return []
  const results: StockName[] = []
  for (let index = 0; index < recordCount; index += 1) {
    const start = headerLength + index * recordLength
    if (start + recordLength > bytes.length || bytes[start] === 0x2a) continue
    const code = decodeText(bytes.subarray(start + codeField.offset, start + codeField.offset + codeField.length)).replace(/\D/g, '').slice(-6)
    if (!/^\d{6}$/.test(code)) continue
    const name = decodeText(bytes.subarray(start + nameField.offset, start + nameField.offset + nameField.length)) || code
    results.push({ code, market: marketFromCode(code), name })
  }
  return results
}

export async function loadStockNames(tdxRoot: string, market: TdxMarket): Promise<StockName[]> {
  const file = join(tdxRoot, 'T0002', 'hq_cache', `${market}s.tnf`)
  try {
    const parsed = await parseTnfFile(file, market)
    if (parsed.length) return parsed
  } catch {
    // Fall through to the DBF fallback.
  }
  try {
    const fallback = await parseBaseDbf(join(tdxRoot, 'T0002', 'hq_cache', 'base.dbf'))
    return fallback.filter(item => item.market === market)
  } catch {
    return []
  }
}

export function codeFromDayFile(fileName: string): string | null {
  const match = basename(fileName).match(/(\d{6})\.day$/i)
  return match?.[1] ?? null
}
