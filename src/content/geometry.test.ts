import assert from 'node:assert/strict'
import test from 'node:test'

import {
  belowAnchorXY,
  clampToViewport,
  textTooltipXY,
  unionBoxes,
  type Box,
  type Viewport
} from './geometry'
import {TOOLBAR_HEIGHT, toolbarWidth} from './toolbarMetrics'

/** 一个 1000×800 的视口，滚动到 (0, 0)。 */
const VIEW: Viewport = {sx: 0, sy: 0, vw: 1000, vh: 800}

function box(x: number, y: number, width: number, height: number): Box {
  return {x, y, width, height}
}

test('clampToViewport：完全在视口内时原样返回', () => {
  assert.deepEqual(clampToViewport({x: 100, y: 100}, 200, 40, 0, VIEW), {x: 100, y: 100})
})

test('clampToViewport：越过左/上边界贴到视口起点（margin 0 时不加边距）', () => {
  assert.deepEqual(clampToViewport({x: -30, y: -30}, 200, 40, 0, VIEW), {x: 0, y: 0})
})

test('clampToViewport：越过右/下边界时只减一个 margin，而越界判断用 2 个 margin', () => {
  // 右边 1000；x + 200 + 16 > 1000 才钳 → x=813 时 1029 > 1000，钳到 1000-200-8=792
  assert.deepEqual(clampToViewport({x: 813, y: 770}, 200, 40, 8, VIEW), {x: 792, y: 800 - 40 - 8})
  // 刚好不越界：x + 200 + 16 === 1000 → 不钳
  assert.deepEqual(clampToViewport({x: 784, y: 10}, 200, 40, 8, VIEW), {x: 784, y: 10})
})

test('clampToViewport：margin > 0 时再单独夹一次左上边距', () => {
  assert.deepEqual(clampToViewport({x: 3, y: 3}, 200, 40, 8, VIEW), {x: 0 + 8, y: 0 + 8})
})

test('clampToViewport：滚动后按页面坐标比较，而不是视口坐标', () => {
  const scrolled: Viewport = {sx: 0, sy: 500, vw: 1000, vh: 800}
  // 页面坐标 400 < sy 500 → 贴到 500
  assert.deepEqual(clampToViewport({x: 10, y: 400}, 200, 40, 0, scrolled), {x: 10, y: 500})
})

test('textTooltipXY：正向选择落在末段右下 8px，再左移半个宽度、下移 8px', () => {
  const last = box(200, 300, 100, 20)
  const width = toolbarWidth(2)
  const point = textTooltipXY({first: box(100, 300, 100, 20), last, backward: false}, width, VIEW)
  assert.equal(point.x, 300 + 8 - width / 2)
  assert.equal(point.y, 300 + 22 + 8)
})

test('textTooltipXY：反向选择改用首段左上，且纵向减去高度 + 8 + 8', () => {
  const first = box(100, 300, 100, 20)
  const width = toolbarWidth(2)
  const point = textTooltipXY({first, last: box(200, 400, 100, 20), backward: true}, width, VIEW)
  assert.equal(point.x, 100 - 8 - width / 2)
  assert.equal(point.y, 300 - TOOLBAR_HEIGHT - 8 - 8)
})

test('textTooltipXY：贴右边缘时钳进视口（margin 0 可以正好贴边）', () => {
  const last = box(940, 100, 60, 20)
  const point = textTooltipXY({first: last, last, backward: false}, 104, VIEW)
  assert.equal(point.x, 1000 - 104)
})

test('textTooltipXY：用页面坐标，滚动量会加进去', () => {
  const scrolled: Viewport = {sx: 40, sy: 600, vw: 1000, vh: 800}
  const last = box(200, 300, 100, 20)
  const point = textTooltipXY({first: last, last, backward: false}, 104, scrolled)
  assert.equal(point.x, 40 + 300 + 8 - 52)
  assert.equal(point.y, 600 + 300 + 22 + 8)
})

test('belowAnchorXY：居中放下方', () => {
  assert.deepEqual(belowAnchorXY({x: 500, y: 400}, 200, 100, VIEW), {x: 400, y: 400})
})

test('unionBoxes：多段落取并集（跨行/跨段跳转提示框用）', () => {
  const union = unionBoxes([box(100, 200, 300, 20), box(50, 240, 200, 20), box(120, 280, 100, 20)])
  assert.deepEqual(union, {x: 50, y: 200, width: 350, height: 100})
})

test('unionBoxes：单段原样返回', () => {
  assert.deepEqual(unionBoxes([box(10, 20, 30, 40)]), {x: 10, y: 20, width: 30, height: 40})
})

test('unionBoxes：空数组与全零矩形返回 null（不画框）', () => {
  assert.equal(unionBoxes([]), null)
  assert.equal(unionBoxes([box(0, 0, 0, 0)]), null)
})

test('unionBoxes：忽略零尺寸矩形，只用有效的', () => {
  assert.deepEqual(unionBoxes([box(0, 0, 0, 0), box(5, 6, 7, 8)]), {x: 5, y: 6, width: 7, height: 8})
})
