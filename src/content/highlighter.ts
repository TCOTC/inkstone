/**
 * 渲染层：把定位结果画到页面上。
 *
 * 唯一方式是 **CSS Custom Highlight API**：不给页面加节点，不干扰框架的 diff；
 * 代价是站点换掉文本节点后高亮会丢，靠 MutationObserver 重算补回。
 *
 * 三条性能约束：hover 只重设自己的高亮组；重算前先问 `isStale()`；命中检测走
 * caret API + 节点区间表，不遍历矩形。
 */
import {planGroups} from '../shared/highlightPlan'
import {stripWs} from '../shared/whitespace'
import {type HighlightRecord} from '../shared/types'
import {FUZZY_MODE, type RelocateResult} from '../shared/relocate'
import {type PenStyle} from '../shared/styles'

const STYLE_ID = 'inkstone-style'

/** `CSS.highlights` 的最小接口（TypeScript 的 lib.dom 还没有它）。 */
interface HighlightRegistry {
  keys(): IterableIterator<string>
  set(name: string, highlight: object): void
  delete(name: string): void
}

type HighlightConstructor = new (...ranges: Range[]) => object

/**
 * 两项都在才能画。拿不到时宁可什么都不画，也不去改页面 DOM。
 */
function highlightApi(): {registry: HighlightRegistry; create: HighlightConstructor} | null {
  const registry = (CSS as unknown as {highlights?: HighlightRegistry}).highlights
  const create = (globalThis as unknown as {Highlight?: HighlightConstructor}).Highlight
  return registry && typeof create === 'function' ? {registry, create} : null
}

export interface RenderItem {
  highlight: HighlightRecord
  result: RelocateResult
}

export interface RenderOptions {
  penStyle: PenStyle
  dark: boolean
}

/** 命中结果：划线 id + **落点所在那一行**的绘制矩形（视口坐标）。 */
export interface Hit {
  id: number
  rect: DOMRect
}

interface Entry {
  id: number
  /**
   * 划线原文去掉空白后的样子，用于廉价判断区间是否还有效。
   * 取自**实际的 Range**而不是记录里的 `text`：近似命中的落点文字与记录本来就差一两个字，
   * 拿记录去比对会让 `isStale()` 永远为真，每次 DOM 变动都全量重算。
   */
  expected: string
  /** 近似命中（正文被改过）——单独分组，用更淡的样式画 */
  approximate: boolean
  ranges: Range[]
}

/** 某个文本节点上的高亮区间（命中检测用）。 */
interface Interval {
  start: number
  end: number
  id: number
}

interface CachedRanges {
  /** spans 的签名（`nodeIndex:start:end` 串联） */
  sig: string
  nodes: Array<Text | undefined>
  ranges: Range[]
}

/** 一条划线的测量结果（`measure()` 的输出）。 */
export interface MeasuredItem {
  id: number
  /** 视口坐标下的上边界 */
  rectTop: number
  /** 包围盒高度 */
  rectHeight: number
  /** 起点所在的元素（用来找滚动容器祖先） */
  element: Element | null
}

/**
 * 上次测量的结果与它成立的前提：Range 还是同一批对象**且** scrollY 没变。
 * 布局真的变了（字体、图片）拿不到这个缓存，得由调用方 `invalidateMeasure()`。
 */
interface MeasuredCache {
  first: Array<Range | undefined>
  scrollY: number
  items: MeasuredItem[]
}

export class Highlighter {
  private readonly api = highlightApi()
  private readonly entries: Entry[] = []
  /** id → Entry，命中判定要拿到矩形，避免线性查找 */
  private readonly byId = new Map<number, Entry>()
  /** 文本节点 → 落在它上面的区间；命中检测不再遍历所有 Range */
  private readonly byNode = new Map<Text, Interval[]>()
  /** 已注册的高亮组：内容没变就不重设（每次 `new Highlight()` 都有成本） */
  private readonly registered = new Map<string, {ranges: Range[]; highlight: object}>()
  /** Range 复用：同一批节点上的同一段区间不重复创建 */
  private readonly rangeCache = new Map<number, CachedRanges>()
  /** 上一次 `measure()` 的结果（见 `MeasuredCache`） */
  private measured: MeasuredCache | null = null
  private options: RenderOptions | null = null
  private hoverId: number | null = null
  /** 当前挂在注册表里的 hover 组名 */
  private hoverName: string | null = null
  private styleElement: HTMLStyleElement | null = null
  private renderedStyleKey = ''

