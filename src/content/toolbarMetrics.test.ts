/**
 * 工具条盒模型的单一数据源。
 *
 * 这里锁的是「CSS 与坐标计算不能各写一份」：`geometry.ts` 用这些数字钳位，
 * `toolbar.ts` 用它们拼 CSS。任何一侧私自改成硬编码，下面的断言就会红。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOOLBAR_BORDER,
  TOOLBAR_BOX_CSS,
  TOOLBAR_BUTTON,
  TOOLBAR_BUTTON_CSS,
  TOOLBAR_GAP,
  TOOLBAR_HEIGHT,
  TOOLBAR_ITEM_RADIUS,
  TOOLBAR_PADDING,
  TOOLBAR_RADIUS,
  toolbarWidth
} from './toolbarMetrics'

test('高度 = 按钮 + 上下内边距 + 上下边框', () => {
  assert.equal(TOOLBAR_HEIGHT, TOOLBAR_BUTTON + 2 * (TOOLBAR_PADDING + TOOLBAR_BORDER))
  assert.equal(TOOLBAR_HEIGHT, 30)
})

test('宽度 = 按钮n + 间距(n-1) + 两侧（内边距+边框）', () => {
  for (const count of [1, 2, 3, 4]) {
    const expected =
      TOOLBAR_BUTTON * count + TOOLBAR_GAP * (count - 1) + 2 * (TOOLBAR_PADDING + TOOLBAR_BORDER)
    assert.equal(toolbarWidth(count), expected, `按钮数 ${count}`)
  }
  // 与历史值保持一致（改这里等于改工具条视觉尺寸，必须是有意的）。
  assert.equal(toolbarWidth(1), 30)
  assert.equal(toolbarWidth(2), 56)
  assert.equal(toolbarWidth(4), 108)
})

test('内层圆角与外框同心', () => {
  assert.equal(TOOLBAR_ITEM_RADIUS, TOOLBAR_RADIUS - TOOLBAR_PADDING - TOOLBAR_BORDER)
})

test('生成的 CSS 用的是同一组数字', () => {
  assert.ok(TOOLBAR_BOX_CSS.includes(`gap: ${TOOLBAR_GAP}px`))
  assert.ok(TOOLBAR_BOX_CSS.includes(`padding: ${TOOLBAR_PADDING}px`))
  assert.ok(TOOLBAR_BOX_CSS.includes(`border: ${TOOLBAR_BORDER}px solid`))
  assert.ok(TOOLBAR_BOX_CSS.includes(`border-radius: ${TOOLBAR_RADIUS}px`))

  assert.ok(TOOLBAR_BUTTON_CSS.includes(`width: ${TOOLBAR_BUTTON}px`))
  assert.ok(TOOLBAR_BUTTON_CSS.includes(`height: ${TOOLBAR_BUTTON}px`))
  assert.ok(TOOLBAR_BUTTON_CSS.includes(`border-radius: ${TOOLBAR_ITEM_RADIUS}px`))
})
