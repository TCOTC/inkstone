/**
 * 恢复被站点禁用的文本选择。
 *
 * 有些站点（最典型的是微信公众号文章）把正文的 `user-select` 设成 `none` 来防复制。
 *
 * **影响面只有「划新划线」这一件事**：
 * - 回放不受影响：索引、重定位、`CSS.highlights` 全都不需要选区；
 * - 点击查看、hover 换色也不受影响：命中判定走 `caretRangeFromPoint`，不是选区；
 * - 只有「拖选文字 → 出工具条 → 新建划线」会失效，因为浏览器根本不产生选区。
 *
 * 处理方式是**按需覆盖**：
 * 1. 先检测页面是不是真的禁用了选择；
 * 2. 只有禁用时才注入一条 `user-select: text !important`。
 *
 * 不无条件注入：绝大多数站点本来就能选，无谓地改它的样式只会带来副作用
 * （拖拽手柄、控件文字被选中、编辑器光标行为变化）。
 */

const STYLE_ID = 'inkstone-selectable'

/** 检测时最多看这么多个「文本块」：命中几乎都在正文容器上，不必遍历全页。 */
const PROBE_LIMIT = 600

/** 文本块的最小字符数。用来排除导航按钮、图标文字这类"顺带"禁选的元素。 */
const TEXT_MIN = 20

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/**
 * 表单控件与可编辑区域保持站点原样：覆盖它们会改掉浏览器的原生行为
 * （输入框的选区、富文本编辑器的 caret），得不偿失。
 */
const CSS = `
html, body, body * {
  -webkit-user-select: text !important;
  user-select: text !important;
}
input, textarea, select, option, [contenteditable="true"], [contenteditable=""] {
  -webkit-user-select: auto !important;
  user-select: auto !important;
}
`

function userSelectOf(element: Element): string {
  const style = getComputedStyle(element)
  // Chrome 认标准名，但站点普遍还在写 `-webkit-user-select`，两个都看。
  const legacy = (style as unknown as {webkitUserSelect?: string}).webkitUserSelect
  return style.userSelect || legacy || ''
}

/** 元素自身直接挂着可见文本（不含纯空白）。 */
function hasDirectText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0) return true
  }
  return false
}

/**
 * 页面是否禁用了正文选择。
 *
 * 只看「够长的文本块」：导航按钮、菜单项也常写 `user-select: none`，
 * 但它们的文本很短，拿它们当依据会在正常站点上误判。
 */export function selectionDisabled(root: HTMLElement = document.body): boolean {
  if (!root) return false
  if (userSelectOf(root) === 'none') return true

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let looked = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as Element
    if (SKIP_TAGS.has(element.nodeName)) continue
    if (!hasDirectText(element)) continue
    if ((element.textContent ?? '').trim().length < TEXT_MIN) continue
    looked += 1
    if (looked > PROBE_LIMIT) return false
    if (userSelectOf(element) === 'none') return true
  }
  return false
}

/**
 * 已经探过一次的结论。
 *
 * 空 `mouseup`（「点了一下别处」）会反复问「本站点是不是禁用了选择」，而绝大多数站点
 * 从来没禁过。结论一旦是「能选」就不再重探：`selectionDisabled()` 要建 TreeWalker
 * 并读上百次 `getComputedStyle`，而同一页里站点中途改成禁选的情形极少。
 * SPA 换页与重新加载时由调用方 `resetSelectableProbe()`。
 */
let probed = false

/** 忘掉探测结论（SPA 换页、正文换实现时调）。 */
export function resetSelectableProbe(): void {
  probed = false
}

/**
 * 必要时解锁文本选择。幂等：已经注入过、已经探过、或页面本来就能选，都返回 `false`。
 *
 * @returns 这次是否真的注入了覆盖样式
 */
export function ensureSelectable(): boolean {
  if (document.getElementById(STYLE_ID)) return false
  if (probed) return false
  probed = true
  if (!selectionDisabled(document.body)) return false

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  ;(document.head ?? document.documentElement).appendChild(style)
  return true
}
