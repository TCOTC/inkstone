/**
 * 页面上的两个浮层：划词工具条、创建失败的提示。
 *
 * 工具条三种形态（划词 / 点划线 / 扩展已脱钩）共用同一排按钮位：首格在高亮与删除之间
 * 互斥切换，所以换形态时工具条不错位。都挂在 **Shadow DOM** 里：站点 CSS 进不来，
 * 我们的样式漏不出去，浮层文本也不参与正文索引。
 *
 * 容器挂 `document.documentElement`，一律 `position: absolute` + 页面坐标，滚动时随内容走。
 * 尺寸与坐标算法只在 `toolbarMetrics.ts` / `geometry.ts` 两处，不在这里另算。
 */
import {ACCENT_COLOR, ACCENT_HOVER_COLOR} from '../shared/colors'
import {
  checkIcon,
  closeIcon,
  copyIcon,
  helpIcon,
  highlighterIcon,
  languagesIcon,
  reloadIcon,
  trashIcon
} from '../shared/icons'
import type {AiAction} from '../shared/prompt'
import {copyText} from './clipboard'
import {
  belowAnchorXY,
  readViewport,
  textTooltipXY,
  type Box,
  type SelectionBox
} from './geometry'
import {
  TOOLBAR_BUTTON_CSS,
  TOOLBAR_BOX_CSS,
  TOOLBAR_ICON,
  toolbarWidth
} from './toolbarMetrics'

/**
 * 点划线时的锚点：优先用选区；只剩光标时只取**横坐标**，纵向用这一行文字的顶边——
 * 否则一行里点高点点低，工具条会上下跳。
 */
export type AnchorTarget = {range: Range; backward: boolean} | {x: number; top: number}

export interface ToolbarHandlers {
  onHighlight: () => void
  onDelete: (id: number) => void
  /** 扩展已和本页脱钩时，工具条上的按钮改成「刷新本页」。 */
  onReload: () => void
  /** 翻译 / 解释。只在配了 AI 的划词形态与点划线形态下才有入口。 */
  onAsk: (action: AiAction) => void
}

const STYLE = `
/* 浮层配色只看**页面自己声明的颜色模式**，全是 CSS，没有 JS 采样：
   color-scheme: inherit 让宿主沿用 <html> 的 color-scheme（宿主挂在 documentElement 下），
   每个值再用 light-dark() 取亮/暗两份。于是站点声明了 color-scheme: dark（或 light dark
   且系统深色）就用深色一套，什么都没声明（计算值 normal）就用浅色一套。
   站点改 <html> 的 color-scheme（含「跟随系统」那类切换）时，浮层**立刻**跟着变，
   不需要监听、不需要重算——旧做法是弹窗那一刻采样背底元素算亮度。
   刻意**不用 prefers-color-scheme**：它只反映系统设置，站点自己的深色主题与系统无关，
   「系统浅色 + 站点深色」「系统深色 + 站点浅色」都会判错。
   自定义属性不受 all: initial 影响，所以放在 :host 上给 .toolbar / .notice 共用；
   但 color-scheme 本身会被 all 重置，必须在 all 之后重新声明。 */
:host {
  all: initial;
  color-scheme: inherit;
  --ink-surface: light-dark(#fff, #2b3038);
  --ink-fg: light-dark(#1f2328, #e6e8eb);
  --ink-icon: light-dark(#6b7280, #b3bac4);
  --ink-hover: light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .14));
  --ink-border: light-dark(rgba(0, 0, 0, .12), rgba(255, 255, 255, .18));
  --ink-danger: light-dark(#b42318, #ff8a80);
  /* 高亮按钮的悬停色要分深浅：亮金色在白底上只有 1.8:1，看不清。 */
  --ink-accent: light-dark(${ACCENT_HOVER_COLOR}, ${ACCENT_COLOR});
}
.wrap {
  position: absolute;
  z-index: 2147483647;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: var(--ink-fg);
}
/* 盒模型（尺寸、间距、内边距、边框、圆角）全部来自 toolbarMetrics.ts：
   同一组数字也在算坐标（geometry.ts），两处必须同源。
   四边留白必须相等：边框 1 + padding 2 = 3px，上下左右都是 3px，
   悬停矩形的圆角才能跟外框同心（8 − 3 = 5）。 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  overflow: hidden;
${TOOLBAR_BOX_CSS}
  background: color-mix(in srgb, var(--ink-surface) 99%, transparent);
  box-shadow: 0 2px 4px rgba(0, 0, 0, .16);
}
/* 四个按钮同一个尺寸，只换图标与悬停色。圆角与外框同心（见下文与
   toolbarMetrics 的 TOOLBAR_ITEM_RADIUS）。
   高亮是本页唯一的主操作，悬停时亮成金色（--ink-accent，深浅两套值）。 */
.mark,
.ask,
.trash,
.copy,
.refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  /* 图标的描边是 currentColor，换色只改这一行。 */
  color: var(--ink-icon);
  cursor: pointer;
${TOOLBAR_BUTTON_CSS}
}
.mark:hover { background: var(--ink-hover); color: var(--ink-accent); }
.ask:hover { background: var(--ink-hover); color: var(--ink-fg); }
.trash:hover { background: var(--ink-hover); color: var(--ink-danger); }
.copy:hover { background: var(--ink-hover); color: var(--ink-fg); }
.refresh:hover { background: var(--ink-hover); color: var(--ink-fg); }
.notice {
  max-width: 320px;
  padding: 6px 10px;
  border: 1px solid var(--ink-border);
  border-radius: 8px;
  background: var(--ink-surface);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .16);
  color: var(--ink-danger);
  white-space: pre-wrap;
  word-break: break-word;
}
.hidden { display: none; }
`