  /** 画出来的划线条数。 */
  get size(): number {
    return this.entries.length
  }

  /**
   * 站点无关的 DOM 变动（广告、评论区、懒加载）也会走到这里，而绝大多数情况下
   * 我们的节点没动。这里只花 O(划线字符数)，就能跳过整页索引重建 + 全部重定位。
   */
  isStale(): boolean {
    for (const entry of this.entries) {
      for (const range of entry.ranges) {
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) return true
        if (stripWs(range.toString()) !== entry.expected) return true
      }
    }
    return false
  }

  /** 清空所有高亮（不删除数据）。 */
  clear(): void {
    if (this.api) {
      for (const name of [...this.api.registry.keys()]) this.api.registry.delete(name)
    }
    this.registered.clear()
    this.entries.length = 0
    this.byId.clear()
    this.byNode.clear()
    this.rangeCache.clear()
    this.hoverId = null
    this.hoverName = null
  }

  /** `span.nodeIndex` 是 `nodes` 的下标，两者必须来自同一次索引。 */
  render(items: readonly RenderItem[], nodes: readonly Text[], options: RenderOptions): void {
    this.options = options
    this.entries.length = 0
    this.byId.clear()
    this.byNode.clear()

    const live = new Set<number>()
    for (const {highlight, result} of items) {
      if (result.errCode !== 0 || result.spans.length === 0) continue
      const ranges = this.rangesOf(highlight.id, result, nodes)
      if (ranges.length === 0) continue

      live.add(highlight.id)
      const entry: Entry = {
        id: highlight.id,
        expected: stripWs(ranges.map((range) => range.toString()).join('')),
        approximate: result.mode === FUZZY_MODE,
        ranges
      }
      this.entries.push(entry)
      this.byId.set(entry.id, entry)
      this.indexEntry(entry, result, nodes)
    }

    // 不在页上的划线不留在缓存里（长会话下防止无限增长）。
    for (const key of [...this.rangeCache.keys()]) if (!live.has(key)) this.rangeCache.delete(key)
    if (this.hoverId && !live.has(this.hoverId)) this.hoverId = null

    this.draw()
  }

  /** 只重设 `ink-hover` 这一组，底色分组原样保留。 */
  setHover(id: number | null): void {
    if (id === this.hoverId) return
    this.hoverId = id
    this.draw()
  }

  private draw(): void {
    const api = this.api
    const options = this.options
    if (!api || !options) return

    // 分组与样式的规则是纯函数（`shared/highlightPlan.ts`，有单测）；
    // 这里只负责把它落到注册表上。
    const plan = planGroups(this.entries, options.penStyle, {dark: options.dark}, this.hoverId)

    // 差分：内容没变的组直接复用已有的 `Highlight` 对象。
    let baseChanged = false
    for (const [name] of [...this.registered]) {
      if (plan.base.has(name) || name === this.hoverName) continue
      api.registry.delete(name)
      this.registered.delete(name)
      baseChanged = true
    }
    for (const [name, ranges] of plan.base) {
      const previous = this.registered.get(name)
      if (previous && sameRanges(previous.ranges, ranges)) continue
      const highlight = new api.create(...ranges)
      api.registry.set(name, highlight)
      this.registered.set(name, {ranges, highlight})
      baseChanged = true
    }

    const nextHover = plan.hover?.name ?? null
    if (this.hoverName && this.hoverName !== nextHover) {
      api.registry.delete(this.hoverName)
      this.registered.delete(this.hoverName)
      this.hoverName = null
    }
    if (plan.hover && nextHover) {
      const previous = this.registered.get(nextHover)
      if (baseChanged || !previous || !sameRanges(previous.ranges, plan.hover.ranges)) {
        // 先删再设：注册表按插入顺序绘制，删掉重插才能保证这一组最后画（压在底色之上）。
        api.registry.delete(nextHover)
        const highlight = new api.create(...plan.hover.ranges)
        api.registry.set(nextHover, highlight)
        this.registered.set(nextHover, {ranges: [...plan.hover.ranges], highlight})
      }
      this.hoverName = nextHover
    }

    this.applyStyle(plan.declarations)
  }

  /** 把一条划线的区间登记到文本节点上，供 `hitTest` 常数级查找。 */
  private indexEntry(entry: Entry, result: RelocateResult, nodes: readonly Text[]): void {
    for (const span of result.spans) {
      const node = nodes[span.nodeIndex]
      if (!node) continue
      const interval: Interval = {start: span.start, end: span.end, id: entry.id}
      const list = this.byNode.get(node)
      if (list) list.push(interval)
      else this.byNode.set(node, [interval])
    }
  }

  private rangesOf(id: number, result: RelocateResult, nodes: readonly Text[]): Range[] {
    const sig = result.spans.map((span) => `${span.nodeIndex}:${span.start}:${span.end}`).join(',')
    const cached = this.rangeCache.get(id)
    if (cached && cached.sig === sig && sameNodes(cached.nodes, result, nodes)) return cached.ranges

    const ranges: Range[] = []
    const used: Array<Text | undefined> = []
    for (const span of result.spans) {
      const node = nodes[span.nodeIndex]
      if (!node) continue
      const range = document.createRange()
      range.setStart(node, span.start)
      range.setEnd(node, span.end)
      if (range.collapsed) continue
      ranges.push(range)
      used.push(node)
    }
    // 有节点缺失时不入缓存，`sameNodes` 的前提（逐 span 对应）才成立。
    if (ranges.length === result.spans.length) this.rangeCache.set(id, {sig, nodes: used, ranges})
    return ranges
  }

  private applyStyle(declarations: Map<string, string>): void {
    const css = [...declarations.entries()]
      .map(([name, body]) => `::highlight(${name}){${body}}`)
      .join('\n')
    this.injectStyle(css)
  }

  private injectStyle(css: string): void {
    if (this.renderedStyleKey === css) return
    this.renderedStyleKey = css
    if (!this.styleElement) {
      this.styleElement = document.createElement('style')
      this.styleElement.id = STYLE_ID
      ;(document.head ?? document.documentElement).appendChild(this.styleElement)
    }
    this.styleElement.textContent = css
  }

  /**
   * 两步：先按光标位置查区间表取候选，再对候选做**像素校验**。
   * 第二步不能省：鼠标停在行尾空白时浏览器把光标报成「最后一个字符之后」，
   * 只靠字符下标会把划线后面的空白误判成划线本身。
   * 顺便带回命中的那一行矩形，免得调用方再量一遍。
   */
  hit(x: number, y: number): Hit | null {
    const caret = caretAt(x, y)
    if (!caret) return null
    const intervals = this.byNode.get(caret.node)
    if (!intervals) return null
    for (const interval of intervals) {
      if (caret.offset < interval.start || caret.offset > interval.end) continue
      const entry = this.byId.get(interval.id)
      if (!entry) continue
      const rect = rectAt(entry.ranges, x, y)
      if (rect) return {id: entry.id, rect}
    }
    return null
  }

  /** 只要 id 的场景（`mouseup` / hover 判定）。 */
  hitTest(x: number, y: number): number | null {
    return this.hit(x, y)?.id ?? null
  }

    /** 点划线的工具条要给 AI 取前后文与落点，而那个交互只有鼠标坐标、没有选区。 */
  rangeOf(id: number): Range | null {
    const ranges = this.byId.get(id)?.ranges
    const first = ranges?.[0]
    const last = ranges?.[ranges.length - 1]
    if (!first || !last) return null
    const range = document.createRange()
    range.setStart(first.startContainer, first.startOffset)
    range.setEnd(last.endContainer, last.endOffset)
    // 退化说明这批区间不是文档顺序（不该发生）；返回 null 好过给出一段空文字。
    return range.collapsed ? null : range
  }

  /** 提示框要把所有落点取并集，所以返回全部而不是首个。 */
  rectsOf(id: number): DOMRect[] {
    for (const entry of this.entries) {
      if (entry.id !== id) continue
      return entry.ranges.map((range) => range.getBoundingClientRect())
    }
    return []
  }

  /**
   * **布局变了就必须调**：字体替换、图片撑高不会让 Range 变、也不一定让 scrollY 变，
   * 但落点已经变了，缓存看不出来。
   */
  invalidateMeasure(): void {
    this.measured = null
  }

  /**
   * 每条只量**首个** Range（跨节点划线的后续节点不参与取点），并给出起点元素
   * （标记点要找它最近的滚动容器）。结果按 `MeasuredCache` 的前提缓存。
   */
  measure(): MeasuredItem[] {
    const scrollY = window.scrollY || 0
    const cached = this.measured
    if (
      cached &&
      cached.scrollY === scrollY &&
      cached.first.length === this.entries.length &&
      cached.first.every((range, index) => range === this.entries[index]?.ranges[0])
    ) {
      return cached.items
    }

    const items: MeasuredItem[] = []
    const first: Array<Range | undefined> = []
    for (const entry of this.entries) {
      const range = entry.ranges[0]
      first.push(range)
      if (!range) continue
      const rect = range.getBoundingClientRect()
      items.push({
        id: entry.id,
        rectTop: rect.top,
        rectHeight: rect.height,
        element: range.startContainer.parentElement
      })
    }

    this.measured = {first, scrollY, items}
    return items
  }

  /** 滚动到某条划线：`scrollIntoView({block: 'center', behavior: 'smooth'})`。 */
  scrollTo(id: number): boolean {
    for (const entry of this.entries) {
      if (entry.id !== id) continue
      const first = entry.ranges[0]
      const host = first?.startContainer.parentElement
      if (!host) return false
      host.scrollIntoView({block: 'center', behavior: 'smooth'})
      return true
    }
    return false
  }
}

