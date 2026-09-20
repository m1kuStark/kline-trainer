// REC-01 v2紧凑存储合同：web/src/recording/compactTypes.ts
// 纯类型模块（docs/engineering/recording-v2-contract.md「数据结构」节）。
// 只复用 types.ts 既有形状，不修改旧类型；校验/压缩/IndexedDB 属后续独立任务。
import type { AccountView, Bar, Timeframe, TradeView, TrainingMeta } from '../api'
import type { Drawing } from '../drawingState'
import type {
  ChartCaptureView,
  JsonValue,
  RecordingCheckpointUi,
  RecordingFile,
} from './types'

/** 行情版本：base=null 为全量基础，否则为基于 base 版本的增量 */
export interface SeriesBaseVersion {
  id: string
  timeframe: Timeframe
  /** 观察截止日（ YYYY-MM-DD）；训练/盲态未知截止时为 null */
  asOf: string | null
  /** 首次出现的检查点数组下标 */
  firstCheckpoint: number
  base: null
  bars: Bar[]
}

export interface SeriesDeltaVersion {
  id: string
  timeframe: Timeframe
  asOf: string | null
  firstCheckpoint: number
  base: string
  /** 按日期键 upsert（含同日期键变OHLC的复权/周月当前柱更新） */
  upsert: Bar[]
  remove: string[]
}

export type SeriesVersion = SeriesBaseVersion | SeriesDeltaVersion

/** 画线版本：整体状态按 id 增量，工具/窗格/点/样式/文字原值保留 */
export interface DrawingBaseVersion {
  id: string
  base: null
  items: Drawing[]
}

export interface DrawingDeltaVersion {
  id: string
  base: string
  upsert: Drawing[]
  remove: string[]
}

export type DrawingVersion = DrawingBaseVersion | DrawingDeltaVersion

/** 内容寻址去重表条目（trainingMeta/accounts/trades/contexts 共用形状） */
export interface CompactValueEntry<T> {
  id: string
  value: T
}

/** 轻量checkpoint：只保留身份字段与资源引用，训练/图表/context指向不可变资源 */
export interface CompactCheckpoint {
  id: string
  afterSeq: number
  segmentId: string
  capturedAt: string
  ui: RecordingCheckpointUi
  training: null | {
    metaRef: string
    accountRef: string
    /** 每个实际观察到的 TradeView 版本一个引用；同seq不同内容各自成版本 */
    tradeRefs: string[]
  }
  chart: null | {
    timeframe: Timeframe
    seriesRef: string
    drawingsRef: string
    view: ChartCaptureView
    costPrice: number | null
  }
  contextRef: string | null
}

/** 只追加资源表；各表内 id 非空且唯一 */
export interface CompactResources {
  series: SeriesVersion[]
  drawings: DrawingVersion[]
  trainingMeta: Array<CompactValueEntry<TrainingMeta>>
  accounts: Array<CompactValueEntry<AccountView>>
  trades: Array<CompactValueEntry<TradeView>>
  contexts: Array<CompactValueEntry<JsonValue>>
}

export type CompactRecordingFile = Omit<RecordingFile, 'schemaVersion' | 'checkpoints'> & {
  schemaVersion: 2
  checkpoints: CompactCheckpoint[]
  resources: CompactResources
}
