/**
 * 正文索引：把 `document.body` 的文本节点拼成一条**去空白**的字符串。
 *
 * 这是整套定位算法的根：锚定与回放里的 `offset` 都是这条字符串里的下标。
 * 哪些节点参与索引、空白怎么算，只在这里定义一次。
 */

/**
 * 参与索引时被排除的标签，**按名字长度建表**（省一次遍历前缀集合）。
 * 注意 `BUTTON` 不在 6 位集合里——它的文本要参与索引，别「顺手补全」。
 */
const REJECT_TAGS: Record<number, ReadonlySet<string>> = {
  3: new Set(['IMG', 'MAP']),
  4: new Set(['AREA', 'HEAD', 'NOBR']),
  5: new Set(['STYLE', 'AUDIO', 'EMBED', 'IMAGE', 'INPUT', 'TRACK']),
  6: new Set(['SCRIPT', 'IFRAME', 'APPLET', 'CANVAS', 'OBJECT', 'SOURCE']),
  7: new Set(['PICTURE']),
  8: new Set(['NOSCRIPT', 'FRAMESET', 'PROGRESS', 'TEMPLATE', 'TEXTAREA'])
}

/** 向上最多看 12 层祖先（硬上限，再深就不算了）。 */
const MAX_ANCESTOR_DEPTH = 12

export interface TextIndexData {
  /** 参与索引的文本节点，顺序即索引顺序 */
  nodes: Text[]
  /** 这些节点的 `textContent`（原始，含空白） */
  texts: string[]
  /** 每个节点去空白后的长度 */
  lengths: number[]
  /**
   * 前缀和：`starts[i]` = 前 i 个节点的去空白长度之和，`starts.length === nodes.length + 1`。
   * 因此 `starts[0] === 0`、`starts[nodes.length] === text.length`。
   *
   * 有了它，「去空白偏移 → 第几个节点」是二分（`nodeIndexForOffset`），
   * 而不是每个调用方各自从头累加一遍。
   */
  starts: number[]
  /**
   * 每个节点所属**块级容器**的编号（同一块内的节点编号相同）。
   *
   * 它**不参与** `text` 的拼接，所以加不加都不影响任何已有偏移；只用于消歧打分时
   * 给「跨块命中」扣分——把两段话缝在一起的假命中通常跨块。
   */
  blocks: number[]
  /** 去空白文本流 */
  text: string
}

/**
 * 块级容器标签。判定只读标签名，不读 `getComputedStyle`：
 * 它只影响消歧打分，精度要求低于偏移计算，而逐节点读计算样式在建索引时太贵。
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG',
  'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
])

function isRejectTag(nodeName: string): boolean {
  const set = REJECT_TAGS[nodeName.length]
  return set ? set.has(nodeName) : false
}

function isInlineHidden(el: Element): boolean {
  const style = (el as HTMLElement).style
  if (!style) return false
  if ((style.display || '').includes('none')) return true
  return style.visibility === 'hidden'
}

/** 祖先链上有被排除的标签或行内隐藏元素就不算（判定结果按元素缓存）。 */
function rejects(el: Element, verdict: Map<Element, boolean>): boolean {
  const known = verdict.get(el)
  if (known !== undefined) return known
  const value = isRejectTag(el.nodeName) || isInlineHidden(el)
  verdict.set(el, value)
  return value
}

/** 一条文本节点是否参与索引（祖先链最多看 `MAX_ANCESTOR_DEPTH` 层）。 */
function isIndexable(node: Text, verdict: Map<Element, boolean>): boolean {
  let el: Element | null = node.parentElement
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && el; depth += 1) {
    if (rejects(el, verdict)) return false
    el = el.parentElement
  }
  return true
}

/** 按索引顺序收集参与索引的文本节点，并记下每个节点所属的块级容器编号。 */
export interface CollectedNodes {
  nodes: Text[]
  blocks: number[]
}

/**
 * 按索引顺序收集参与索引的文本节点。
 *
 * 取上下文（`prev` / `next`）必须复用这一份集合，否则上下文会跨过被排除的节点，
 * 与 `offset` 所在的坐标系不一致。
 *
 * 遍历方式与「`TreeWalker` 取 SHOW_TEXT」等价（文档顺序、同一套过滤），只是顺手记下
 * 块级容器编号：进出一个块级元素各换一次号，于是「同一块内」就等于「编号相同」。
 *
 * 性能：同一批祖先会被成百上千个文本节点共享，所以「这个元素本身是否被排除」
 * 在本次遍历内缓存，避免每个文本节点都重读 12 层 `style`。
 */
