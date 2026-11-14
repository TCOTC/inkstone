/**
 * 浮层坐标算法。这里是坐标系的唯一定义处，**不要在各处另写一套**。
 *
 * 三条约定：
 * - 一律用**页面坐标**（含滚动量）配合 `position: absolute`；浮层挂在
 *   `document.documentElement` 而不是 body，绝对定位的包含块才是初始包含块。
 * - 越界统一走 `clampToViewport`，钳位规则只有那一份。
 * - 划词工具条的尺寸不量实际 DOM：宽高来自 `toolbarMetrics.ts`（与 CSS 同源）。
 */
import {TOOLBAR_HEIGHT} from './toolbarMetrics'

export interface Point {
  x: number
  y: number
}
/** 只需要 left/top/宽高；`DOMRect` 结构兼容。 */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  /** 页面坐标下的左边缘 = window.scrollX */
  sx: number
  /** 页面坐标下的上边缘 = window.scrollY */
  sy: number
  /** documentElement.clientWidth */
  vw: number
  /** documentElement.clientHeight */
  vh: number
}

export interface SelectionBox {
  /** `range.getClientRects()` 的第一段 */
  first: Box
  /** 最后一段 */
  last: Box
  /** 反向选择（从后往前拖） */
  backward: boolean
}

/**
 * 把矩形钳进视口。
 *
 * 三处看起来别扭但**必须保留**的细节（改了就有一批浮层位置变化）：
 * 1. 判断越界用的是 `x + width + 2 * margin`，但钳回来只减 `margin`；
 *    也就是说「何时算越界」比「留多少边距」宽了一个 `margin`。
 * 2. 左/上先按「≤ 视口起点就贴到视口起点」，再单独对 `margin` 做一次 `<=` 判断。
 * 3. `margin` 为 0 时第三步不做——所以贴边时坐标可以正好等于视口边缘。
 */
export function clampToViewport(point: Point, width: number, height: number, margin: number, view: Viewport): Point {
  const right = view.sx + view.vw
  const bottom = view.sy + view.vh
  const pad = 2 * margin

  let x = point.x
  let y = point.y

  if (x <= view.sx) x = view.sx
  else if (right < x + width + pad) x = right - width - margin

  if (y <= view.sy) y = view.sy
  else if (bottom < y + height + pad) y = bottom - height - margin

  if (margin > 0) {
    if (x <= margin) x = margin
    if (y <= margin) y = margin
  }

  return {x, y}
}

/**
 * 划词工具条坐标（桌面 + 系统默认偏移）。
 *
 * 工具条的宽高由 `toolbarMetrics.ts` 提供（与 CSS 同源），这里只算位置。
 *
 * 正向选择（默认）：
 * - 锚点 = **最后一段**的右边再往右 8px、往下 22px；
 * - 再左移半个工具条宽度、下移 8px；
 * - 合起来：`x = last.right + 8 - w/2`、`y = last.top + 30`。
 *
 * 反向选择（从后往前拖）：
 * - 锚点 = **第一段**的左边再往左 8px、往上 工具条高度 + 8px；
 * - 再左移半个宽度、上移 8px；
 * - 合起来：`x = first.left - 8 - w/2`、`y = first.top - 46`（高度 30 时）。
 *
 * 「反向」与「自定义偏移」是互斥分支：反向时**不**应用用户偏移。
 * 这里没做自定义偏移（默认就是系统偏移），所以正向那一支直接减 8。
 */
export function textTooltipXY(box: SelectionBox, eleW: number, view: Viewport): Point {
  let x = box.last.x + box.last.width + 8 + view.sx
  let y = view.sy + box.last.y + 22

  if (box.backward) {
    x = view.sx + box.first.x - 8 - eleW / 2
    y = view.sy + box.first.y - TOOLBAR_HEIGHT - 8 - 8
  } else {
    x -= eleW / 2
    y += 8
  }

  return clampToViewport({x, y}, eleW, TOOLBAR_HEIGHT, 0, view)
}

/** 放在锚点下方（创建失败的提示用，贴在选区下面）。 */
export function belowAnchorXY(anchor: Point, width: number, height: number, view: Viewport): Point {
  return clampToViewport({x: anchor.x - width / 2, y: anchor.y}, width, height, 8, view)
}

/** 读当前视口与滚动量。 */
export function readViewport(): Viewport {
  const root = document.documentElement
  return {
    sx: window.scrollX || root.scrollLeft || 0,
    sy: window.scrollY || root.scrollTop || 0,
    vw: root.clientWidth,
    vh: root.clientHeight
  }
}

/**
 * 若干矩形的并集包围盒。
 *
 * 跳转提示框就靠它：把同一条划线的**所有**落点矩形取 min/max，得到一个框。
 * 跨段落的划线会得到一个很高的框，这是预期行为，不要改成「只框首段」。
 */
export function unionBoxes(boxes: readonly Box[]): Box | null {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY

  for (const box of boxes) {
    if (box.width === 0 && box.height === 0) continue
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }

  if (!Number.isFinite(left) || !Number.isFinite(top)) return null
  return {x: left, y: top, width: right - left, height: bottom - top}
}

/**
 * 选择方向（用 `anchorNode.compareDocumentPosition(focusNode)` 判断）：
 * - 同一节点：`anchorOffset > focusOffset` 即为反向；
 * - 跨节点：`DOCUMENT_POSITION_PRECEDING`（focus 在 anchor 之前）为反向。
 */
export function isBackwardSelection(): boolean {
  const selection = window.getSelection()
  if (!selection || !selection.anchorNode || !selection.focusNode) return false
  const position = selection.anchorNode.compareDocumentPosition(selection.focusNode)
  if (!position) return selection.anchorOffset > selection.focusOffset
  return position === Node.DOCUMENT_POSITION_PRECEDING
}
