/**
 * 右侧标记点条。
 *
 * 要点（算法在 `shared/markerLayout.ts`，有单测）：
 *
 * - 每个点是 **14×3** 的圆角色条，放在 `right: 12px` 的 20×20 命中区里；
 * - 纵向位置是百分比 `rt`；
 * - **相邻重复 id 只留一个**（跨节点划线会产生多个落点）；
 * - 每条 200ms 延时收起：鼠标移到点上就弹出该点附近的划线列表，
 *   移到列表上则保持，离开列表后收起；
 * - 点圆点或列表项都会把页面滚到那条划线（`scrollIntoView({block:'center'})`）。
 */
import {stripAlpha} from '../shared/colors'
import {dedupeAdjacent, markerItemTop, markerListTop, markerPercent, type ScrollerBox} from '../shared/markerLayout'

export interface MarkerEntry {
  id: number
  /** 列表里显示的文字（划线正文的裁切版） */
  text: string
  /** 十六进制色（已按主题与槽位解析） */
  color: string
  /** 视口坐标下的上边界与高度（`Range.getBoundingClientRect()`） */
  rectTop: number
  rectHeight: number
  /** 起点所在元素，用来找最近的滚动容器祖先 */
  element: Element | null
  /** 近似命中（正文被改过），界面上要标出来 */
  approximate?: boolean
}

export interface MarkerHandlers {
  onPick: (id: number) => void
}

/** 收起延时。 */
const CLOSE_DELAY = 200

const STYLE = `
:host { all: initial; }
.layer {
  position: fixed;
  right: 12px;
  top: 0;
  bottom: 0;
  width: 20px;
  z-index: 2147483000;
  pointer-events: none;
}
.item {
  position: fixed;
  right: 12px;
  width: 20px;
  height: 20px;
  z-index: 1;
  cursor: pointer;
  pointer-events: auto;
}
.dot {
  position: absolute;
  top: calc(50% - 1.5px);
  left: calc(50% - 7px);
  width: 14px;
  height: 3px;
  border-radius: 2px;
  cursor: pointer;
  transition: .2s;
}
.item:hover .dot {
  height: 4px;
  background: #1f2328 !important;
}
.list {
  position: fixed;
  right: 40px;
  width: min(320px, calc(100vw - 60px));
  max-height: min(320px, calc(100vh - 24px));
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid rgba(0, 0, 0, .12);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(39, 43, 51, .1);
  padding: 4px;
  box-sizing: border-box;
  background: #fff;
  color: #1f2328;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  z-index: 2147483001;
}
.list::-webkit-scrollbar { width: 6px; height: 6px; }
.list::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, .18); border-radius: 3px; }
.list::-webkit-scrollbar-track { background: transparent; }
.row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.row:hover, .row.active { background: rgba(0, 0, 0, .06); }
.bar {
  flex: none;
  width: 3px;
  align-self: stretch;
  min-height: 18px;
  border-radius: 2px;
}
.text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.hidden { display: none; }
`

export class Markers {
  private readonly host: HTMLElement
  private readonly root: ShadowRoot
  private readonly layer: HTMLElement
  private readonly list: HTMLElement
  private entries: MarkerEntry[] = []
  private handlers: MarkerHandlers | null = null
  private closeTimer = 0
  /** 列表里是否有多条（渲染过程中需要重设 active 类） */
  private rows = new Map<number, HTMLElement>()
  /** id → 已建好的色条节点（每次重画复用，只改 top / 颜色） */
  private readonly nodes = new Map<number, {item: HTMLElement; dot: HTMLElement}>()
  /**
   * 元素 → 它所在的滚动容器（**只缓存元素本身，不缓存测量值**）。
   *
   * 找容器要沿祖先链逐层读 `overflow-y`，一条划线最多看 100 层；同一段落的划线
   * 共享同一个起始元素，所以按元素缓存后 300 条划线从 2700 次 `getComputedStyle`
   * 降到个位数。容器自身的 `top` / `scrollTop` / `scrollHeight` 每次重读——
   * 那些随滚动和内容变化，不能存。
   */
  private readonly scrollers = new Map<Element, Element | null>()

