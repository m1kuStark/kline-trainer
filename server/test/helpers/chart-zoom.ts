import { readFile } from 'node:fs/promises'
import ts from 'typescript'

/** Execute the component's actual zoom function against observable chart ports. */
export async function exerciseChartZoom(factor: number, visibleBars = 1) {
  const source = await readFile(new URL('../../../web/src/components/KlineChart.vue', import.meta.url), 'utf8')
  const start = source.indexOf('function zoomBy(')
  const end = source.indexOf('function moveCrosshair(', start)
  if (start < 0 || end < 0) throw new Error('Chart zoom function not found')
  const body = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const actions: string[] = []
  let barSpace = 6
  const chart = {
    getVisibleRange: () => ({ from: 0, to: visibleBars }),
    getSize: () => ({ width: 800 }),
    getBarSpace: () => ({ bar: barSpace }),
    setBarSpace: (value: number) => { actions.push('spacing'); barSpace = value },
    scrollToDataIndex: (value: number) => actions.push(`anchor:${value}`),
  }
  const run = new Function('chart', 'clampCount', 'RIGHT_MARGIN', 'clampBarSpace', 'restoreYAxisAutoFit', 'emit', 'visibleCount', 'scheduleViewportOperation', body + '\nreturn zoomBy;')(
    chart, (value: number) => Math.max(1, Math.min(840, value)), 80,
    (value: number) => Math.max(.1, Math.min(300, value)),
    () => actions.push('auto-fit'), () => actions.push('visible-count'),
    () => visibleBars, () => actions.push('viewport'),
  ) as (value: number) => void
  run(factor)
  return { actions, barSpace }
}
