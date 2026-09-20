import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 库版本哨兵：klinecharts 内部行为依赖在本文件锁定，升级版本时本测试变红即提示逐项复查
// docs/ai/architecture.md 的内部 API 钉定登记表。仅锁"我们依赖的内部行为特征"，不锁全部源码。

const lockPath = new URL('../../node_modules/klinecharts/package.json', import.meta.url)
const esmPath = new URL('../../node_modules/klinecharts/dist/index.esm.js', import.meta.url)

describe('klinecharts 版本与内部行为哨兵', () => {
  it('pins klinecharts to 10.0.3 (upgrade requires re-audit of internal API registry)', async () => {
    const pkg = JSON.parse(readFileSync(lockPath, 'utf8'))
    const installed = pkg.version
    expect(installed).toBe('10.0.3')
  })

  it('guards the internal behaviors our code depends on (see docs/ai/architecture.md registry)', async () => {
    const src = readFileSync(esmPath, 'utf8')
    // ① barSpaceLimit 默认 max=50（我们提到 300 的前提：该字段存在且为活对象）
    expect(src).toMatch(/barSpaceLimit:\s*\{\s*min: 1,\s*max: 50/)
    // ② figure 命中容差 DEVIATION=2（我们 7px 门限补齐的依据）
    expect(src).toMatch(/var DEVIATION = 2;/)
    // ③ drawText 左上对齐（B/S 字母偏移补偿依据）：textAlign 强制赋值 'left'
    expect(src).toMatch(/textAlign = 'left'/)
    // ④ 双击判定窗口 Delay.ResetClick=500（画线两次点击须 >500ms 的依据）
    expect(src).toMatch(/ResetClick: 500/)
    // ⑤ mouseUp 只认左键（中键松键补发合成 mouseup 的依据）
    expect(src).toMatch(/_mouseUpHandler = function \(mouseUpEvent\) \{\s*if \(mouseUpEvent\.button !== MouseEventButton\.Left\)\s*\{\s*return/)
    // ⑥ overlay 取点完成钩子 createPointFigures 存在（自定义 overlay 渲染入口）
    expect(src).toMatch(/createPointFigures/)
    // ⑦ 库默认方向色 Color.GREEN='#2DC08E'（国际绿涨红跌，priceMark.last 覆盖的依据）
    expect(src).toMatch(/GREEN: '#2DC08E'/)
  })
})