/** 提示停留时长：够读一句短话，又不至于碍事。 */
const NOTICE_MS = 3000

/** 复制成功/失败后对勾/叉停留的时长（两个图标同宽，不会让按钮跳动）。 */
const COPY_FEEDBACK_MS = 1200

export class Toolbar {
  private readonly host: HTMLElement
  private readonly root: ShadowRoot
  private readonly toolbar: HTMLElement
  private readonly highlightButton: HTMLButtonElement
  private readonly translateButton: HTMLButtonElement
  private readonly explainButton: HTMLButtonElement
  private readonly copyButton: HTMLButtonElement
  private readonly deleteButton: HTMLButtonElement
  private readonly reloadButton: HTMLButtonElement
  private readonly notice: HTMLElement
  private noticeTimer = 0
  private copyTimer = 0
  private currentId = 0
  /** 复制按钮要写进剪贴板的文本：弹出工具条那一刻就定下来（见 `showToolbar`）。 */
  private copyText = ''
  /** 复制按钮的悬停文案（还没有反馈时的那个）。两种形态含义不同。 */
  private copyHint = '复制'
  /**
   * 划词形态下是否已经配了 AI（决定要不要显示翻译/解释，以及工具条的宽度）。
   * 点划线形态同样看它。
   */
  private aiEnabled = false
  private handlers: ToolbarHandlers | null = null

  constructor() {
    this.host = document.createElement('inkstone-toolbar')
    this.root = this.host.attachShadow({mode: 'open'})

    const style = document.createElement('style')
    style.textContent = STYLE

    this.toolbar = document.createElement('div')
    this.toolbar.className = 'wrap toolbar hidden'
    // 浮层内部的事件不外泄，否则 mouseup 会把刚弹出的工具条又关掉。
    for (const type of ['mousedown', 'mouseup', 'click']) {
      this.toolbar.addEventListener(type, (event) => event.stopPropagation())
    }

    this.highlightButton = document.createElement('button')
    this.highlightButton.className = 'mark'
    this.highlightButton.type = 'button'
    this.highlightButton.append(highlighterIcon(TOOLBAR_ICON))
    this.highlightButton.title = '高亮'
    this.highlightButton.addEventListener('click', () => this.handlers?.onHighlight())

    this.translateButton = document.createElement('button')
    this.translateButton.className = 'ask hidden'
    this.translateButton.type = 'button'
    this.translateButton.append(languagesIcon(TOOLBAR_ICON))
    this.translateButton.title = '翻译选中文字'
    this.translateButton.addEventListener('click', () => this.handlers?.onAsk('translate'))

    this.explainButton = document.createElement('button')
    this.explainButton.className = 'ask hidden'
    this.explainButton.type = 'button'
    this.explainButton.append(helpIcon(TOOLBAR_ICON))
    this.explainButton.title = '解释选中文字'
    this.explainButton.addEventListener('click', () => this.handlers?.onAsk('explain'))

    this.deleteButton = document.createElement('button')
    this.deleteButton.className = 'trash hidden'
    this.deleteButton.type = 'button'
    this.deleteButton.append(trashIcon(TOOLBAR_ICON))
    this.deleteButton.title = '删除这条划线'
    this.deleteButton.addEventListener('click', () => {
      if (this.currentId) this.handlers?.onDelete(this.currentId)
    })

    this.copyButton = document.createElement('button')
    this.copyButton.className = 'copy hidden'
    this.copyButton.type = 'button'
    this.copyButton.append(copyIcon(TOOLBAR_ICON))
    this.copyButton.title = this.copyHint
    this.copyButton.addEventListener('click', () => void this.copySelection())

    this.reloadButton = document.createElement('button')
    this.reloadButton.className = 'refresh hidden'
    this.reloadButton.type = 'button'
    this.reloadButton.append(reloadIcon(TOOLBAR_ICON))
    this.reloadButton.title = 'Inkstone 已更新，点一下刷新本页'
    this.reloadButton.addEventListener('click', () => this.handlers?.onReload())

    this.toolbar.append(
      this.highlightButton,
      this.deleteButton,
      this.translateButton,
      this.explainButton,
      this.copyButton,
      this.reloadButton
    )

    this.notice = document.createElement('div')
    this.notice.className = 'wrap notice hidden'

    this.root.append(style, this.toolbar, this.notice)
    // 挂到 documentElement 而不是 body。body 的 margin / position
    // 会把绝对定位的坐标系带歪，html 才是初始包含块。
    ;(document.documentElement ?? document.body).appendChild(this.host)
  }