export function collectIndexableNodes(root: HTMLElement = document.body): CollectedNodes {
  const nodes: Text[] = []
  const blocks: number[] = []
  const verdict = new Map<Element, boolean>()
  let blockId = 0

  const visit = (parent: Node): void => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child as Text
        if (!isIndexable(text, verdict)) continue
        nodes.push(text)
        blocks.push(blockId)
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as Element
      const block = BLOCK_TAGS.has(element.nodeName)
      // 进出都换号：块内的节点共用新号，块外的兄弟不会与它撞号。
      if (block) blockId += 1
      visit(element)
      if (block) blockId += 1
    }
  }

  visit(root)
  return {nodes, blocks}
}

/** 建索引。`root` 默认 `document.body`。 */
export function buildTextIndex(root: HTMLElement = document.body): TextIndexData {
  const collected = collectIndexableNodes(root)
  const nodes: Text[] = []
  const texts: string[] = []
  const lengths: number[] = []
  const starts: number[] = [0]
  const blocks: number[] = []
  const parts: string[] = []

  for (let i = 0; i < collected.nodes.length; i += 1) {
    const textNode = collected.nodes[i]
    if (!textNode) continue
    const raw = textNode.textContent ?? ''
    const stripped = raw.replace(/\s/g, '')
    // 空节点整个跳过：它的长度为 0，留着只会让 `starts` 出现重复值。
    if (stripped.length === 0) continue
    nodes.push(textNode)
    texts.push(raw)
    lengths.push(stripped.length)
    blocks.push(collected.blocks[i] ?? 0)
    starts.push((starts[starts.length - 1] ?? 0) + stripped.length)
    parts.push(stripped)
  }

  return {nodes, texts, lengths, starts, blocks, text: parts.join('')}
}

/**
 * 去空白偏移 → 文本节点下标（在 `starts` 上二分）。
 *
 * 返回「起点不超过 `offset` 的最后一个节点」，所以偏移落在两节点交界处时归**前**一个节点，
 * 与 `mapToSpans` 的切分口径一致。空索引或负偏移返回 -1。
 */
export function nodeIndexForOffset(starts: readonly number[], offset: number): number {
  const count = starts.length - 1
  if (count <= 0 || offset < 0) return -1
  let low = 0
  let high = count - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((starts[mid] ?? 0) <= offset) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * 定位算法用到的最小索引接口。`PageTextIndex` 是它的生产实现；测试可以用一份纯文本替身，
 * 从而不必造 DOM 就能验证降级顺序。
 */
export interface IndexLike {
  indexData(): TextIndexData
  hasText(): boolean
  indexOf(needle: string, from?: number): number
  freshIndexOf(needle: string): number
  countCappedAt2(needle: string): {count: number; startOffset: number}
  rebuild(): void
}

/**
 * 正文索引单例。一页一个实例，`rebuild()` 丢弃并按需重建。
 */
export class PageTextIndex implements IndexLike {
  private data: TextIndexData | null = null
  private readonly root: () => HTMLElement

  constructor(root: () => HTMLElement = () => document.body) {
    this.root = root
  }

  /** 当前索引内容；未建过时按需构建。 */
  indexData(): TextIndexData {
    if (!this.data) this.data = buildTextIndex(this.root())
    return this.data
  }

  /** 重建索引。 */
  rebuild(): void {
    this.data = buildTextIndex(this.root())
  }

  hasText(): boolean {
    return this.indexData().nodes.length > 0
  }

  /** `indexOf`，调用方负责先剥离空白。 */
  indexOf(needle: string, from = 0): number {
    return needle ? this.indexData().text.indexOf(needle, from) : -1
  }

  /** 先查，查不到就重建索引再查一次（正文可能是后加载的）。 */
  freshIndexOf(needle: string): number {
    const hit = this.indexOf(needle)
    if (hit >= 0) return hit
    this.rebuild()
    return this.indexOf(needle)
  }

  /**
   * 数 `needle` 出现次数，**数到 2 就停**（只需知道是否唯一），
   * 同时返回第一次出现的位置。比较前两边都剥离空白。
   */
  countCappedAt2(needle: string): {count: number; startOffset: number} {
    const text = this.indexData().text
    const first = text.indexOf(needle)
    if (first < 0) return {count: 0, startOffset: -1}
    const second = text.indexOf(needle, first + 1)
    return {count: second < 0 ? 1 : 2, startOffset: first}
  }
}
