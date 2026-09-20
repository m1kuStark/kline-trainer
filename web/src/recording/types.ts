// REC-01 共享接口合同：web/src/recording/types.ts（docs/engineering/recording-contract.md）
// 本文件为纯类型模块，不引入服务端或存储实现。
import type { Timeframe, Bar, TrainingSnapshot } from '../api'
import type { Drawing } from '../drawingState'

/** 有限JSON递归类型：不含 undefined，数值须有限 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Action 白名单常量，类型由该元组派生，保持同步 */
export const ACTIONS = [
  'training.create',
  'training.advance',
  'training.trade',
  'training.settle',
  'training.abandon',
  'chart.load',
  'chart.timeframe',
  'chart.viewport',
  'chart.tool',
  'chart.drawing.create',
  'chart.drawing.edit',
  'chart.drawing.move',
  'chart.drawing.delete',
  'chart.drawing.undo',
  'chart.drawing.redo',
  'chart.drawing.cancel',
  'chart.drawing.clear',
  'drawings.save',
  'ui.theme',
  'recording.pause',
  'recording.resume',
  'session.interrupted',
] as const

export type Action = (typeof ACTIONS)[number]

export type RecordingEventPhase = 'started' | 'finished'
export type RecordingEventSource = 'ui' | 'keyboard' | 'chart' | 'system'
export type RecordingEventOutcome =
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

/** seq 严格从 1 递增 */
export interface RecordingEvent {
  seq: number
  opId: string
  segmentId: string
  elapsedMs: number
  phase: RecordingEventPhase
  action: Action
  source: RecordingEventSource
  params?: JsonValue
  outcome?: RecordingEventOutcome
  result?: JsonValue
  checkpointId?: string
}

export interface ChartCaptureView {
  fromTimestamp: number | null
  toTimestamp: number | null
  barSpace: number
  paneHeights: Record<string, number>
}

/** bars 为当前可见边界内已加载数据，不含未来 bars */
export interface ChartCapture {
  timeframe: Timeframe
  bars: Bar[]
  drawings: Drawing[]
  view: ChartCaptureView
  costPrice: number | null
}

export interface RecordingCheckpointUi {
  theme: string
  tool: string | null
  magnet: string
  multiSelect: boolean
}

/** context 只声明实际观察到的规则与权息 */
export interface RecordingCheckpoint {
  id: string
  afterSeq: number
  segmentId: string
  capturedAt: string
  training: TrainingSnapshot | null
  chart: ChartCapture | null
  ui: RecordingCheckpointUi
  context: JsonValue | null
}

export interface RecordingFileAppInfo {
  version: string
  gitCommit: string
  dirty: boolean
  chartLibrary: string
}

export interface RecordingFileEnvironment {
  timezone: string
  viewport: { width: number; height: number }
  dpr: number
}

export interface RecordingGap {
  afterSeq: number
  resumedAtSeq: number | null
}

export interface RecordingFile {
  format: 'trainer-session'
  schemaVersion: 1
  sessionId: string
  createdAt: string
  app: RecordingFileAppInfo
  environment: RecordingFileEnvironment
  trainingKey: string | null
  events: RecordingEvent[]
  checkpoints: RecordingCheckpoint[]
  gaps: RecordingGap[]
  complete: boolean
}

/** CheckpointInput 为 checkpoint 除 id/afterSeq/segmentId/capturedAt 外的输入形状 */
export type CheckpointInput = Omit<
  RecordingCheckpoint,
  'id' | 'afterSeq' | 'segmentId' | 'capturedAt'
>

export interface RecorderStatus {
  state: 'recording' | 'paused' | 'error'
  error: string | null
  eventCount: number
  sessionId: string
}

export interface RecorderOptions {
  app: RecordingFileAppInfo
  environment: RecordingFileEnvironment
  onChange?: (status: RecorderStatus) => void
}

export interface RecordingStorage {
  save(file: RecordingFile): Promise<void>
  load(id: string): Promise<RecordingFile | null>
  list(): Promise<RecordingSummary[]>
}

export interface RecordingSummary {
  sessionId: string
  trainingKey: string | null
  createdAt: string
  eventCount: number
}
