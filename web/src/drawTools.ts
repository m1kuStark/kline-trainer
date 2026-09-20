// M3 画线工具注册表：工具随交付单元逐个加入（docs/M3-画线工具链-开发计划.md D 单元）。
// name＝klinecharts 内置 overlay 名或自定义注册名；label＝工具条显示名。
export interface DrawTool {
  name: string
  label: string
}

export const DRAW_TOOLS: DrawTool[] = [
  { name: 'segment', label: '线段' },
  { name: 'rayLine', label: '射线' },
  { name: 'straightLine', label: '直线' },
  { name: 'horizontalStraightLine', label: '水平直线' },
  { name: 'horizontalSegment', label: '水平线段' },
  { name: 'horizontalRayLine', label: '水平射线' },
  { name: 'verticalStraightLine', label: '垂直直线' },
  { name: 'verticalSegment', label: '垂直线段' },
  { name: 'verticalRayLine', label: '垂直射线' },
  { name: 'parallelStraightLine', label: '平行直线' },
  { name: 'priceChannelLine', label: '价格通道线' },
  { name: 'fibonacciLine', label: '斐波那契线' },
  { name: 'polyline', label: '画笔' },
  { name: 'priceLine', label: '价位线' },
  { name: 'rectangle', label: '矩形' },
  { name: 'circle', label: '圆圈' },
  { name: 'arc', label: '圆弧' },
  { name: 'arrowLine', label: '箭头线' },
  { name: 'bullArrow', label: '看涨箭头' },
  { name: 'bearArrow', label: '看跌箭头' },
  { name: 'percentageLine', label: '百分比线' },
  { name: 'curseLine', label: '诅咒线' },
  { name: 'textAnnotation', label: '文本' },
]