  constructor() {
    this.host = document.createElement('inkstone-markers')
    this.root = this.host.attachShadow({mode: 'open'})

    const style = document.createElement('style')
    style.textContent = STYLE

    this.layer = document.createElement('div')
    this.layer.className = 'layer'

    this.list = document.createElement('div')
    this.list.className = 'list hidden'
    this.list.addEventListener('mouseenter', () => this.cancelClose())
    this.list.addEventListener('mouseleave', () => this.scheduleClose())
    this.list.addEventListener('wheel', (event) => this.onWheel(event), {passive: false})

    this.root.append(style, this.layer, this.list)
    ;(document.documentElement ?? document.body).appendChild(this.host)

    // 列表在中途滚动时会偏离锚点，直接收起。
    window.addEventListener('scroll', () => this.closeList(), {passive: true})
  }

  bind(handlers: MarkerHandlers): void {
    this.handlers = handlers
  }

  /**
   * 整批更新（每次渲染后调用）。位置是百分比，滚动不变，所以不必在 scroll 里重算。
   *
   * **按 id 复用节点**：画笔 / 主题变化时 id 集合与顺序一般都没变，只有位置要重算；
   * 每次 `replaceChildren()` + 重建几百个 `div` 再挂三份监听器是白付的。
   */
  update(entries: readonly MarkerEntry[]): void {
    this.entries = dedupeAdjacent(entries)
    this.closeList()
    this.rows.clear()

    const bodyHeight = document.body ? document.body.scrollHeight || document.body.clientHeight : 0
    const scrollY = window.scrollY || 0
    const live = new Set<number>()

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]
      if (!entry) continue
      live.add(entry.id)

      let node = this.nodes.get(entry.id)
      if (!node) {
        node = this.createNode(entry.id)
        this.nodes.set(entry.id, node)
      }

      const percent = markerPercent({
        rectTop: entry.rectTop,
        rectHeight: entry.rectHeight,
        scrollY,
        bodyHeight,
        scroller: this.scrollerBox(entry.element)
      })
      node.item.style.top = markerItemTop(percent)
      node.dot.style.background = stripAlpha(entry.color)

