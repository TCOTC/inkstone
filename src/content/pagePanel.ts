/**
 * 当前页划线列表。
 *
 * 只做一件事：**本页有哪些划线，点一条跳过去**。
 * 明确不做：宽度拖拽、钉住、缩小为迷你栏、把页面 `margin-right` 挤开、
 * 页头一串操作按钮——这些要么改站点布局，要么属于产品外壳。
 *
 * 唯一入口：**左键点工具栏图标**（background 发 `panel:toggle` 过来）。面板从右侧滑入，
 * `Esc` 或 ✕ 关闭。页面上**没有常驻按钮**——本页划线的总数显示在工具栏图标的角标上
 * （`background.ts`，含未定位的那些），页面上只保留跳转用的右侧标记点。
 *
 * 底部单独一块「未定位」：这些是正文里找不到原文的划线，页面上没有可跳转的目标，
 * 所以只列出原文与错误码，不再假装它们能点。
 */
import {stripAlpha} from '../shared/colors'
import {closeIcon} from '../shared/icons'
import {type UnresolvedItem} from '../shared/unresolved'
import {type MarkerEntry} from './markers'

export interface PagePanelHandlers {
  onPick: (id: number) => void
}

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: min(360px, 100vw - 32px);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-left: 1px solid rgba(0, 0, 0, .1);
  color: #1f2328;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  z-index: 2147483000;
  transform: translateX(100%);
  transition: transform .18s ease-out, box-shadow .18s ease-out;
}
/* 收起时面板整体移出右边界，但阴影的 -8px 偏移 + 24px 模糊仍会漏进视口，
   在页面右侧留下一条常驻阴影——所以只在打开时给。 */
.panel.open {
  transform: none;
  box-shadow: -8px 0 24px rgba(0, 0, 0, .08);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* 16px 是这里所有文字的基准线（与列表行、小节标题同一条）。 */
  padding: 14px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, .08);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.head button {
  border: 0;
  background: transparent;
  /* 图标的描边是 currentColor，换色只改这一行。 */
  color: #6b7280;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
}
.body { flex: 1; overflow-y: auto; padding: 4px 8px 12px; }
.body::-webkit-scrollbar { width: 6px; }
.body::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, .18); border-radius: 3px; }
/* 行文字落左在 16px：外层 8 + 色条 3 + 间距 5（左内边距为 0）。
   悬停底色则从 8px 开始，与基准线分开，点击区分得更宽。 */