  bind(handlers: ToolbarHandlers): void {
    this.handlers = handlers
  }

  /**
   * 把划词工具条摆到选区旁。
   *
   * `range.getClientRects()` 给的是**视口**坐标；`textTooltipXY` 内部加上滚动量换成
   * 页面坐标，所以这里只要把选择方向传进去。
   *
   * `ai` 决定要不要带翻译与解释两个按钮。按按钮数算宽度，所以它必须在定位前定下来。
   */
  showToolbar(range: Range, backward: boolean, ai: boolean): void {
    this.currentId = 0
    this.aiEnabled = ai
    // 选区快照：点浮层会清掉页面选区，按钮真正被点到时 `getSelection()` 已经是空的。
    this.copyText = range.toString()
    this.copyHint = '复制选中文字'
    this.resetCopyButton()
    this.setMode('selection')
    this.place(selectionBox(range, backward), this.buttonCount('selection'))
  }

  hideToolbar(): void {
    this.toolbar.classList.add('hidden')
    this.currentId = 0
    this.resetCopyButton()
  }

  /** 工具条只显示当前形态要用的按钮。 */
  private setMode(mode: 'selection' | 'anchor' | 'stale'): void {
    const selection = mode === 'selection'
    const anchor = mode === 'anchor'
    /* 高亮与删除**占同一个位置**（DOM 里相邻，且永远只有一个可见），
       两种形态共用同一套左边的按钮位，工具条不会因为换了形态而错位。 */
    this.highlightButton.classList.toggle('hidden', !selection)
    this.deleteButton.classList.toggle('hidden', !anchor)
    this.translateButton.classList.toggle('hidden', !(selection || anchor) || !this.aiEnabled)
    this.explainButton.classList.toggle('hidden', !(selection || anchor) || !this.aiEnabled)
    this.copyButton.classList.toggle('hidden', mode === 'stale')
    this.reloadButton.classList.toggle('hidden', mode !== 'stale')
  }

  /** 当前形态实际显示的按钮数（决定工具条宽度）。必须与 `setMode` 完全一致。 */
  private buttonCount(mode: 'selection' | 'anchor' | 'stale'): number {
    if (mode === 'stale') return 1
    return this.aiEnabled ? 4 : 2
  }

  /**
   * 位置与划词工具条走**同一个** `place()`：划线里还留着选区就用它（带方向），
   * 只剩光标时横向跟落点、纵向跟这一行文字。
   * `text` 是整条划线原文；划线内有选区就处理那一段。
   */
  showAnchorToolbar(id: number, text: string, target: AnchorTarget, ai: boolean): void {
    this.currentId = id
    this.aiEnabled = ai
    const selected = 'range' in target ? target.range.toString() : ''
    const hasSelection = selected.trim().length > 0
    this.copyText = hasSelection ? selected : text
    this.copyHint = hasSelection ? '复制选中文字' : '复制这条划线'
    this.resetCopyButton()
    this.setMode('anchor')
    this.placeAt(target, this.buttonCount('anchor'))
  }

  /** 位置与另两种形态一致：它出现在用户刚期待「高亮」或「删除」的地方。 */
  showStaleToolbar(target: AnchorTarget): void {
    this.currentId = 0
    this.copyText = ''
    this.setMode('stale')
    this.placeAt(target, this.buttonCount('stale'))
  }