      const at = this.layer.children[index] ?? null
      if (at !== node.item) this.layer.insertBefore(node.item, at)
    }

    // 不在页上的划线把节点也收走（长会话下防止无限增长）。
    for (const [id, node] of [...this.nodes]) {
      if (live.has(id)) continue
      node.item.remove()
      this.nodes.delete(id)
    }
  }

  /**
   * 忘掉「哪一个是滚动容器」的判定。
   *
   * 只在**真可能换容器**的时机调（`window.load`、`document.fonts.ready`）：那之后站点
   * 可能刚把正文搬进一个新的滚动区域。普通 DOM 变动（广告、评论、懒加载）不动容器，
   * 不做失效——否则缓存等于没有。
   */
  resetLayout(): void {
    this.scrollers.clear()
  }

  /** 建一个色条节点，监听器只在这里挂一次。 */
  private createNode(id: number): {item: HTMLElement; dot: HTMLElement} {
    const item = document.createElement('div')
    item.className = 'item'
    item.dataset.id = String(id)

    const dot = document.createElement('div')
    dot.className = 'dot'
    item.appendChild(dot)

    item.addEventListener('mouseenter', () => this.openList(id, item))
    item.addEventListener('mouseleave', () => this.scheduleClose())
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      this.pick(id)
    })

    return {item, dot}
  }

  /** 某个元素所在滚动容器的当前测量值（容器元素本身走缓存）。 */
  private scrollerBox(element: Element | null): ScrollerBox | null {
    if (!element) return null
    let container = this.scrollers.get(element)
    if (container === undefined) {
      container = findScroller(element)
      this.scrollers.set(element, container)
    }
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return {top: rect.top, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight}
  }

  clear(): void {
    this.entries = []
    this.rows.clear()
    this.nodes.clear()
    this.scrollers.clear()
    this.layer.replaceChildren()
    this.closeList()
  }

  /** 高亮列表里某一行（从外部定位时用）。 */
  highlight(id: number): void {
    for (const [rowId, row] of this.rows) row.classList.toggle('active', rowId === id)
  }

  private pick(id: number): void {
    this.handlers?.onPick(id)
    this.closeList()
  }

  /**
   * 弹出列表。`item` 是鼠标进入的那个圆点，用来定位。
   *
   * 定位规则：`top` 夹到 `[12, innerHeight - 12 - 列表可见高度]`；
   * 列表内容按 **id 全局去重**（不是只去相邻）。
   */
  private openList(id: number, item: HTMLElement): void {
    this.cancelClose()
    this.closeList()

    const seen = new Set<number>()
    const frag = document.createDocumentFragment()
    for (const entry of this.entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)

      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.id = String(entry.id)
      if (entry.id === id) row.classList.add('active')

      const bar = document.createElement('span')
      bar.className = 'bar'
      bar.style.background = stripAlpha(entry.color)

      const text = document.createElement('span')
      text.className = 'text'
      text.textContent = entry.text || '（无文字）'

      row.append(bar, text)
      row.addEventListener('click', (event) => {
        event.stopPropagation()
        this.pick(entry.id)
      })
      this.rows.set(entry.id, row)
      frag.appendChild(row)
    }

    this.list.replaceChildren(frag)
    this.list.classList.remove('hidden')
    this.list.scrollTop = 0

    const itemTop = item.getBoundingClientRect().top
    const top = markerListTop(itemTop, this.list.scrollHeight, window.innerHeight)
    this.list.style.top = `${top}px`

    // 当前项默认**居中**（不用 nearest：长列表里当前项常常贴在边缘看不见上下文）。
    const row = this.rows.get(id)
    if (row) this.centerRow(row)
  }

  /**
   * 把某一行滚到列表可视区**正中**。
   *
   * 不用 `scrollIntoView`：它会连带滚动所有祖先滚动容器（包括页面本身），
   * 弹个列表就把页面拽走。这里只改列表自己的 `scrollTop`。
   */
  private centerRow(row: HTMLElement): void {
    const list = this.list.getBoundingClientRect()
    const target = row.getBoundingClientRect()
    const delta = target.top - list.top - (this.list.clientHeight - target.height) / 2
    const max = Math.max(0, this.list.scrollHeight - this.list.clientHeight)
    this.list.scrollTop = Math.min(max, Math.max(0, this.list.scrollTop + delta))
  }

  private closeList(): void {
    if (this.list.classList.contains('hidden')) return
    this.list.classList.add('hidden')
    this.rows.clear()
  }

  private scheduleClose(): void {
    this.cancelClose()
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = 0
      this.closeList()
    }, CLOSE_DELAY)
  }

  private cancelClose(): void {
    if (!this.closeTimer) return
    window.clearTimeout(this.closeTimer)
    this.closeTimer = 0
  }

  /**
   * 列表内部滚轮：**中间放行**（浏览器自己滚列表），只在到顶/到底时吃掉，
   * 避免继续滚到页面上。
   *
   * 判据：`deltaY<0 && scrollTop<=0` 或 `deltaY>0 && scrollHeight-1 <= scrollTop+clientHeight`
   * 时 preventDefault。这一分支最初被写反成「中间 preventDefault」，结果滚轮完全滚不动列表、
   * 只能拖滚动条。
   */
  private onWheel(event: WheelEvent): void {
    const {scrollTop, scrollHeight, clientHeight} = this.list
    // 列表本来就不用滚（内容没超过最大高度）：放行给页面。
    // 没有这一条时，悬停短列表滚轮会完全失效（体验上是「滚不动」）。
    if (scrollHeight - clientHeight <= 1) return
    const atTop = event.deltaY < 0 && scrollTop <= 0
    const atBottom = event.deltaY > 0 && scrollHeight - 1 <= scrollTop + clientHeight
    if (atTop || atBottom) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
}

/**
 * 最近的滚动容器祖先：从**父元素**开始向上最多 100 层，
 * 撞到 `BODY` 就放弃，找到 `overflow-y` 为 `auto` / `scroll` 的就返回。
 *
 * 只返回**元素**，不读它的测量值——测量值随滚动与内容变化，由调用方每次现读。
 */
function findScroller(element: Element): Element | null {
  let current = element.parentElement
  for (let step = 0; current && step < 100; step += 1) {
    if (current === document.body) return null
    const overflowY = getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}
