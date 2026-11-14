import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampPercent,
  compareDocOrder,
  dedupeAdjacent,
  markerItemTop,
  markerListTop,
  markerPercent,
  type MarkerMeasure
} from './markerLayout'

function measure(patch: Partial<MarkerMeasure> = {}): MarkerMeasure {
  return {rectTop: 0, rectHeight: 20, scrollY: 0, bodyHeight: 1000, scroller: null, ...patch}
}

test('clampPercent：夹到 0~100，非有限值当 0', () => {
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(150), 100)
  assert.equal(clampPercent(42.5), 42.5)
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0)
})

test('markerPercent：无滚动容器时按文档中心算（含 scrollY）', () => {
  // 视口 top=400，高 20 → 中心 410；滚了 590 → 页面坐标 1000；body 2000 → 50%
  assert.equal(markerPercent(measure({rectTop: 400, rectHeight: 20, scrollY: 590, bodyHeight: 2000})), 50)
})

test('markerPercent：有滚动容器时按容器内容算，忽略 window.scrollY', () => {
  const scroller = {top: 100, scrollTop: 300, scrollHeight: 1200}
  // 400 - 100 + 300 + 10 = 610；610 / 1200 ≈ 50.83%
  const value = markerPercent(measure({rectTop: 400, rectHeight: 20, scrollY: 9999, scroller}))
  assert.equal(Math.round(value * 100) / 100, 50.83)
})

test('markerPercent：scrollHeight 为 0 时用 `|| 1` 兜底，结果直接撞到 100（不是 0）', () => {
  // 除 0 变成除 1：`/(scrollHeight || 1) * 100` → 31000% → 夹到 100。
  // 这不是笔误：保留它，才能与已渲染位置的既有行为一致（原页面对 scrollHeight 为 0 的容器本来就没法定位）。
  const value = markerPercent(measure({rectTop: 300, scroller: {top: 0, scrollTop: 0, scrollHeight: 0}}))
  assert.equal(value, 100)
})

test('markerPercent：bodyHeight 为 0 同样 `|| 1` 兜底，夹到 100；负方向才是 0', () => {
  assert.equal(markerPercent(measure({rectTop: 0, bodyHeight: 0})), 100)
  assert.equal(markerPercent(measure({rectTop: -1000, bodyHeight: 0})), 0)
})

test('markerPercent：超出范围的两端被夹住', () => {
  assert.equal(markerPercent(measure({rectTop: -500, bodyHeight: 1000})), 0)
  assert.equal(markerPercent(measure({rectTop: 5000, bodyHeight: 1000})), 100)
})

test('markerItemTop：输出 calc(rt% - 5px)', () => {
  assert.equal(markerItemTop(12.345), 'calc(12.345% - 5px)')
})

test('markerListTop：依次夹到 [12, innerHeight - 12 - 列表可见高度]', () => {
  // 列表内容 500px → 可见高度 min(320, ...) = 320；innerHeight 800 → 上界 468
  assert.equal(markerListTop(600, 500, 800), 468)
  assert.equal(markerListTop(2, 500, 800), 12)
  assert.equal(markerListTop(200, 500, 800), 200)
})

test('markerListTop：内容很短时按实际高度算，列表可以更靠下', () => {
  // scrollHeight 100 → 可见高度 100；800 - 12 - 100 = 688
  assert.equal(markerListTop(900, 100, 800), 688)
})

test('markerListTop：窗口很矮时列表高度受 innerHeight - 24 限制', () => {
  // innerHeight 200 → min(320, 176) = 176 → 200 - 12 - 176 = 12
  assert.equal(markerListTop(150, 500, 200), 12)
})

test('dedupeAdjacent：只合并相邻重复，不跨项去重', () => {
  const input = [{id: 1}, {id: 1}, {id: 2}, {id: 1}, {id: 1}]
  assert.deepEqual(dedupeAdjacent(input).map((item) => item.id), [1, 2, 1])
})

test('dedupeAdjacent：空数组与单元素原样返回', () => {
  assert.deepEqual(dedupeAdjacent([]), [])
  assert.deepEqual(dedupeAdjacent([{id: 1}]), [{id: 1}])
})

test('compareDocOrder：先比文本节点下标，再比节点内偏移', () => {
  const list = [
    {nodeIndex: 5, start: 10},
    {nodeIndex: 2, start: 30},
    {nodeIndex: 5, start: 2},
    {nodeIndex: 2, start: 1}
  ]
  const sorted = [...list].sort(compareDocOrder)
  assert.deepEqual(sorted, [
    {nodeIndex: 2, start: 1},
    {nodeIndex: 2, start: 30},
    {nodeIndex: 5, start: 2},
    {nodeIndex: 5, start: 10}
  ])
})

test('compareDocOrder：同一位置返回 0（保持导入顺序，sort 是稳定的）', () => {
  assert.equal(compareDocOrder({nodeIndex: 3, start: 7}, {nodeIndex: 3, start: 7}), 0)
})