  /** 三种形态共用的锚点解析：有选区就用选区（带方向），只剩落点时横向用落点、纵向用该行文字。 */
  private placeAt(target: AnchorTarget, buttons: number): void {
    this.place(
      'range' in target
        ? selectionBox(target.range, target.backward)
        : {first: pointBox(target.x, target.top), last: pointBox(target.x, target.top), backward: false},
      buttons
    )
  }

  /**
   * 文字在**弹出工具条那一刻**就存好了：点浮层会清掉选区，到点击回调再读只会拿到空串。
   * 反馈只换图标，不弹提示——成败一眼就能看出来。
   */
  private async copySelection(): Promise<void> {
    const text = this.copyText
    if (!text) return
    const ok = await copyText(text)
    window.clearTimeout(this.copyTimer)
    this.copyButton.replaceChildren(ok ? checkIcon(TOOLBAR_ICON) : closeIcon(TOOLBAR_ICON))
    this.copyButton.title = ok ? '已复制' : '复制失败'
    this.copyButton.style.color = ok ? '' : 'var(--ink-danger)'
    this.copyTimer = window.setTimeout(() => this.resetCopyButton(), COPY_FEEDBACK_MS)
  }

  private resetCopyButton(): void {
    window.clearTimeout(this.copyTimer)
    this.copyTimer = 0
    this.copyButton.replaceChildren(copyIcon(TOOLBAR_ICON))
    this.copyButton.title = this.copyHint
    this.copyButton.style.removeProperty('color')
  }

  /** 工具条定位的唯一出口：`textTooltipXY` + 设置宽高坐标。`buttons` 是当前形态的按钮数。 */
  private place(box: SelectionBox, buttons: number): void {
    const width = toolbarWidth(buttons)
    const point = textTooltipXY(box, width, readViewport())
    this.toolbar.classList.remove('hidden')
    this.toolbar.style.width = `${width}px`
    this.toolbar.style.left = `${point.x}px`
    this.toolbar.style.top = `${point.y}px`
  }

  /**
   * 一次性提示（创建失败时用），贴在选区下方并自动消失。
   *
   * 用户刚点完高亮，视线就在选区附近；这条消息既说明「没保存」，也说明为什么。
   */
  showNotice(text: string, range: Range): void {
    this.hideToolbar()

    this.notice.textContent = text
    this.notice.classList.remove('hidden')

    const view = readViewport()
    const rect = range.getBoundingClientRect()
    /* `getBoundingClientRect` 在 `display: contents` 之类结构下会是全零，退回元素的偏移。 */
    const box: Box =
      rect.width > 0 || rect.height > 0
        ? {x: rect.left, y: rect.top, width: rect.width, height: rect.height}
        : fallbackBox(range)
    const point = belowAnchorXY(
      {x: view.sx + box.x + box.width / 2, y: view.sy + box.y + box.height + 8},
      this.notice.offsetWidth,
      this.notice.offsetHeight,
      view
    )
    this.notice.style.left = `${point.x}px`
    this.notice.style.top = `${point.y}px`

    window.clearTimeout(this.noticeTimer)
    this.noticeTimer = window.setTimeout(() => this.hideNotice(), NOTICE_MS)
  }

  hideNotice(): void {
    this.notice.classList.add('hidden')
    window.clearTimeout(this.noticeTimer)
    this.noticeTimer = 0
  }

  hideAll(): void {
    this.hideToolbar()
    this.hideNotice()
  }
}

/**
 * 选区 → 定位算法要的形状。取**首段**与**末段**的行片段（不是整段的并集：
 * `getBoundingClientRect()` 在跨行选区上给的是一个大框，位置会飘到很远）。
 */
function selectionBox(range: Range, backward: boolean): SelectionBox {
  const rects = range.getClientRects()
  const first = rects[0] ?? fallbackBox(range)
  const last = rects[rects.length - 1] ?? fallbackBox(range)
  return {first, last, backward}
}

/**
 * 零尺寸的锚点：横向是鼠标落点，纵向是这一行文字的顶边。
 * 正向分支只用到它的 `x / y`（`width` 为 0），所以 `y` 与选区首/末段的 `top` 是同一个基准。
 */
function pointBox(x: number, top: number): Box {
  return {x, y: top, width: 0, height: 0}
}

/**
 * 选区没有矩形时（极少数：`display: contents` 之类的结构）退回元素自身的偏移。
 * 兜底值取元素上边再加 21px（定值，不量字体）：这里用 `getBoundingClientRect()`
 * + 滚动量等价表达。
 */
function fallbackBox(range: Range): Box {
  const container = range.startContainer
  const element = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement
  const rect = element?.getBoundingClientRect()
  return {x: rect?.left ?? 0, y: (rect?.top ?? 0) + 21, width: 0, height: 0}
}

