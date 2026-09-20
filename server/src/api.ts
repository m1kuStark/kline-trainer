import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readDayFileRange, readLastDayDate, isDayDate } from './tdx/dayfile.js'
import { aggregateBars, type Timeframe } from './tdx/kline.js'
import type { AppConfig } from './config.js'
import { refreshStockCatalog } from './tdx/catalog.js'
import { loadAdjustmentEvents, refreshAdjustmentCache } from './tdx/adjustment-cache.js'
import { applyForwardAdjustment } from './tdx/gbbq.js'
import { parseTdxSymbol } from './tdx/symbol.js'
import { getActiveTraining } from './train/engine.js'
import { DRAWINGS_BODY_LIMIT, readDrawings, writeDrawings } from './drawings.js'
import { createDataRefreshCoordinator } from './data/refresh.js'
import { registerRecordingContextRoutes } from './recording-context.js'
import {
  HttpError, TIERS, abandonTraining, advanceTraining, buildChartSpace, createTraining,
  equityCurveOf, settleTraining, tradeTraining, trainingBars, trainingBarsBefore, trainingSnapshot, TRAINING_LOAD_BARS,
} from './train/engine.js'
import { drawingPriceBasis } from './train/drawing-price-basis.js'

export async function registerApi(app: FastifyInstance, config: AppConfig, database: DatabaseSync): Promise<void> {
  await registerRecordingContextRoutes(app, config, database)
  let stockCache: Awaited<ReturnType<typeof refreshStockCatalog>>['stocks'] | null = null
  let stockRefresh: Promise<Awaited<ReturnType<typeof refreshStockCatalog>>> | null = null
  let adjustmentRefresh: Promise<Awaited<ReturnType<typeof refreshAdjustmentCache>>> | null = null

  async function getStocks(): Promise<Awaited<ReturnType<typeof refreshStockCatalog>>['stocks']> {
    if (!config.tdxRoot) return []
    if (!stockRefresh) {
      stockRefresh = refreshStockCatalog(database, config.tdxRoot)
        .then(result => {
          stockCache = result.stocks
          return result
        })
        .finally(() => { stockRefresh = null })
    }
    await stockRefresh
    return stockCache ?? []
  }

  async function ensureAdjustmentCache() {
    if (!config.tdxRoot) return { refreshed: false, events: 0 }
    if (!adjustmentRefresh) {
      adjustmentRefresh = refreshAdjustmentCache(database, config.tdxRoot)
        .finally(() => { adjustmentRefresh = null })
    }
    return adjustmentRefresh
  }

  // 全局错误映射：业务错误（HttpError）与 Fastify 内建 4xx 都返回真实 message，
  // 否则前端只能看到默认的 "Bad Request"，丢失具体原因。
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message })
    }
    const statusCode = (error as { statusCode?: number }).statusCode
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: (error as Error).message || 'Bad Request' })
    }
    app.log.error(error)
    return reply.code(500).send({ error: '服务器内部错误' })
  })

  app.get('/api/env', async () => {
    const [stocks] = await Promise.all([getStocks(), ensureAdjustmentCache()])
    const active = getActiveTraining(database)
    return {
      status: 'ok',
      tdxRoot: config.tdxRoot,
      dataCutoff: stocks.map(stock => stock.lastDate).filter(Boolean).sort().at(-1) ?? null,
      stockCount: stocks.length,
      capabilities: { day: true, forwardAdjust: true, benchmark: true, catalogCache: true, training: true },
      activeTrainingId: active?.id ?? null,
    }
  })

  app.get('/api/stocks', async request => {
    if (!config.tdxRoot) return { items: [], total: 0, error: 'TDX directory not found' }
    const stocks = await getStocks()
    const query = request.query as { market?: string; q?: string }
    const q = query.q?.trim().toLowerCase() ?? ''
    const items = stocks.filter(stock =>
      (!query.market || stock.market === query.market) &&
      (!q || stock.code.includes(q) || stock.name.toLowerCase().includes(q)),
    )
    return { items: items.slice(0, 100), total: items.length }
  })

  // 原始行情接口：训练进行中关闭，保证前端拿不到任何训练日之后的 K 线（防未来的根）
  app.get('/api/kline/:code', async (request, reply) => {
    if (getActiveTraining(database)) {
      return reply.code(409).send({ error: '训练进行中，原始行情接口已关闭；训练行情请使用训练接口' })
    }
    if (!config.tdxRoot) return reply.code(503).send({ error: 'TDX directory not found' })
    const params = request.params as { code: string }
    const query = request.query as { from?: string; to?: string; tf?: Timeframe; adjust?: 'forward' | 'raw' }
    if (query.tf && !['1D', '1W', '1M'].includes(query.tf)) {
      return reply.code(400).send({ error: `Unsupported timeframe: ${query.tf}` })
    }
    if (query.adjust && !['forward', 'raw'].includes(query.adjust)) {
      return reply.code(400).send({ error: `Unsupported adjustment mode: ${query.adjust}` })
    }
    if ((query.from && !isDayDate(query.from)) || (query.to && !isDayDate(query.to))) {
      return reply.code(400).send({ error: 'from and to must be valid dates in YYYY-MM-DD format' })
    }
    if (query.from && query.to && query.from > query.to) {
      return reply.code(400).send({ error: `from date ${query.from} must not be after to date ${query.to}` })
    }
    let parsed
    try {
      parsed = parseTdxSymbol(params.code)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid symbol' })
    }
    const path = join(config.tdxRoot, 'vipdoc', parsed.market, 'lday', `${parsed.symbol}.day`)
    try {
      const daily = await readDayFileRange(path, query.from, query.to)
      const adjustmentMode = query.adjust ?? 'forward'
      let adjusted = daily
      if (adjustmentMode === 'forward') {
        await ensureAdjustmentCache()
        const baseDate = await readLastDayDate(path)
        adjusted = applyForwardAdjustment(daily, loadAdjustmentEvents(database, parsed.market, parsed.code), baseDate ?? undefined)
      }
      const timeframe = query.tf ?? '1D'
      return {
        code: parsed.code,
        market: parsed.market,
        symbol: parsed.symbol,
        timeframe,
        adjustmentMode,
        bars: aggregateBars(adjusted, timeframe),
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') return reply.code(404).send({ error: `TDX data not found for ${parsed.symbol}` })
      throw error
    }
  })

  app.post('/api/trainings', async (request, reply) => {
    if (!config.tdxRoot) return reply.code(503).send({ error: 'TDX directory not found' })
    const body = request.body as {
      tier?: string; code?: string; start_date?: string
      initial_cash?: number; blind?: boolean; adjust_mode?: string
    }
    if (!body.tier || !TIERS.includes(body.tier as never)) {
      return reply.code(400).send({ error: `tier 必须是 ${TIERS.join(' / ')} 之一` })
    }
    if (!body.code || !body.start_date) {
      return reply.code(400).send({ error: 'code 与 start_date 必填' })
    }
    const training = await createTraining(database, config, {
      tier: body.tier,
      code: body.code,
      start_date: body.start_date,
      initial_cash: body.initial_cash,
      blind: body.blind,
      adjust_mode: body.adjust_mode,
    })
    return reply.code(201).send({ training })
  })

  app.get('/api/trainings/active', async () => {
    const training = getActiveTraining(database)
    if (!training) return { training: null }
    const snapshot = trainingSnapshot(database, training.id)
    return snapshot
  })

  app.get('/api/trainings/:id', async request => {
    const { id } = request.params as { id: string }
    const trainingId = Number(id)
    if (!Number.isSafeInteger(trainingId) || trainingId < 1) throw new HttpError(400, 'id 必须是正整数')
    return trainingSnapshot(database, trainingId)
  })

  app.get('/api/trainings/:id/drawings', async request => {
    const { id } = request.params as { id: string }
    return { drawings: readDrawings(database, Number(id)) }
  })

  app.put('/api/trainings/:id/drawings', { bodyLimit: DRAWINGS_BODY_LIMIT }, async request => {
    const { id } = request.params as { id: string }
    return { drawings: writeDrawings(database, Number(id), request.body) }
  })

  app.get('/api/trainings/:id/bars', async (request, reply) => {
    const params = request.params as { id: string }
    const query = request.query as { tf?: Timeframe; before?: string; count?: string }
    const timeframe = query.tf ?? '1D'
    if (!['1D', '1W', '1M'].includes(timeframe)) {
      return reply.code(400).send({ error: `Unsupported timeframe: ${timeframe}` })
    }
    // 动态历史加载：before/count 分批取更早历史；before 接受 YYYY-MM（月 K）或 YYYY-MM-DD
    let chunk: { bars: Awaited<ReturnType<typeof trainingBars>>; hasMore: boolean } | null = null
    if (query.before !== undefined) {
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(query.before)) {
        return reply.code(400).send({ error: 'before 必须是 YYYY-MM 或 YYYY-MM-DD 格式' })
      }
      const count = query.count === undefined ? 300 : Number(query.count)
      if (!Number.isInteger(count) || count < 1 || count > 1000) {
        return reply.code(400).send({ error: 'count 必须是 1~1000 的整数' })
      }
      const id = Number(params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 必须是整数' })
      try {
        chunk = await trainingBarsBefore(database, config, id, timeframe, query.before, count)
      } catch (error) {
        if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
        throw error
      }
    }
    const id = Number(params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 必须是整数' })
    try {
      const snapshot = trainingSnapshot(database, id)
      const bars = chunk ? chunk.bars : await trainingBars(database, config, id, timeframe)
      const chart = buildChartSpace(database, id, snapshot.trades)
      return {
        ...snapshot,
        trades: chart.trades,
        chartCostPrice: chart.costPrice,
        timeframe,
        bars,
        // 画线前复权基准：bars 计算后读取（权息缓存已刷新）；与 bars 同次返回，不含未来权息。
        drawingPriceBasis: drawingPriceBasis(database, id),
        hasMore: chunk ? chunk.hasMore : bars.length >= TRAINING_LOAD_BARS,
      }
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/api/trainings/:id/next', async (request, reply) => {
    const params = request.params as { id: string }
    const id = Number(params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 必须是整数' })
    try {
      return await advanceTraining(database, config, id)
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/api/trainings/:id/trade', async (request, reply) => {
    const params = request.params as { id: string }
    const id = Number(params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 必须是整数' })
    const body = request.body as { side?: string; shares?: number; weightPct?: number }
    try {
      return await tradeTraining(database, id, {
        side: body.side,
        shares: body.shares === undefined ? undefined : Number(body.shares),
        weightPct: body.weightPct === undefined ? undefined : Number(body.weightPct),
      })
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/api/trainings/:id/settle', async (request, reply) => {
    const params = request.params as { id: string }
    const id = Number(params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 必须是整数' })
    try {
      const training = settleTraining(database, id)
      void training
      return { ...trainingSnapshot(database, id), equityCurve: equityCurveOf(database, id) }
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/api/trainings/:id/abandon', async (request, reply) => {
    const params = request.params as { id: string }
    const id = Number(params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 必须是整数' })
    try {
      const training = abandonTraining(database, id)
      return { training, equityCurve: equityCurveOf(database, id) }
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  // ===== R1 统一日线更新服务：状态查询 + 手动/启动/激活共用的单飞行刷新任务 =====
  const dataRefresh = createDataRefreshCoordinator(database, config)

  app.get('/api/data/status', async () => dataRefresh.getStatus())

  app.post('/api/data/refresh', async (_request, reply) => {
    const started = await dataRefresh.start()
    if (!started) return reply.code(409).send({ error: '未检测到通达信数据目录，且未配置在线数据源' })
    return reply.code(started.joined ? 200 : 202).send({ taskId: started.taskId, state: started.state, joined: started.joined })
  })
}