.row {
  display: flex;
  gap: 5px;
  padding: 8px 8px 8px 0;
  border-radius: 8px;
  cursor: pointer;
}
.row:hover { background: #f3f4f6; }
.row.active { background: #eef2ff; }
.bar { flex: none; width: 3px; border-radius: 2px; }
.main { min-width: 0; flex: 1; }
.text {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.meta { margin: 3px 0 0; color: #9ca3af; font-size: 12px; }
.section {
  margin: 10px 0 2px;
  padding: 10px 8px 4px;
  border-top: 1px solid rgba(0, 0, 0, .08);
  color: #6b7280;
  font-size: 13px;
  font-weight: 600;
}
.section .tip { display: block; margin-top: 2px; font-weight: 400; }
.miss {
  padding: 8px;
  border-radius: 8px;
  background: rgba(180, 35, 24, .05);
}
.miss .text {
  color: #4b5563;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.empty { padding: 24px 8px; color: #6b7280; text-align: center; }
`

export class PagePanel {
  private readonly host: HTMLElement
  private readonly root: ShadowRoot
  private readonly panel: HTMLElement
  private readonly heading: HTMLElement
  private readonly body: HTMLElement
  private entries: MarkerEntry[] = []
  /** 本页定位失败的划线（页面上没有可跳转的目标） */
  private unresolved: UnresolvedItem[] = []
  private handlers: PagePanelHandlers | null = null
  private rows = new Map<number, HTMLElement>()
  private open = false
  /** 数据变了但面板还关着：内容先不建（关着的面板建几百行是纯浪费）。 */
  private dirty = false
  /** 关着的时候被要求高亮的行，打开面板时补上。 */
  private pendingHighlight: number | null = null

  constructor() {
    this.host = document.createElement('inkstone-panel')
    this.root = this.host.attachShadow({mode: 'open'})

    const style = document.createElement('style')
    style.textContent = STYLE

    this.panel = document.createElement('aside')
    this.panel.className = 'panel'
    const head = document.createElement('div')
    head.className = 'head'
    this.heading = document.createElement('span')
    const close = document.createElement('button')
    close.type = 'button'
    close.append(closeIcon(16))
    close.title = '关闭'
    close.addEventListener('click', () => this.hide())
    head.append(this.heading, close)

    this.body = document.createElement('div')
    this.body.className = 'body'
    this.panel.append(head, this.body)

    // 面板内部的事件不要外泄，否则会被页面的 mouseup 判定当成"点了别处"。
    for (const type of ['mousedown', 'mouseup', 'click']) {
      this.panel.addEventListener(type, (event) => event.stopPropagation())
    }

    this.root.append(style, this.panel)
    ;(document.documentElement ?? document.body).appendChild(this.host)
  }

  bind(handlers: PagePanelHandlers): void {
    this.handlers = handlers
  }

  toggle(): void {
    if (this.open) this.hide()
    else this.show()
  }

  show(): void {
    // 没有划线也允许打开：工具栏图标点过来时总要有反馈（面板里会显示「本页没有划线」）。
    this.open = true
    this.panel.classList.add('open')
    // 关着的时候 `update()` 只存了数据，内容在这里才建。
    if (this.dirty) this.renderBody()
    if (this.pendingHighlight !== null) this.applyHighlight(this.pendingHighlight)
  }

  hide(): void {
    this.open = false
    this.panel.classList.remove('open')
  }

  /**
   * 打开面板并只显示一条提示（例：扩展被关掉了）。下一次 `update()` 会换回真实内容。
   *
   * 不能让「点图标没反应」发生——那样会被当成扩展坏了。
   */
  notice(text: string): void {
    this.entries = []
    this.unresolved = []
    this.rows.clear()
    this.dirty = false
    this.body.replaceChildren(this.buildMessage(text))
    this.heading.textContent = '本页划线'
    this.show()
  }

  /**
   * 整批更新。
   *
   * `unresolved` 是正文里找不到原文的划线：单独放到底部，只列原文与错误码。
   *
   * 面板**关着**时只存数据、不建 DOM（`dirty` 留给 `show()`）：每次重定位/重画都会
   * 走到这里，而这份列表面板绝大多数时间是关着的（300 条划线 = 1200 个节点）。
   */
  update(entries: readonly MarkerEntry[], unresolved: readonly UnresolvedItem[] = []): void {
    this.entries = [...entries]
    this.unresolved = [...unresolved]
    this.dirty = true
    if (this.open) this.renderBody()
  }

  /** 真正建列表（只在面板可见时调，或在 `notice()` 里直接写 body）。 */
  private renderBody(): void {
    this.dirty = false
    this.rows.clear()
    this.body.replaceChildren()

    const total = this.entries.length + this.unresolved.length
    this.heading.textContent =
      this.entries.length > 0 ? `本页划线 · ${this.entries.length}` : '本页划线'

    if (total === 0) {
      this.body.append(this.buildMessage('本页没有划线。'))
      return
    }

    const frag = document.createDocumentFragment()
    for (const entry of this.entries) frag.append(this.buildRow(entry))
    if (this.entries.length === 0) frag.append(this.buildMessage('这一页的划线全都没能定位。'))

    if (this.unresolved.length > 0) {
      const section = document.createElement('div')
      section.className = 'section'
      section.append(document.createTextNode(`未定位 · ${this.unresolved.length}`))
      const tip = document.createElement('span')
      tip.className = 'tip'
      tip.textContent = '正文里找不到这些原文，页面上无法高亮。'
      section.append(tip)
      frag.append(section)
      for (const item of this.unresolved) frag.append(this.buildMiss(item))
    }

    this.body.append(frag)
  }

  clear(): void {
    this.update([])
  }

  /** 从外部定位时高亮对应行（点了划线的 ✕ 或列表项时）。 */
  highlight(id: number): void {
    this.pendingHighlight = id
    this.applyHighlight(id)
  }

  /** 把 `active` 类落到具体行上；行还没建（面板关着）就什么也不做，等 `show()` 补。 */
  private applyHighlight(id: number): void {
    for (const [rowId, row] of this.rows) row.classList.toggle('active', rowId === id)
    const target = this.rows.get(id)
    if (!target || !this.open) return
    // 只滚面板自己的 scrollTop：`scrollIntoView` 会把页面一起滚走。
    const list = this.body.getBoundingClientRect()
    const row = target.getBoundingClientRect()
    const delta = row.top - list.top - (this.body.clientHeight - row.height) / 2
    const max = Math.max(0, this.body.scrollHeight - this.body.clientHeight)
    this.body.scrollTop = Math.min(max, Math.max(0, this.body.scrollTop + delta))
  }

  private buildMessage(text: string): HTMLElement {
    const node = document.createElement('p')
    node.className = 'empty'
    node.textContent = text
    return node
  }

  /**
   * 一条未定位的划线。错误码不上屏（对使用者没用），只放悬停提示里供排障。
   */
  private buildMiss(item: UnresolvedItem): HTMLElement {
    const row = document.createElement('div')
    row.className = 'miss'
    row.title = `错误码 ${item.errCode}（正文里找不到原文）`

    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = item.preview || '（无文字）'

    row.append(text)
    return row
  }

  private buildRow(entry: MarkerEntry): HTMLElement {
    const row = document.createElement('div')
    row.className = 'row'
    row.dataset.id = String(entry.id)

    const bar = document.createElement('span')
    bar.className = 'bar'
    bar.style.background = stripAlpha(entry.color)

    const main = document.createElement('div')
    main.className = 'main'

    const text = document.createElement('p')
    text.className = 'text'
    text.textContent = entry.text || '（无文字）'

    main.appendChild(text)

    // 近似命中：正文被改过一两个字，位置对了但字不完全一样。标记出来，
    // 免得用户以为自己的划线被改写了。
    if (entry.approximate) {
      const tag = document.createElement('p')
      tag.className = 'meta'
      tag.textContent = '近似定位（正文已改动）'
      main.appendChild(tag)
    }

    row.append(bar, main)
    row.addEventListener('click', (event) => {
      event.stopPropagation()
      this.highlight(entry.id)
      this.handlers?.onPick(entry.id)
    })

    this.rows.set(entry.id, row)
    return row
  }
}