/** 两个 Range 数组是否指向同一批对象（用来跳过无变化的高亮组）。 */
function sameRanges(left: readonly Range[], right: readonly Range[]): boolean {
  if (left.length !== right.length) return false
  return left.every((range, index) => range === right[index])
}

/** 缓存的节点表与本次定位的 spans 是否一一对应。 */
function sameNodes(cached: ReadonlyArray<Text | undefined>, result: RelocateResult, nodes: readonly Text[]): boolean {
  if (cached.length !== result.spans.length) return false
  for (let i = 0; i < result.spans.length; i += 1) {
    const span = result.spans[i]
    if (!span || nodes[span.nodeIndex] !== cached[i]) return false
  }
  return true
}

interface Caret {
  node: Text
  offset: number
}

/**
 * 纵向容差：`Text.getClientRects()` 给的是字体内容盒，比 `::highlight()` 涂出的背景
 * 略矮（行距那一圈）。放宽几像素，免得贴着上下边缘时 hover 反而不响应。
 * 横向不放宽——「行尾/段尾空白」的误判就靠横向严格来挡。
 */
const HIT_PAD_Y = 3

/** 坐标落在这些 Range 的哪一行绘制区域里（只要有一段命中就算），返回那一行的矩形。 */
function rectAt(ranges: readonly Range[], x: number, y: number): DOMRect | null {
  for (const range of ranges) {
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top - HIT_PAD_Y && y <= rect.bottom + HIT_PAD_Y) {
        return rect
      }
    }
  }
  return null
}

/**
 * 取鼠标位置对应的文本位置。
 *
 * `caretRangeFromPoint` 是 WebKit 遗留但 Chrome 一直支持的 API，`caretPositionFromPoint`
 * 是标准版。落点不是文本节点时返回 null（点在空隙/图片上，不算命中）。
 */
function caretAt(x: number, y: number): Caret | null {
  const byRange = (document as Document & {caretRangeFromPoint?: (x: number, y: number) => Range | null})
    .caretRangeFromPoint
  if (typeof byRange === 'function') {
    const range = byRange.call(document, x, y)
    const start = range?.startContainer
    if (range && start && start.nodeType === Node.TEXT_NODE) {
      return {node: start as Text, offset: range.startOffset}
    }
    return null
  }

  const byPosition = (
    document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => {offsetNode: Node; offset: number} | null
    }
  ).caretPositionFromPoint
  if (typeof byPosition !== 'function') return null
  const caret = byPosition.call(document, x, y)
  if (!caret || caret.offsetNode.nodeType !== Node.TEXT_NODE) return null
  return {node: caret.offsetNode as Text, offset: caret.offset}
}
