<script setup lang="ts">
import { computed } from 'vue'
import type { Timeframe, TradeView } from './api'
import { groupTradeMarkers, type TradeMarkerCluster } from './tradeMarkerLayout'

const props = defineProps<{
  trades: TradeView[]
  timeframe: Timeframe
  project: (timestamp: number) => number | null
  width: number
  revision: number
}>()

const markers = computed(() => {
  void props.revision
  return groupTradeMarkers(props.trades, props.timeframe, props.project, props.width)
})

function markerLabel(marker: TradeMarkerCluster): string {
  const letter = marker.side === 'buy' ? 'B' : 'S'
  return marker.count === 1 ? letter : `${letter}${marker.count > 99 ? '99+' : marker.count}`
}

function markerTitle(marker: TradeMarkerCluster): string {
  const side = marker.side === 'buy' ? '买入' : '卖出'
  return `${side} ${marker.count} 笔\n${marker.trades.map(trade => (
    `${trade.blindLabel ?? trade.date}  ${trade.shares.toLocaleString('zh-CN')} 股  ${trade.price.toFixed(2)} 元`
  )).join('\n')}`
}
</script>

<template>
  <div class="trade-marker-rail" role="group" aria-label="成交标记">
    <span
      v-for="marker in markers"
      :key="`${marker.side}:${marker.trades[0]?.seq}`"
      class="trade-marker-badge"
      :data-side="marker.side"
      :data-count="marker.count"
      :style="{ left: `${marker.x - marker.width / 2}px`, width: `${marker.width}px` }"
      :title="markerTitle(marker)"
      :aria-label="markerTitle(marker)"
      role="img"
      tabindex="0"
    >{{ markerLabel(marker) }}</span>
  </div>
</template>

<style scoped>
.trade-marker-rail {
  position: relative;
  height: 40px;
  min-height: 40px;
  flex: 0 0 40px;
  width: 100%;
  overflow: hidden;
  background: var(--trade-marker-rail-bg, #ffffff);
  border-top: 1px solid var(--trade-marker-rail-border, #e8edf2);
  box-sizing: border-box;
}

.trade-marker-badge {
  position: absolute;
  top: 2px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  border-radius: 2px;
  background: #e88918;
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  line-height: 17px;
  letter-spacing: 0;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}

.trade-marker-badge[data-side="sell"] {
  top: 21px;
  background: #24a6d9;
}

.trade-marker-badge:focus-visible {
  outline: 1px solid #ffffff;
  outline-offset: -2px;
}

:global(body.dark .trade-marker-rail) {
  --trade-marker-rail-bg: #000000;
  --trade-marker-rail-border: #202020;
}
</style>
