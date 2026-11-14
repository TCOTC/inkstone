/**
 * 划词工具条的盒模型——**唯一数据源**。
 *
 * 这套数字同时被两处使用，必须同源：
 * - `geometry.ts` 的坐标钳位（要知道工具条多宽多高才能把它夹回视口）；
 * - `toolbar.ts` 里 `STYLE` 的 CSS（按钮边长、间距、内边距、边框）。
 *
 * 以前两处各写一份、靠注释互相提醒：改 CSS 忘了改常量 → 工具条被裁掉或右偏；
 * 改常量忘了改 CSS → 钳位算错，浮层贴边时露出半截。现在两边都由这里生成。
 *
 * 圆角那条规则也是同一个道理：内层悬停矩形的圆角 = 外框圆角 − (边框 + 内边距)，
 * 四边留白相等才能同心，所以 `TOOLBAR_RADIUS` / `TOOLBAR_ITEM_RADIUS` 一起放这里。
 */

/** 按钮边长（图标 14 居中）。 */
export const TOOLBAR_BUTTON = 24
/** 按钮之间的间距。 */
export const TOOLBAR_GAP = 2
/** 容器内边距（四边相等）。 */
export const TOOLBAR_PADDING = 2
/** 容器边框宽度。 */
export const TOOLBAR_BORDER = 1
/** 容器外圆角。 */
export const TOOLBAR_RADIUS = 8
/** 按钮悬停背景的圆角：与外框同心（见文件头）。 */
export const TOOLBAR_ITEM_RADIUS = TOOLBAR_RADIUS - TOOLBAR_PADDING - TOOLBAR_BORDER
/** 图标边长（只影响 `icons.ts` 的调用，不参与盒模型）。 */
export const TOOLBAR_ICON = 14

/**
 * 工具条高度：`按钮 + 上下内边距 + 上下边框`。
 * 钳位时按这个值算，**不量实际 DOM**（浮层刚显示时量不到，`show()` 之后再量会抖）。
 */
export const TOOLBAR_HEIGHT = TOOLBAR_BUTTON + 2 * (TOOLBAR_PADDING + TOOLBAR_BORDER)

/** 工具条宽度：`按钮n + 间距(n-1) + 两侧（内边距 + 边框）`。 */
export function toolbarWidth(buttonCount: number): number {
  return (
    TOOLBAR_BUTTON * buttonCount + TOOLBAR_GAP * (buttonCount - 1) + 2 * (TOOLBAR_PADDING + TOOLBAR_BORDER)
  )
}

/**
 * `.toolbar` 的盒模型声明（拼进 `STYLE` 模板字符串）。
 *
 * 只放与上面常量绑定的几何属性；颜色与阴影留在 CSS 里——它们不参与钳位计算。
 */
export const TOOLBAR_BOX_CSS = `
  gap: ${TOOLBAR_GAP}px;
  padding: ${TOOLBAR_PADDING}px;
  border: ${TOOLBAR_BORDER}px solid var(--ink-border);
  border-radius: ${TOOLBAR_RADIUS}px;
`.trim()

/** 工具条按钮的盒模型声明（`.mark` / `.trash` / `.copy` / `.refresh` 共用）。 */
export const TOOLBAR_BUTTON_CSS = `
  width: ${TOOLBAR_BUTTON}px;
  height: ${TOOLBAR_BUTTON}px;
  flex: 0 0 ${TOOLBAR_BUTTON}px;
  border-radius: ${TOOLBAR_ITEM_RADIUS}px;
`.trim()
