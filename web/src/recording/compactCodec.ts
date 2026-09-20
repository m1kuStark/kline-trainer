// REC-01 v2紧凑存储合同：web/src/recording/compactCodec.ts
// 纯编解码（docs/engineering/recording-v2-contract.md「纯codec接口」节）。
// 不依赖 Node crypto/fs；输入结构校验由调用者/后续 validator 任务负责，本模块不重复限制。
import type { AccountView, Bar, Timeframe, TradeView, TrainingMeta } from '../api'
import type { Drawing } from '../drawingState'
import type { JsonValue, RecordingCheckpoint, RecordingFile } from './types'
import type {
  CompactCheckpoint,
  CompactRecordingFile,
  CompactResources,
  CompactValueEntry,
  DrawingBaseVersion,
  DrawingVersion,
  SeriesBaseVersion,
  SeriesVersion,
} from './compactTypes'

/** 同一基础链上最多允许的增量层数；再追加时改存新全量基础 */
const MAX_DELTA_CHAIN = 31
/** Reader/Builder 内部最多缓存的还原行情/画线版本数 */
const READER_CACHE_LIMIT = 8

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 规范化序列化：对象键排序、数组保序，用于内容相等比较与指纹 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** FNV-1a 32位指纹：仅作内存查找索引，命中后必须比较完整规范内容 */
function fingerprint(canonical: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${canonical.length}`
}

function applyDelta<T>(base: T[], upsert: T[], remove: string[], keyOf: (item: T) => string): T[] {
  const result = base.slice()
  const indexByKey = new Map<string, number>()
  result.forEach((item, i) => indexByKey.set(keyOf(item), i))
  for (const item of upsert) {
    const key = keyOf(item)
    const at = indexByKey.get(key)
    if (at === undefined) {
      indexByKey.set(key, result.length)
      result.push(item)
    } else {
      result[at] = item
    }
  }
  if (remove.length) {
    const drop = new Set(remove)
    return result.filter(item => !drop.has(keyOf(item)))
  }
  return result
}

function sameKeySequence<T>(items: T[], keys: string[], keyOf: (item: T) => string): boolean {
  if (items.length !== keys.length) return false
  for (let i = 0; i < items.length; i += 1) {
    if (keyOf(items[i]) !== keys[i]) return false
  }
  return true
}

/** 画线数组按 id 规范序重构造（v1 serializeDrawings 即按 id 排序）；非排序输入不适用增量 */
function sortedByDrawId(items: Drawing[]): Drawing[] {
  return items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 行情截止：currentDate 优先，非盲无 currentDate 用 startDate，盲态隐藏当前日或无训练为 null */
function deriveAsOf(checkpoint: RecordingCheckpoint): string | null {
  const training = checkpoint.training
  if (!training) return null
  if (training.training.currentDate !== null) return training.training.currentDate
  return training.training.blind ? null : training.training.startDate
}

interface KeyedState<T> {
  items: T[]
  index: Map<string, number>
}

function buildState<T>(items: T[], keyOf: (item: T) => string): KeyedState<T> {
  return { items, index: new Map(items.map((item, i) => [keyOf(item), i])) }
}

/** 沿基础链展开单个版本：命中缓存祖先继续重放，循环/缺失立即报错；Reader与Builder共用 */
function expandVersionChain<T extends { id: string; base: string | null }, R>(
  id: string,
  byId: Map<string, T>,
  label: string,
  cache: LruCache<R>,
  materializeBase: (version: T & { base: null }) => R,
  applyVersion: (items: R, version: T & { base: string }) => R,
): R {
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const chain: T[] = []
  const seen = new Set<string>()
  let current = byId.get(id)
  if (!current) throw new Error(`checkpoint引用的${label}版本 ${id} 不存在，文件可能损坏`)
  for (;;) {
    if (seen.has(current.id)) throw new Error(`${label}基础链存在循环引用：${current.id}`)
    seen.add(current.id)
    chain.push(current)
    if (current.base === null) break
    const next = byId.get(current.base)
    if (!next) throw new Error(`${label}版本 ${current.id} 引用的基础版本 ${current.base} 不存在，文件可能损坏`)
    current = next
  }
  chain.reverse()
  let start = 0
  let hit: R | undefined
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ancestor = cache.get(chain[i].id)
    if (ancestor !== undefined) {
      hit = ancestor
      start = i + 1
      break
    }
  }
  let items: R
  if (hit !== undefined) {
    items = hit
  } else {
    const root = chain[0] as T & { base: null }
    items = materializeBase(root)
    cache.set(root.id, items)
    start = 1
  }
  for (let i = start; i < chain.length; i += 1) {
    const version = chain[i]
    items =
      version.base === null
        ? materializeBase(version as T & { base: null })
        : applyVersion(items, version as T & { base: string })
    cache.set(version.id, items)
  }
  return items
}

interface ContentTable<T> {
  prefix: string
  entries: Array<CompactValueEntry<T>>
  ids: Set<string>
  nextId: number
  byId: Map<string, CompactValueEntry<T>>
  /** 指纹 → 资源id；只存引用不存规范化串，命中后临时规范化比较（防碰撞） */
  byFingerprint: Map<string, string[]>
}

/**
 * v1 → v2 紧凑编码器：capture 只向 resources 追加必要版本，
 * 不修改调用者传入对象（输入复制后持有）；恢复时从 checkpointCount 续计 firstCheckpoint，
 * 并按追加序重建内容索引（指纹→版本id），保证恢复后去重/复用与连续会话一致。
 */
export class CompactBuilder {
  private readonly resources: CompactResources

  private checkpointCount: number

  private readonly seriesIds = new Map<string, SeriesVersion>()

  private readonly seriesHeads = new Map<string, string>()

  private readonly seriesStates = new Map<string, KeyedState<Bar>>()

  private readonly seriesDeltaCounts = new Map<string, number>()

  /** 周期 → 指纹 → 版本id（历史内容复用查找；仅存id不存展开内容） */
  private readonly seriesFpIndex = new Map<string, Map<string, string[]>>()

  private readonly drawingsById = new Map<string, DrawingVersion>()

  private drawingsHead: string | null = null

  private drawingsState: KeyedState<Drawing> | null = null

  private drawingsDeltaCount = 0

  private readonly drawingsFpIndex = new Map<string, string[]>()

  /** 历史复用比对时的临时展开缓存（有界，不作为持久索引） */
  private readonly seriesReconstructCache = new LruCache<Bar[]>(READER_CACHE_LIMIT)

  private readonly drawingsReconstructCache = new LruCache<Drawing[]>(READER_CACHE_LIMIT)

  private nextSeriesId = 1

  private nextDrawingId = 1

  private readonly metaTable: ContentTable<TrainingMeta>

  private readonly accountTable: ContentTable<AccountView>

  private readonly tradeTable: ContentTable<TradeView>

  private readonly contextTable: ContentTable<JsonValue>

  constructor(resources?: CompactResources, checkpointCount = 0) {
    this.resources = resources
      ? clone(resources)
      : { series: [], drawings: [], trainingMeta: [], accounts: [], trades: [], contexts: [] }
    this.checkpointCount = checkpointCount
    for (const version of this.resources.series) this.indexRestoredSeries(version)
    for (const version of this.resources.drawings) {
      if (this.drawingsById.has(version.id)) throw new Error(`画线版本id重复：${version.id}`)
      this.drawingsById.set(version.id, version)
    }
    if (this.resources.drawings.length) {
      this.drawingsHead = this.resources.drawings[this.resources.drawings.length - 1].id
      this.drawingsDeltaCount = this.walkDeltaCount(this.drawingsHead, 'drawings')
    }
    for (const headId of this.seriesHeads.values()) this.seriesDepth(headId)
    for (const version of this.resources.series) {
      const numbered = version.id.match(/^s(\d+)$/)
      if (numbered) this.nextSeriesId = Math.max(this.nextSeriesId, Number(numbered[1]) + 1)
    }
    for (const version of this.resources.drawings) {
      const numbered = version.id.match(/^dw(\d+)$/)
      if (numbered) this.nextDrawingId = Math.max(this.nextDrawingId, Number(numbered[1]) + 1)
    }
    this.metaTable = this.restoreTable('m', this.resources.trainingMeta)
    this.accountTable = this.restoreTable('a', this.resources.accounts)
    this.tradeTable = this.restoreTable('t', this.resources.trades)
    this.contextTable = this.restoreTable('x', this.resources.contexts)
    this.rebuildContentIndexes()
  }

  private indexRestoredSeries(version: SeriesVersion): void {
    if (this.seriesIds.has(version.id)) throw new Error(`行情版本id重复：${version.id}`)
    this.seriesIds.set(version.id, version)
    this.seriesHeads.set(version.timeframe, version.id)
  }

  private restoreTable<T>(prefix: string, entries: Array<CompactValueEntry<T>>): ContentTable<T> {
    const table: ContentTable<T> = {
      prefix,
      entries,
      ids: new Set(),
      nextId: 1,
      byId: new Map(),
      byFingerprint: new Map(),
    }
    for (const entry of entries) {
      if (!entry.id || table.ids.has(entry.id)) throw new Error(`资源id为空或重复：${entry.id}`)
      table.ids.add(entry.id)
      table.byId.set(entry.id, entry)
      const fp = fingerprint(canonicalJson(entry.value))
      const bucket = table.byFingerprint.get(fp)
      if (bucket) bucket.push(entry.id)
      else table.byFingerprint.set(fp, [entry.id])
      const numbered = entry.id.match(/^([a-z]+)(\d+)$/)
      if (numbered && numbered[1] === prefix) table.nextId = Math.max(table.nextId, Number(numbered[2]) + 1)
    }
    return table
  }

  /** 计算某版本所在链的增量层数（带缓存） */
  private walkDeltaCount(leafId: string, kind: 'series' | 'drawings'): number {
    let count = 0
    const seen = new Set<string>()
    let current = leafId
    for (;;) {
      if (seen.has(current)) throw new Error(`${kind === 'series' ? '行情' : '画线'}基础链存在循环引用：${current}`)
      seen.add(current)
      const version = kind === 'series' ? this.seriesIds.get(current) : this.drawingsById.get(current)
      if (!version) throw new Error(`${kind === 'series' ? '行情' : '画线'}版本引用的基础版本不存在：${current}`)
      if (version.base === null) break
      count += 1
      current = version.base
    }
    return count
  }

  private seriesDepth(id: string): number {
    const known = this.seriesDeltaCounts.get(id)
    if (known !== undefined) return known
    const depth = this.walkDeltaCount(id, 'series')
    this.seriesDeltaCounts.set(id, depth)
    return depth
  }

  /** 恢复后按追加序滚动重建内容指纹索引：每版本规范化一次即弃，不保留展开历史 */
  private rebuildContentIndexes(): void {
    const rollingItems = new Map<string, Bar[]>()
    const rollingHead = new Map<string, string>()
    for (const version of this.resources.series) {
      let items: Bar[]
      const prevHead = rollingHead.get(version.timeframe)
      if (version.base === null) {
        items = version.bars.slice()
      } else if (prevHead === version.base) {
        items = applyDelta(rollingItems.get(version.timeframe) as Bar[], version.upsert, version.remove, bar => bar.date)
      } else {
        items = this.expandSeriesVersion(version.id)
      }
      this.pushSeriesFingerprint(version.timeframe, fingerprint(arrayCanonical(items)), version.id)
      rollingItems.set(version.timeframe, items)
      rollingHead.set(version.timeframe, version.id)
    }
    let prevDrawingsHead: string | null = null
    let drawingsItems: Drawing[] = []
    for (const version of this.resources.drawings) {
      if (version.base === null) {
        drawingsItems = version.items.slice()
      } else if (prevDrawingsHead === version.base) {
        drawingsItems = sortedByDrawId(
          applyDelta(drawingsItems, version.upsert, version.remove, drawing => drawing.id),
        )
      } else {
        drawingsItems = this.expandDrawingsVersion(version.id)
      }
      this.pushDrawingsFingerprint(fingerprint(arrayCanonical(drawingsItems)), version.id)
      prevDrawingsHead = version.id
    }
  }

  capture(checkpoint: RecordingCheckpoint): CompactCheckpoint {
    const index = this.checkpointCount
    this.checkpointCount += 1
    const training = checkpoint.training
      ? {
          metaRef: this.intern(this.metaTable, clone(checkpoint.training.training)),
          accountRef: this.intern(this.accountTable, clone(checkpoint.training.account)),
          tradeRefs: checkpoint.training.trades.map(trade => this.intern(this.tradeTable, clone(trade))),
        }
      : null
    const chart = checkpoint.chart
      ? {
          timeframe: checkpoint.chart.timeframe,
          seriesRef: this.internSeries(checkpoint.chart.timeframe, clone(checkpoint.chart.bars), deriveAsOf(checkpoint), index),
          drawingsRef: this.internDrawings(clone(checkpoint.chart.drawings)),
          view: { ...checkpoint.chart.view, paneHeights: { ...checkpoint.chart.view.paneHeights } },
          costPrice: checkpoint.chart.costPrice,
        }
      : null
    const contextRef = checkpoint.context === null ? null : this.intern(this.contextTable, clone(checkpoint.context))
    return {
      id: checkpoint.id,
      afterSeq: checkpoint.afterSeq,
      segmentId: checkpoint.segmentId,
      capturedAt: checkpoint.capturedAt,
      ui: { ...checkpoint.ui },
      training,
      chart,
      contextRef,
    }
  }

  /** 只读视图：调用方不得修改（存储任务按追加条目增量读取） */
  getResources(): CompactResources {
    return this.resources
  }

  // ---- 内容去重表：指纹只是索引（只存id），命中后临时规范化比较完整内容 ----

  private intern<T>(table: ContentTable<T>, value: T): string {
    const canonical = canonicalJson(value)
    const bucket = table.byFingerprint.get(fingerprint(canonical))
    if (bucket) {
      for (const id of bucket) {
        const entry = table.byId.get(id)
        if (entry && canonicalJson(entry.value) === canonical) return id
      }
    }
    let id = `${table.prefix}${table.nextId}`
    while (table.ids.has(id)) {
      table.nextId += 1
      id = `${table.prefix}${table.nextId}`
    }
    table.nextId += 1
    table.ids.add(id)
    table.entries.push({ id, value })
    table.byId.set(id, table.entries[table.entries.length - 1])
    const updated = bucket ?? []
    updated.push(id)
    table.byFingerprint.set(fingerprint(canonical), updated)
    return id
  }

  // ---- series：同周期线性链，31层增量上限，历史同内容复用，空增量用于标注新asOf ----

  private internSeries(timeframe: Timeframe, bars: Bar[], asOf: string | null, index: number): string {
    const headId = this.seriesHeads.get(timeframe)
    const incomingCanon = bars.map(bar => canonicalJson(bar))
    const fullCanon = arrayCanonicalFrom(incomingCanon)
    const fp = fingerprint(fullCanon)
    if (headId === undefined) return this.appendSeriesBase(timeframe, bars, asOf, index, fp)
    const head = this.seriesIds.get(headId) as SeriesVersion
    const state = this.seriesState(timeframe, headId)
    const keys = bars.map(bar => bar.date)
    const upsert: Bar[] = []
    const upsertCanon: string[] = []
    for (const [i, bar] of bars.entries()) {
      const at = state.index.get(bar.date)
      if (at === undefined || canonicalJson(state.items[at]) !== incomingCanon[i]) {
        upsert.push(bar)
        upsertCanon.push(incomingCanon[i])
      }
    }
    const keySet = new Set(keys)
    const remove: string[] = []
    for (const key of state.index.keys()) {
      if (!keySet.has(key)) remove.push(key)
    }
    const predicted = applyDelta(state.items, upsert, remove, bar => bar.date)
    const orderMatches = sameKeySequence(predicted, keys, bar => bar.date)
    const identical = upsert.length === 0 && remove.length === 0 && orderMatches
    if (identical) {
      if (asOf === null) return headId
      if (head.asOf !== null && head.asOf <= asOf) return headId
      // 链头asOf不可被本次引用：先找历史同内容且asOf许可的版本
      const reused = this.findSeriesReuse(timeframe, fp, fullCanon, asOf, headId)
      if (reused !== null) return reused
      // 从未知截止切到已知：生成带已知截止的新版本，不降格共享；超链深改存新基础
      if (head.asOf === null && this.seriesDepth(headId) < MAX_DELTA_CHAIN) {
        return this.appendSeriesDelta(timeframe, headId, [], [], asOf, index, fp)
      }
      return this.appendSeriesBase(timeframe, bars, asOf, index, fp)
    }
    const reused = this.findSeriesReuse(timeframe, fp, fullCanon, asOf, headId)
    if (reused !== null) return reused
    const baseAsOfBlocksDelta = asOf !== null && head.asOf !== null && head.asOf > asOf
    // 变化大于全量按序列化字节比较：upsert规范化字节+remove键 vs 新全量规范化字节
    const deltaBytes =
      upsertCanon.reduce((n, canon) => n + canon.length + 1, 0) +
      remove.reduce((n, key) => n + JSON.stringify(key).length + 1, 0)
    const deltaViable =
      orderMatches &&
      deltaBytes < fullCanon.length &&
      this.seriesDepth(headId) < MAX_DELTA_CHAIN &&
      !baseAsOfBlocksDelta
    if (deltaViable) return this.appendSeriesDelta(timeframe, headId, upsert, remove, asOf, index, fp)
    return this.appendSeriesBase(timeframe, bars, asOf, index, fp)
  }

  /** 历史同内容版本复用：指纹桶新→旧探测，asOf许可 + 临时展开规范化比对（防碰撞） */
  private findSeriesReuse(
    timeframe: Timeframe,
    fp: string,
    fullCanon: string,
    asOf: string | null,
    excludeId: string,
  ): string | null {
    const bucket = this.seriesFpIndex.get(timeframe)?.get(fp)
    if (!bucket) return null
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const id = bucket[i]
      if (id === excludeId) continue
      const version = this.seriesIds.get(id) as SeriesVersion
      if (asOf !== null && (version.asOf === null || version.asOf > asOf)) continue
      const items = this.expandSeriesVersion(id)
      if (arrayCanonical(items) === fullCanon) return id
    }
    return null
  }

  private expandSeriesVersion(id: string): Bar[] {
    return expandVersionChain(
      id,
      this.seriesIds,
      '行情',
      this.seriesReconstructCache,
      version => version.bars.slice(),
      (items, version) => applyDelta(items, version.upsert, version.remove, bar => bar.date),
    )
  }

  private expandDrawingsVersion(id: string): Drawing[] {
    return expandVersionChain(
      id,
      this.drawingsById,
      '画线',
      this.drawingsReconstructCache,
      version => version.items.slice(),
      (items, version) => sortedByDrawId(applyDelta(items, version.upsert, version.remove, drawing => drawing.id)),
    )
  }

  private pushSeriesFingerprint(timeframe: Timeframe, fp: string, id: string): void {
    let byFp = this.seriesFpIndex.get(timeframe)
    if (!byFp) {
      byFp = new Map()
      this.seriesFpIndex.set(timeframe, byFp)
    }
    const bucket = byFp.get(fp)
    if (bucket) bucket.push(id)
    else byFp.set(fp, [id])
  }

  private pushDrawingsFingerprint(fp: string, id: string): void {
    const bucket = this.drawingsFpIndex.get(fp)
    if (bucket) bucket.push(id)
    else this.drawingsFpIndex.set(fp, [id])
  }

  private seriesState(timeframe: string, headId: string): KeyedState<Bar> {
    const existing = this.seriesStates.get(timeframe)
    if (existing) return existing
    const items = this.expandSeriesVersion(headId)
    const state = buildState(items, bar => bar.date)
    this.seriesStates.set(timeframe, state)
    return state
  }

  private appendSeriesBase(timeframe: Timeframe, bars: Bar[], asOf: string | null, index: number, contentFp: string): string {
    const id = `s${this.nextSeriesId}`
    this.nextSeriesId += 1
    const version: SeriesVersion = { id, timeframe, asOf, firstCheckpoint: index, base: null, bars }
    this.resources.series.push(version)
    this.seriesIds.set(id, version)
    this.seriesHeads.set(timeframe, id)
    this.seriesStates.set(timeframe, buildState(bars.slice(), bar => bar.date))
    this.seriesDeltaCounts.set(id, 0)
    this.pushSeriesFingerprint(timeframe, contentFp, id)
    return id
  }

  private appendSeriesDelta(
    timeframe: Timeframe,
    headId: string,
    upsert: Bar[],
    remove: string[],
    asOf: string | null,
    index: number,
    contentFp: string,
  ): string {
    const id = `s${this.nextSeriesId}`
    this.nextSeriesId += 1
    const version: SeriesVersion = { id, timeframe, asOf, firstCheckpoint: index, base: headId, upsert, remove }
    this.resources.series.push(version)
    this.seriesIds.set(id, version)
    this.seriesHeads.set(timeframe, id)
    const state = this.seriesState(timeframe, headId)
    const items = applyDelta(state.items, upsert, remove, bar => bar.date)
    this.seriesStates.set(timeframe, buildState(items, bar => bar.date))
    this.seriesDeltaCounts.set(id, this.seriesDepth(headId) + 1)
    this.pushSeriesFingerprint(timeframe, contentFp, id)
    return id
  }

  // ---- drawings：单链，按id增量；重构造按id规范序，工具/窗格/点/样式/文字原值保留 ----

  /** 恢复会话后惰性重建头部展开态：base原样、delta按id规范序 */
  private ensureDrawingsState(): KeyedState<Drawing> | null {
    if (this.drawingsState) return this.drawingsState
    if (this.drawingsHead === null) return null
    this.drawingsState = buildState(this.expandDrawingsVersion(this.drawingsHead), drawing => drawing.id)
    return this.drawingsState
  }

  private internDrawings(items: Drawing[]): string {
    const incomingCanon = items.map(drawing => canonicalJson(drawing))
    const fullCanon = arrayCanonicalFrom(incomingCanon)
    const fp = fingerprint(fullCanon)
    const state = this.ensureDrawingsState()
    if (!state || this.drawingsHead === null) return this.appendDrawingsBase(items, fp)
    const keys = items.map(drawing => drawing.id)
    const upsert: Drawing[] = []
    const upsertCanon: string[] = []
    for (const [i, drawing] of items.entries()) {
      const at = state.index.get(drawing.id)
      if (at === undefined || canonicalJson(state.items[at]) !== incomingCanon[i]) {
        upsert.push(drawing)
        upsertCanon.push(incomingCanon[i])
      }
    }
    const keySet = new Set(keys)
    const remove: string[] = []
    for (const key of state.index.keys()) {
      if (!keySet.has(key)) remove.push(key)
    }
    const predicted = sortedByDrawId(applyDelta(state.items, upsert, remove, drawing => drawing.id))
    const orderMatches = sameKeySequence(predicted, keys, drawing => drawing.id)
    const identical = upsert.length === 0 && remove.length === 0 && orderMatches
    if (identical) return this.drawingsHead
    const reused = this.findDrawingsReuse(fp, fullCanon)
    if (reused !== null) return reused
    const deltaBytes =
      upsertCanon.reduce((n, canon) => n + canon.length + 1, 0) +
      remove.reduce((n, key) => n + JSON.stringify(key).length + 1, 0)
    const deltaViable = orderMatches && deltaBytes < fullCanon.length && this.drawingsDeltaCount < MAX_DELTA_CHAIN
    const id = `dw${this.nextDrawingId}`
    this.nextDrawingId += 1
    const version: DrawingVersion = deltaViable
      ? { id, base: this.drawingsHead, upsert, remove }
      : { id, base: null, items }
    this.resources.drawings.push(version)
    this.drawingsById.set(id, version)
    this.drawingsHead = id
    this.pushDrawingsFingerprint(fp, id)
    this.drawingsState = buildState(deltaViable ? predicted : items.slice(), drawing => drawing.id)
    this.drawingsDeltaCount = deltaViable ? this.drawingsDeltaCount + 1 : 0
    return id
  }

  private findDrawingsReuse(fp: string, fullCanon: string): string | null {
    const bucket = this.drawingsFpIndex.get(fp)
    if (!bucket) return null
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const id = bucket[i]
      if (id === this.drawingsHead) continue
      const items = this.expandDrawingsVersion(id)
      if (arrayCanonical(items) === fullCanon) return id
    }
    return null
  }

  private appendDrawingsBase(items: Drawing[], contentFp: string): string {
    const id = `dw${this.nextDrawingId}`
    this.nextDrawingId += 1
    const version: DrawingVersion = { id, base: null, items }
    this.resources.drawings.push(version)
    this.drawingsById.set(id, version)
    this.drawingsHead = id
    this.drawingsState = buildState(items.slice(), drawing => drawing.id)
    this.drawingsDeltaCount = 0
    this.pushDrawingsFingerprint(contentFp, id)
    return id
  }
}

/** 数组规范化：包住逐项规范化串（顺序保真） */
function arrayCanonical<T>(items: T[]): string {
  return `[${items.map(item => canonicalJson(item)).join(',')}]`
}

function arrayCanonicalFrom(canonicalItems: string[]): string {
  return `[${canonicalItems.join(',')}]`
}

/** v1 → v2 兼容迁移：保留全部事件/检查点/缺口，假定输入已通过v1结构检查 */
export function compactRecording(file: RecordingFile): CompactRecordingFile {
  const builder = new CompactBuilder()
  const checkpoints = file.checkpoints.map(checkpoint => builder.capture(checkpoint))
  return {
    format: file.format,
    schemaVersion: 2,
    sessionId: file.sessionId,
    createdAt: file.createdAt,
    app: { ...file.app },
    environment: { ...file.environment, viewport: { ...file.environment.viewport } },
    trainingKey: file.trainingKey,
    events: [...file.events],
    checkpoints,
    gaps: file.gaps.map(gap => ({ ...gap })),
    complete: file.complete,
    resources: builder.getResources(),
  }
}

/** 简单LRU：命中刷新位置，超限淘汰最旧 */
class LruCache<V> {
  private readonly map = new Map<string, V>()

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }
}

/** 按需解码单个检查点：只展开目标引用，输出深拷贝，不把内部缓存交给调用者 */
export class CompactReader {
  private readonly file: CompactRecordingFile

  private readonly seriesById = new Map<string, SeriesVersion>()

  private readonly drawingsById = new Map<string, DrawingVersion>()

  private readonly metaById = new Map<string, TrainingMeta>()

  private readonly accountById = new Map<string, AccountView>()

  private readonly tradeById = new Map<string, TradeView>()

  private readonly contextById = new Map<string, JsonValue>()

  private readonly seriesCache = new LruCache<Bar[]>(READER_CACHE_LIMIT)

  private readonly drawingsCache = new LruCache<Drawing[]>(READER_CACHE_LIMIT)

  constructor(file: CompactRecordingFile) {
    this.file = file
    for (const version of file.resources.series) {
      if (this.seriesById.has(version.id)) throw new Error(`行情版本id重复：${version.id}`)
      this.seriesById.set(version.id, version)
    }
    for (const version of file.resources.drawings) {
      if (this.drawingsById.has(version.id)) throw new Error(`画线版本id重复：${version.id}`)
      this.drawingsById.set(version.id, version)
    }
    for (const entry of file.resources.trainingMeta) this.metaById.set(entry.id, entry.value)
    for (const entry of file.resources.accounts) this.accountById.set(entry.id, entry.value)
    for (const entry of file.resources.trades) this.tradeById.set(entry.id, entry.value)
    for (const entry of file.resources.contexts) this.contextById.set(entry.id, entry.value)
  }

  checkpointAt(index: number): RecordingCheckpoint {
    const checkpoints = this.file.checkpoints
    if (!Number.isInteger(index) || index < 0 || index >= checkpoints.length) {
      throw new Error(`检查点下标 ${index} 越界：有效范围 0..${checkpoints.length - 1}（共 ${checkpoints.length} 个检查点）`)
    }
    const compact = checkpoints[index]
    const training = compact.training
      ? {
          training: clone(this.required(this.metaById, compact.training.metaRef, '训练元数据')),
          account: clone(this.required(this.accountById, compact.training.accountRef, '账户视图')),
          trades: compact.training.tradeRefs.map(id => clone(this.required(this.tradeById, id, '成交视图'))),
        }
      : null
    const chart = compact.chart
      ? {
          timeframe: compact.chart.timeframe,
          bars: clone(this.expandSeries(compact.chart.seriesRef)),
          drawings: clone(this.expandDrawings(compact.chart.drawingsRef)),
          view: { ...compact.chart.view, paneHeights: { ...compact.chart.view.paneHeights } },
          costPrice: compact.chart.costPrice,
        }
      : null
    const context = compact.contextRef === null ? null : clone(this.required(this.contextById, compact.contextRef, '训练context'))
    return {
      id: compact.id,
      afterSeq: compact.afterSeq,
      segmentId: compact.segmentId,
      capturedAt: compact.capturedAt,
      ui: { ...compact.ui },
      training,
      chart,
      context,
    }
  }

  private required<T>(map: Map<string, T>, id: string, label: string): T {
    const value = map.get(id)
    if (value === undefined) throw new Error(`${label}引用的资源 ${id} 不存在，文件可能损坏`)
    return value
  }

  private expandSeries(id: string): Bar[] {
    return expandVersionChain(
      id,
      this.seriesById,
      '行情',
      this.seriesCache,
      version => version.bars.slice(),
      (items, version) => applyDelta(items, version.upsert, version.remove, bar => bar.date),
    )
  }

  private expandDrawings(id: string): Drawing[] {
    return expandVersionChain(
      id,
      this.drawingsById,
      '画线',
      this.drawingsCache,
      version => version.items.slice(),
      (items, version) => sortedByDrawId(applyDelta(items, version.upsert, version.remove, drawing => drawing.id)),
    )
  }
}
