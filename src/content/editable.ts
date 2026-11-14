/**
 * 「这个位置能不能划词」的判定。
 *
 * 只表达一件事：输入框、按钮、可编辑区域里不该冒出划词工具条。
 * 选区本身不需要这个判定，所以不要在渲染 / 回放路径上引用它。
 */

/** 不该弹工具条的标签名片段。保持原样，包含 `-POST` 这种带横线的片段。 */
const IGNORE_EVENT_NAMES = [
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'BUTTON',
  'SEARCH',
  'ENTRY-POINT',
  '-POST',
  'FIELDSET'
] as const

/** 向上找可编辑祖先时最多看多少层。 */
export const EDITABLE_DEPTH = 30

/**
 * 元素自身是否算「可编辑 / 不该划词」。
 *
 * 两处与直觉不同的地方，都是刻意保留的：
 * 1. 标签名匹配用的是**子串包含**，所以 `<search>`、`x-post` 这类自定义元素也会命中；
 * 2. `contentEditable` 除 `true` 外还认 `plaintext-only`。
 */
export function isEditableElement(element: Element | null): boolean {
  if (!element) return false
  if ((element as HTMLElement).isContentEditable === true) return true

  const declared = (element.getAttribute('contenteditable') ?? '').trim().toLowerCase()
  if (declared === 'true' || declared === 'plaintext-only') return true

  const name = (element.nodeName || '').toUpperCase()
  for (const ignored of IGNORE_EVENT_NAMES) {
    if (name.includes(ignored)) return true
  }
  return false
}

/** 从节点向上找可编辑祖先。 */
export function isInEditable(node: Node | null, depth = EDITABLE_DEPTH): boolean {
  let current: Node | null = node
  for (let step = 0; current && step < depth; step += 1) {
    if (current.nodeType === Node.ELEMENT_NODE && isEditableElement(current as Element)) return true
    current = current.parentNode
  }
  return false
}

/**
 * 事件是否发生在可编辑区域：只看 target 与 activeElement，**不向上走**。
 */
export function isEventInEditable(event: Event): boolean {
  const target = event.target
  if (target instanceof Element && isEditableElement(target)) return true
  const active = document.activeElement
  return active instanceof Element && isEditableElement(active)
}

/** 整个 body 处于可编辑态（contenteditable 整页编辑器）。 */
export function isPageEditable(): boolean {
  let active: Element | null = document.activeElement
  // 编辑器常把光标放在 shadow root 里，activeElement 会停在宿主上。
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active === document.body && isEditableElement(document.body)
}
