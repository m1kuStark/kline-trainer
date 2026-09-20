<script setup lang="ts">
import { computed, ref } from 'vue'
import { createTraining, searchStocks, type Stock, type Tier } from '../api'
import { dataStatus, dataUpdating, refreshDataNow } from '../dataStatus'

const emit = defineEmits<{ created: [options: { enabled: boolean; params: Record<string, string | number> }] }>()
const recordingEnabled = ref(true)

const query = ref('')
const suggestions = ref<Stock[]>([])
const selected = ref<Stock | null>(null)
const tier = ref<Tier>('3M')
const startDate = ref(new Date().toISOString().slice(0, 10))
const initialCash = ref<number>(1_000_000)
const adjustMode = ref<'forward' | 'raw'>('forward')
const submitting = ref(false)
const errorMessage = ref('')
// 开始训练守卫：needsUpdate=true 时先弹确认框（needsUpdate=false 零打扰）
const showDataConfirm = ref(false)
const dataCutoff = computed(() => dataStatus.value?.sourceMaxDate ?? '未知')

const tiers: Array<{ value: Tier; label: string }> = [
  { value: '1M', label: '1个月' },
  { value: '3M', label: '3个月' },
  { value: '6M', label: '6个月' },
  { value: '1Y', label: '1年' },
  { value: '2Y', label: '2年' },
]

async function onQuery(): Promise<void> {
  if (!query.value.trim()) { suggestions.value = []; return }
  try {
    const result = await searchStocks(query.value.trim())
    suggestions.value = result.items.slice(0, 8)
  } catch {
    suggestions.value = []
  }
}

function choose(stock: Stock): void {
  selected.value = stock
  query.value = `${stock.code} ${stock.name}`
  suggestions.value = []
}

async function submit(): Promise<void> {
  if (submitting.value) return
  // 守卫加在提交路径最前端：数据待更新时先弹"建议先更新日线数据"确认框，不直接创建
  if (dataStatus.value?.needsUpdate && !dataUpdating.value) {
    showDataConfirm.value = true
    return
  }
  await performCreate()
}

async function performCreate(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  if (!selected.value) {
    errorMessage.value = '请先搜索并选择一只股票'
    return
  }
  if (!startDate.value) {
    errorMessage.value = '请选择起始日'
    return
  }
  const cash = Number(initialCash.value)
  if (!Number.isFinite(cash) || cash <= 0) {
    errorMessage.value = '初始资金必须是正数（默认 1,000,000）'
    return
  }
  submitting.value = true
  try {
    const params = {
      tier: tier.value,
      code: selected.value.code,
      start_date: startDate.value,
      initial_cash: cash,
      adjust_mode: adjustMode.value,
    }
    await createTraining(params)
    emit('created', { enabled: recordingEnabled.value, params })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建失败'
  } finally {
    submitting.value = false
  }
}

/** 弹窗主按钮【先更新数据】：触发 refresh、关弹窗、不开始训练 */
function confirmUpdateFirst(): void {
  showDataConfirm.value = false
  void refreshDataNow()
}

/** 弹窗次按钮【仍要开始训练】：关弹窗，照常提交创建训练 */
function confirmStartAnyway(): void {
  showDataConfirm.value = false
  void performCreate()
}
</script>

<template>
  <div class="launcher">
    <header class="launcher-head">
      <h1>创建训练</h1>
      <p>选一只股票、一个周期档和一个起始日，从起始日向前盲走训练。创建后复权方式锁定，训练中不可切换。</p>
    </header>

    <section class="launcher-form">
      <div class="form-field wide">
        <label>股票</label>
        <input v-model="query" placeholder="搜索代码或名称，如 600519 或 贵州茅台" @input="onQuery" />
        <div v-if="suggestions.length" class="suggestions">
          <button v-for="stock in suggestions" :key="stock.code" @click="choose(stock)">
            <strong>{{ stock.code }}</strong><span>{{ stock.name }}</span><small>{{ stock.market.toUpperCase() }}</small>
          </button>
        </div>
        <small v-if="selected" class="form-hint">已选：{{ selected.name }}（{{ selected.code }}，数据截至 {{ selected.lastDate ?? 'N/A' }}）</small>
      </div>

      <div class="form-field">
        <label>训练周期</label>
        <div class="tier-grid">
          <button v-for="item in tiers" :key="item.value" :class="{ selected: tier === item.value }" @click="tier = item.value">{{ item.label }}</button>
        </div>
      </div>

      <div class="form-row">
        <div class="form-field">
          <label>起始日</label>
          <input v-model="startDate" type="date" />
          <small class="form-hint">起始日之前最多 840 根 K 线同屏显示</small>
        </div>
        <div class="form-field">
          <label>初始资金</label>
          <input v-model.number="initialCash" type="number" min="10000" step="10000" />
        </div>
      </div>

      <!-- 双盲遮蔽已从 V1 移除（股票由用户手动选定，隐藏名称无意义）；
           随机股票＋随机时间的真盲测模式为 V2 候选，届时复用服务端休眠的 blind 遮蔽基建 -->
      <div class="form-field">
        <label>复权方式（创建后锁定）</label>
        <div class="tier-grid">
          <button :class="{ selected: adjustMode === 'forward' }" @click="adjustMode = 'forward'">前复权</button>
          <button :class="{ selected: adjustMode === 'raw' }" @click="adjustMode = 'raw'">不复权</button>
        </div>
      </div>

      <label class="recording-choice"><input v-model="recordingEnabled" type="checkbox" aria-label="记录操作" />记录操作</label>
      <small class="form-hint">建议保持开启，方便复盘、分享操作和排查问题。记录保存在本机浏览器，可随时暂停。</small>
      <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
      <button class="submit-button" :disabled="submitting" @click="submit">{{ submitting ? '创建中…' : '开始训练' }}</button>
    </section>

    <!-- 建议先更新日线数据：复用结算面板的模态风格（settle-mask/settle-panel） -->
    <div v-if="showDataConfirm" class="settle-mask" role="dialog" aria-modal="true" aria-label="建议先更新日线数据" @click.self="showDataConfirm = false">
      <div class="settle-panel data-confirm-panel">
        <h2>建议先更新日线数据</h2>
        <p class="data-confirm-text">
          <template v-if="dataStatus?.sourceMaxDate">本地日线数据截止 <strong>{{ dataCutoff }}</strong>，可能落后于最新交易日。建议先更新数据再开始训练，避免用缺失的最近行情练习。</template>
          <template v-else>尚未完成首次数据扫描，暂无法确认本地日线是否最新。建议先执行一次“更新日线”再开始训练，避免用缺失的最近行情练习。</template>
        </p>
        <div class="data-confirm-actions">
          <button class="trade-action buy" @click="confirmUpdateFirst">先更新数据</button>
          <button class="ghost-button" @click="confirmStartAnyway">仍要开始训练</button>
        </div>
      </div>
    </div>
  </div>
</template>
