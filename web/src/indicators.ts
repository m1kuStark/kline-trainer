import { registerIndicator } from 'klinecharts'

interface MacdResult { dif: number; dea: number; macd: number }

// 通达信 APP 标准 MACD：柱体一律实心、红正绿负（不用内置的"增空减实"描边画法），
// DIF 白 / DEA 黄，配色在 createIndicator 的 styles.lines 中传入。
registerIndicator({
  name: 'MACD',
  shortName: 'MACD',
  calcParams: [12, 26, 9],
  figures: [
    { key: 'dif', title: 'DIF: ', type: 'line' },
    { key: 'dea', title: 'DEA: ', type: 'line' },
    {
      key: 'macd',
      title: 'MACD: ',
      type: 'bar',
      baseValue: 0,
      // 柱体宽度＝库默认（halfGapBar*2）的 2/5（用户口径 2026-09-06：红绿柱太粗）
      attrs: ({ barSpace }) => ({ width: Math.max(1, barSpace.halfGapBar * 2 * 0.4) }),
      styles: ({ data }) => {
        const macd = (data.current as unknown as MacdResult | undefined)?.macd ?? 0
        const color = macd > 0 ? '#ef4444' : macd < 0 ? '#16a34a' : '#94a3b8'
        return { style: 'fill', color, borderColor: color }
      },
    },
  ],
  calc: (dataList, indicator) => {
    const [fast, slow, signal] = indicator.calcParams as number[]
    let emaFast = Number.NaN
    let emaSlow = Number.NaN
    let dea = Number.NaN
    return dataList.map((bar: { close?: number }) => {
      const close = bar.close ?? 0
      emaFast = Number.isNaN(emaFast) ? close : (2 * close + (fast - 1) * emaFast) / (fast + 1)
      emaSlow = Number.isNaN(emaSlow) ? close : (2 * close + (slow - 1) * emaSlow) / (slow + 1)
      const dif = emaFast - emaSlow
      dea = Number.isNaN(dea) ? dif : (2 * dif + (signal - 1) * dea) / (signal + 1)
      return { dif, dea, macd: (dif - dea) * 2 }
    })
  },
})
