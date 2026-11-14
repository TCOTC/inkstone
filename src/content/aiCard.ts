/**
 * AI 结果卡片。一个浮层，翻译 / 解释 / 出错提示三种形态共用。
 *
 * 内容只做纯文本：模型输出是外部输入，`innerHTML` 一律不用。
 * 增量合并用 `setTimeout` 而**不是 rAF**——后者在后台标签页里根本不触发。
 * 滚动位置完全交给用户，任何一步都不写 `scrollTop`。
 */
import {ACCENT_COLOR, ACCENT_HOVER_COLOR} from '../shared/colors'
import type {AiSource, AiUsage} from '../shared/ai'
import {
  AI_ACTION_LABEL,
  AI_TARGET_LANGUAGES,
  AUTO_LANGUAGE,
  autoTarget,
  resolveTarget,
  type AiAction
} from '../shared/prompt'
import {checkIcon, closeIcon, copyIcon, pinIcon, reloadIcon, unpinIcon} from '../shared/icons'
import {safeHref} from '../shared/markdown'
import {hostOf} from '../shared/url'
import {copyText} from './clipboard'
import {belowAnchorXY, clampToViewport, readViewport, type Box, type Point} from './geometry'
import {prepareMarkdown} from './markdownRender'

export type AiCardState = 'loading' | 'streaming' | 'done' | 'error'

export interface AiCardHandlers {
  /** 用户点了「重试」。 */
  onRetry: () => void
  /** 用户点了「去设置」（未配置 Key 时）。 */
  onOpenSettings: () => void
  /** 用户换了目标语言。卡片自己不改文案，重新发起请求由调用方负责。 */
  onRetranslate: (lang: string) => void
  /** 钉住状态变了（拖一下会钉住，按钮也能切）。调用方用它维护「哪几张还活着」。 */
  onPinnedChange: (pinned: boolean) => void
}

const COPY_FEEDBACK_MS = 1200

/**
 * 增量合并的间隔。不用 rAF：后台标签页里它不触发，DOM 会停在「正在理解…」。
 * `setTimeout` 在后台会被节流到约 1s，但仍然会跑。
 */
const RENDER_INTERVAL_MS = 30

// 卡片尺寸与间距（像素）。
const CARD_WIDTH = 340
const CARD_GAP = 10
const EDGE_MARGIN = 8
/** 小于这个位移算「点了一下头部」，不算拖动（否则会意外钉住）。 */
const DRAG_THRESHOLD_PX = 3

// 同锚点上多张卡片的阶梯偏移。
const CASCADE_STEP = 18
const CASCADE_MAX = 6

/** 卡窄，列太长会把正文挤没。 */
const MAX_SOURCES = 8

/**
 * 加载占位：「正在理解」后面跟 1~3 个点循环。用定时器而不是 CSS 动画，
 * 因为要改的是文本内容，CSS 改不了。
 */
const LOADING_LABEL = '正在理解'
const LOADING_DOTS_MS = 400
const LOADING_MAX_DOTS = 3

/**
 * 来源必须是**绝对** http / https：相对地址填进 `href` 会按当前页面解析，指到别处。
 */
function sourceHref(raw: string): string | null {
  const safe = safeHref(raw)
  if (!safe) return null
  try {
    const url = new URL(safe)
    return url.protocol === 'https:' || url.protocol === 'http:' ? safe : null
  } catch {
    return null
  }
}

const STYLE = `
/* 浮层配色只看**页面自己声明的颜色模式**，全是 CSS，没有 JS 采样：
   color-scheme: inherit 让宿主沿用 <html> 的 color-scheme（宿主挂在 documentElement 下），
   每个值再用 light-dark() 取亮/暗两份。于是站点声明了 color-scheme: dark（或 light dark
   且系统深色）就用深色一套，什么都没声明（计算值 normal）就用浅色一套。
   站点改 <html> 的 color-scheme 时，卡片**立刻**跟着变——卡片常驻在正文旁边，
   旧做法「弹出那一刻采样背底」在这种情形下只能等下次打开才更新。
   刻意**不用 prefers-color-scheme**：它只反映系统设置，站点自己的深色主题与系统无关，
   「系统浅色 + 站点深色」「系统深色 + 站点浅色」都会判错。
   自定义属性不受 all: initial 影响，所以放在 :host 上；但 color-scheme 本身会被 all
   重置，必须在 all 之后重新声明。 */
:host {
  all: initial;
  color-scheme: inherit;
  --ink-surface: light-dark(#fff, #2b3038);
  --ink-fg: light-dark(#1f2328, #e6e8eb);
  --ink-muted: light-dark(#6b7280, #9aa3ae);
  --ink-border: light-dark(rgba(0, 0, 0, .12), rgba(255, 255, 255, .18));
  --ink-hover: light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .14));
  --ink-danger: light-dark(#b42318, #ff8a80);
  --ink-accent: light-dark(${ACCENT_HOVER_COLOR}, ${ACCENT_COLOR});
}
.card {
  position: absolute;
  z-index: 2147483646;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  border: 1px solid var(--ink-border);
  border-radius: 10px;
  background: var(--ink-surface);
  /* 阴影只做「浮起来一点点」的分隔，别摊成一大片——卡片常驻在正文旁边，
     压得太重会把底下那行字盖得看不清。 */
  box-shadow: 0 2px 8px rgba(0, 0, 0, .12);
  color: var(--ink-fg);
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 上下留白**对称且很小**：整条头就是拖拽区，上面再垫一截空白等于白白吃掉可拖动面积。
     刻意不用 min-height——那会让上下留白失衡（内容居中，底部多出来的都算 padding）。 */
  padding: 6px 10px;
  font-size: 12px;
  color: var(--ink-muted);
  /* 整条头可拖：光标给出了可抓手感。 */
  cursor: grab;
  user-select: none;
  touch-action: none;
}
/* 拖动中：整卡禁选、指针跟手，光标改成抓握。
   will-change 提前把卡片提到独立图层，transform 变化只走合成器。 */
.dragging { cursor: grabbing; will-change: transform; }
.dragging .head { cursor: grabbing; }
.dragging, .dragging * { user-select: none; }
/* 头部的可交互元素：不能让它们变成拖拽起点，否则点一下就被当成拖动。 */
.head select,
.head button {
  cursor: pointer;
  user-select: none;
}
/* 标题后面是一段**纯占位**：它把下拉框与图钉顶到右边。
   这里以前放过「→ 英语（自动）」那种副标题，现在目标语言只由右侧下拉表达，
   同一件事不再写两处。 */
.title { font-weight: 600; color: var(--ink-fg); }
.head .spacer { flex: 1; min-width: 0; }
/* 卡片里的语言下拉：只有翻译时显示。宽度自适应，样式全自己写——
   Shadow DOM 里拿不到站点的 select 样式，也不该拿。
   外面包一层是为了把「翻译为」与下拉绑成一组：显示/隐藏只切这一层。 */
.lang-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
/* 下拉前面的说明小字。只是标签，不参与拖拽判定，也不该被选中。 */
.lang-label {
  color: var(--ink-muted);
  font-size: 11px;
  white-space: nowrap;
  user-select: none;
}
.lang {
  flex: none;
  max-width: 132px;
  height: 20px;
  padding: 0 2px;
  border: 1px solid var(--ink-border);
  border-radius: 4px;
  background: var(--ink-surface);
  color: var(--ink-fg);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.lang:focus-visible { outline: 1px solid var(--ink-accent); outline-offset: 1px; }
.head button {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  padding: 0;
}
.head button:hover { background: var(--ink-hover); color: var(--ink-fg); }
/* 已钉住时，钉住按钮保持「激活」外观——它是状态指示，不只是动作按钮。 */
.head button.pinned { color: var(--ink-accent); }
.head button.pinned:hover { color: var(--ink-accent); }
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 上下内边距交给相邻的块：上面是 .head 的 padding-bottom、下面是 .foot 的 padding-top。
     foot 收起时中间没人补，所以下面那条规则给 body 自己补 6px（见后）。 */
  padding: 0 10px;
  word-break: break-word;
  user-select: text;
}
/* foot 没显示时（加载 / 流式中）它不贡献任何留白，正文会贴着卡片圆角底边，
   所以这时由 body 自己补一段。用 card 上的 footless 类而不是 :has 选择器：
   两个类由 setFootShown 一次性同步，改状态仍只有一处入口。 */
.card.footless .body { padding-bottom: 6px; }
.body::-webkit-scrollbar { width: 6px; }
.body::-webkit-scrollbar-thumb { background: var(--ink-border); border-radius: 3px; }
/*
 * 正文顶部那条「引述」：把用户选中的原文放回去，让人不用回头看页面就知道这张卡片在
 * 解释/翻译什么。
 *
 * **只占一行**：选区可能是一整段，铺开会把真正的回答挤到需要滚动才能看到。
 * 超出宽度就截断（text-overflow: ellipsis），完整原文在 title 属性里，悬停可看。
 * 用 nowrap + hidden 而不是 -webkit-line-clamp: 1：后者要求 display: -webkit-box，
 * 会把换行符也当成可折行的地方，单行场景反而不如直接不折。
 */
.quote {
  display: block;
  margin: 0 0 8px;
  padding: 2px 0 2px 8px;
  border-left: 3px solid var(--ink-border);
  color: var(--ink-muted);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* 引述是「引用」，不该被当成正文选中，否则复制时会把它一起带上。 */
  user-select: none;
}
.content.error { color: var(--ink-danger); }
/* 纯文本占位（「正在理解…」、错误消息）：Markdown 渲染后不再有 pre-wrap，
   这几处要自己保住换行。 */
.body .plain { white-space: pre-wrap; }
/* Markdown 排版：块间距收紧一点，卡片窄，默认的 1em 上下留白太散。 */
.body p { margin: 0 0 8px; }
.body p:last-child { margin-bottom: 0; }
.body h1, .body h2, .body h3, .body h4, .body h5, .body h6 {
  margin: 12px 0 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.body h1:first-child, .body h2:first-child, .body h3:first-child { margin-top: 0; }
.body ul, .body ol { margin: 0 0 8px; padding-left: 20px; }
.body li { margin: 2px 0; }
.body li > ul, .body li > ol { margin: 2px 0; }
.body blockquote {
  margin: 0 0 8px;
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--ink-border);
  color: var(--ink-muted);
}
.body hr {
  margin: 10px 0;
  border: 0;
  border-top: 1px solid var(--ink-border);
}
.body code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--ink-hover);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
.body pre {
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid var(--ink-border);
  border-radius: 6px;
  background: var(--ink-hover);
  overflow-x: auto;
}
/* pre 里的 code 不再套底色与内边距：外层已经有框了。 */
.body pre code {
  padding: 0;
  background: transparent;
  font-size: 12px;
  white-space: pre;
}
.body a { color: var(--ink-accent); text-decoration: underline; }
.body table { border-collapse: collapse; width: 100%; font-size: 12px; }
.body .table { overflow-x: auto; margin: 0 0 8px; }
.body th, .body td {
  padding: 4px 8px;
  border: 1px solid var(--ink-border);
  text-align: left;
}
.body th { background: var(--ink-hover); font-weight: 600; }
/*
 * 联网搜索的来源列表。模型真搜过才有，所以默认是 hidden。
 * 放在 .content 的**外面**：正文每次增量都 replaceChildren，来源若在里面会被抹掉。
 * 标题只展示不能用颜色表达的东西，所以这里只用“来源”两个字，不用图标。
 */
.sources {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--ink-border);
  color: var(--ink-muted);
  font-size: 11px;
  line-height: 1.5;
}
.sources .caption { margin: 0 0 2px; }
.sources ol { margin: 0; padding-left: 18px; }
.sources li { margin: 0 0 2px; }
.sources a { color: var(--ink-accent); text-decoration: none; word-break: break-all; }
.sources a:hover { text-decoration: underline; }
/*
 * 底部按钮条。**输出结束后才出现**（元素一开始就带着 hidden）：加载中按钮全被隐藏，
 * 只剩内边距与一排空位，白占一截高度还显得卡片底部发空。
 * 代价是结束时卡片会长高约 30px，所以 revealFoot 会按新高度重新钳一次位置。
 * 也正因为不再是「常驻的条」，上下不再用分隔线：它只跟正文之间留一点白。
 */
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
}
.foot button {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ink-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.foot button:hover { background: var(--ink-hover); color: var(--ink-fg); }
.foot .accent:hover { color: var(--ink-accent); }
.foot .spacer { flex: 1; }
/* 右下角的 token 用量。不换行、不参与挤压（flex: none），否则长数字会把按钮挤扁；
   等宽数字让「重试」前后两个数位的宽度不跳。 */
.foot .usage {
  flex: none;
  color: var(--ink-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
}
.hidden { display: none !important; }
`

export class AiCard {
  private readonly host: HTMLElement
  private readonly root: ShadowRoot
  private readonly card: HTMLElement
  private readonly title: HTMLElement
  /** 标题与右侧控件之间的占位（不显示文字）。 */
  private readonly headSpacer: HTMLElement
  private readonly langSelect: HTMLSelectElement
  /** 「翻译为」小字 + 语言下拉。两者一起显示 / 隐藏，所以包成一层。 */
  private readonly langGroup: HTMLElement
  /** 滚动容器。里面是「引述 + 内容」两层。 */
  private readonly body: HTMLElement
  /** 正文顶部那条引述（选中的原文，单行截断）。 */
  private readonly quote: HTMLElement
  /** 真正变动的那层：Markdown / 占位 / 错误都换它的子节点，引述不受影响。 */
  private readonly content: HTMLElement
  /** 联网搜索的来源。与 `.content` 分开，否则每次增量重渲染都会把它抹掉。 */
  private readonly sources: HTMLElement
  /** 底部按钮条。**输出结束后才出现**（见 `revealFoot()`）。 */
  private readonly foot: HTMLElement
  private readonly copyButton: HTMLButtonElement
  private readonly retryButton: HTMLButtonElement
  private readonly settingsButton: HTMLButtonElement
  /** 右下角的 token 用量。只在拿到 `usage` 之后显示。 */
  private readonly usageLabel: HTMLElement
  /** 右上角的钉住 / 取消钉住按钮（**没有单独的关闭按钮**）。 */
  private readonly pinButton: HTMLButtonElement
  private readonly head: HTMLElement

  private handlers: AiCardHandlers | null = null
  /** 已收到的正文。增量都进这里，DOM 只在下一帧同步一次。 */
  private buffer = ''
  /** 待执行的那次渲染（`setTimeout` 句柄；0 表示没有排队）。 */
  private frame = 0
  private copyTimer = 0
  /** 加载占位的点动画（`setInterval` 句柄；0 表示没在跑）。 */
  private dotsTimer = 0
  private state: AiCardState = 'loading'
  /** 卡片左上角的页面坐标。定位过就一直用它，重试 / 换语言不能跳位置。 */
  private position: Point | null = null
  /** 没钉住时点卡片外面就会被收起。 */
  private pinned = false

  constructor() {
    this.host = document.createElement('inkstone-ai')
    this.root = this.host.attachShadow({mode: 'open'})

    const style = document.createElement('style')
    style.textContent = STYLE

    this.card = document.createElement('div')
    this.card.className = 'card hidden'
    // 浮层内部事件不外泄，否则 mouseup 会把刚弹出的东西又关掉。
    for (const type of ['mousedown', 'mouseup', 'click']) {
      this.card.addEventListener(type, (event) => event.stopPropagation())
    }

    this.title = document.createElement('span')
    this.title.className = 'title'
    this.headSpacer = document.createElement('span')
    this.headSpacer.className = 'spacer'

    this.langSelect = document.createElement('select')
    this.langSelect.className = 'lang'
    this.langSelect.title = '目标语言'
    // 选项里**没有「自动」**：设置里的 `auto` 在 `show()` 里先按原文解析成具体语言，
    // 用户一打开下拉就看到「这次会译成什么」，要改直接选（见 `setTargetLang()`）。
    for (const item of AI_TARGET_LANGUAGES) {
      const option = document.createElement('option')
      option.value = item.code
      option.textContent = item.name
      this.langSelect.append(option)
    }
    this.langSelect.addEventListener('change', () => {
      this.handlers?.onRetranslate(this.langSelect.value)
    })
    this.langGroup = document.createElement('span')
    this.langGroup.className = 'lang-group hidden'
    const langLabel = document.createElement('span')
    langLabel.className = 'lang-label'
    langLabel.textContent = '翻译为'
    this.langGroup.append(langLabel, this.langSelect)

    this.pinButton = document.createElement('button')
    this.pinButton.type = 'button'
    this.pinButton.addEventListener('click', () => this.setPinned(!this.pinned))

    this.head = document.createElement('div')
    this.head.className = 'head'
    this.head.append(this.title, this.headSpacer, this.langGroup, this.pinButton)
    this.head.addEventListener('pointerdown', (event) => this.startDrag(event))

    this.body = document.createElement('div')
    this.body.className = 'body'

    this.quote = document.createElement('blockquote')
    this.quote.className = 'quote hidden'

    // **分成两层是必须的**：正文每次增量都整体重渲染（`replaceChildren`），
    // 引述放在同一层会被一起抹掉。来源列表同理，放在第三层。
    this.content = document.createElement('div')
    this.content.className = 'content'
    this.sources = document.createElement('div')
    this.sources.className = 'sources hidden'
    this.body.append(this.quote, this.content, this.sources)

    this.copyButton = this.button('复制', copyIcon(13), () => void this.copyAll())
    this.copyButton.title = '复制原始 Markdown'
    this.retryButton = this.button('重试', reloadIcon(13), () => this.handlers?.onRetry())
    this.settingsButton = this.button('去设置', null, () => this.handlers?.onOpenSettings())
    this.copyButton.classList.add('accent')

    const spacer = document.createElement('div')
    spacer.className = 'spacer'
    this.usageLabel = document.createElement('span')
    this.usageLabel.className = 'usage hidden'
    this.foot = document.createElement('div')
    this.foot.className = 'foot hidden'
    this.foot.append(this.retryButton, this.copyButton, this.settingsButton, spacer, this.usageLabel)

    this.card.append(this.head, this.body, this.foot)
    this.root.append(style, this.card)
    ;(document.documentElement ?? document.body).appendChild(this.host)
    // 初始形态是「还没输出完」：底部条藏着，正文自己补底边距。
    this.setFootShown(false)
    this.setPinned(false)
  }

  /**
   * 两个类必须一起改：`hidden` 决定占不占位，`footless` 决定 body 要不要自己补底边距。
   * 只留这一处入口，别在外面单独动 foot 的 hidden。
   */
  private setFootShown(shown: boolean): void {
    this.foot.classList.toggle('hidden', !shown)
    this.card.classList.toggle('footless', !shown)
  }

  private button(label: string, icon: SVGElement | null, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    if (icon) button.append(icon)
    button.append(document.createTextNode(label))
    button.addEventListener('click', onClick)
    return button
  }

  bind(handlers: AiCardHandlers): void {
    this.handlers = handlers
  }

  /** 取消钉住只是让它重新变得可关闭，不是立刻关掉自己。 */
  setPinned(pinned: boolean): void {
    const changed = this.pinned !== pinned
    this.pinned = pinned
    this.pinButton.replaceChildren(pinned ? unpinIcon(13) : pinIcon(13))
    this.pinButton.title = pinned ? '取消钉住（之后点卡片外会关闭）' : '钉住（点卡片外不关闭）'
    this.pinButton.classList.toggle('pinned', pinned)
    this.card.classList.toggle('pinned', pinned)
    if (changed) this.handlers?.onPinnedChange(pinned)
  }

  get isPinned(): boolean {
    return this.pinned
  }

  /**
   * 下拉里没有「自动」项，所以先把 `auto` 解析成具体语言。
   * 写进 `select.value` 的认不得的值会让浏览器清空选中项，显示与实际请求不一致。
   */
  private setTargetLang(lang: string, text: string): void {
    const code = resolveTarget(lang, text)
    this.langSelect.value = AI_TARGET_LANGUAGES.some((item) => item.code === code)
      ? code
      : autoTarget(text)
  }

  /**
   * 打开并定位。`anchor` 是选区首段矩形（视口坐标）。
   * `keepPosition` 用于重试 / 换语言：同一个选区上卡片不能跳位置。
   * `cascade` 是同锚点上已有的卡片数：不错开的话新卡会把旧卡完全盖住。
   * `text` 是选中原文，以单行引述显示。
   */
  show(
    action: AiAction,
    anchor: Box,
    options: {
      lang?: string
      keepPosition?: boolean
      cascade?: number
      text?: string
    } = {}
  ): void {
    this.cancelFrame()
    this.buffer = ''
    this.state = 'loading'
    this.title.textContent = AI_ACTION_LABEL[action]
    // 语言下拉只在翻译上有意义；解释跟着原文语言走，给个下拉框反而误导。
    this.langGroup.classList.toggle('hidden', action !== 'translate')
    // 下拉里没有「自动」项：设置里存的 `auto` 先按原文解析成具体语言再选中。
    this.setTargetLang(options.lang ?? AUTO_LANGUAGE, options.text ?? '')
    this.content.className = 'content'
    // 上一次拖拽可能在 transform 上留了位移；不清掉的话新位置会再偏一次。
    this.card.style.transform = ''
    this.setQuote(options.text ?? '')
    this.setSources([])
    // 上一轮的用量不能留在新卡片上：它属于上一次请求，重试 / 换语言后会再填。
    this.setUsage(undefined)
    this.showLoading()
    this.copyButton.classList.add('hidden')
    this.retryButton.classList.add('hidden')
    this.settingsButton.classList.add('hidden')
    // 上一轮结束才出现过的那条按钮栏要重新藏起来：这一轮还在加载，没东西可点。
    this.setFootShown(false)
    this.card.classList.remove('hidden')
    if (!options.keepPosition) this.position = null
    this.place(anchor, options.cascade ?? 0)
    this.resetCopy()
  }

  /**
   * 首条**同步写**：后台标签页里定时器会被节流到约 1s，等它会一直停在「正在理解…」。
   */
  append(text: string): void {
    if (!text) return
    const first = this.buffer === ''
    this.buffer += text
    this.state = 'streaming'
    if (first) this.renderBody()
    if (this.frame) return
    this.frame = window.setTimeout(() => {
      this.frame = 0
      this.renderBody()
    }, RENDER_INTERVAL_MS)
  }

  /**
   * 搜索次数取自 `usage.server_tool_use`：它比「有没有来源」更准——搜了但没搜到结果时
   * 没有引用、却有计数，这两种情况必须能分开。
   */
  finish(usage?: AiUsage, sources?: AiSource[]): void {
    this.setSources(sources ?? [], usage)
    this.setUsage(usage)
    this.flush()
    this.state = 'done'
    this.copyButton.classList.toggle('hidden', this.buffer.length === 0)
    this.retryButton.classList.remove('hidden')
    this.settingsButton.classList.add('hidden')
    this.revealFoot()
  }

  /**
   * `no-key` / `auth` 时把「重试」换成「去设置」：重试必然还是同一个错误。
   * 已收到的正文仍按 Markdown 渲染，错误说明接在后面。
   */
  fail(message: string, kind: 'no-key' | 'auth' | 'network' | 'aborted' | 'unknown'): void {
    this.flush()
    this.state = 'error'
    const hasText = this.buffer.length > 0
    this.content.className = hasText ? 'content' : 'content error'
    if (hasText) {
      // 不再调 renderBody()：flush() 刚刚已经渲染过了（buffer 非空就走那一支），
      // 这里只要把错误说明接在它后面。多调一次等于白做一遍全量重解析。
      const note = document.createElement('p')
      note.className = 'plain'
      note.textContent = message
      // 只有在没有正文时才用危险色；有正文时那只是一句尾巴，用强调色太吵。
      note.style.color = 'var(--ink-muted)'
      this.content.append(note)
    } else {
      this.setPlainText(message, true)
    }
    const needsSetup = kind === 'no-key' || kind === 'auth'
    this.retryButton.classList.toggle('hidden', needsSetup)
    this.settingsButton.classList.toggle('hidden', !needsSetup)
    this.copyButton.classList.toggle('hidden', !hasText)
    this.revealFoot()
  }

  /**
   * 结束时卡片会长高约 30px，所以要按新高度再钳一次；位置没变就别写 style，否则会跳。
   */
  private revealFoot(): void {
    this.setFootShown(true)
    if (!this.position) return
    const view = readViewport()
    const maxHeight = Math.round(view.vh * 0.6)
    const height = Math.min(this.card.offsetHeight || 160, maxHeight)
    const next = clampToViewport(this.position, CARD_WIDTH, height, EDGE_MARGIN, view)
    if (next.x === this.position.x && next.y === this.position.y) return
    this.position = next
    this.applyPosition(next)
  }

  /** 每次整段重解析：未闭合的标记只有看完整段才能正确闭合。不碰滚动位置。 */
  private renderBody(): void {
    // 正文一到位，加载占位的定时器必须停，否则会一直往已摘除的节点写字。
    this.stopDots()
    const {fragment} = prepareMarkdown(this.buffer)
    this.content.replaceChildren(fragment)
  }

  /** 不走 Markdown 的纯文本内容（占位、错误），保住换行。 */
  private setPlainText(text: string, danger: boolean): void {
    this.stopDots()
    const span = document.createElement('div')
    span.className = 'plain'
    span.textContent = text
    if (danger) span.style.color = 'var(--ink-danger)'
    this.content.replaceChildren(span)
  }

  /** `prefers-reduced-motion` 时不动，直接写满三个点。 */
  private showLoading(): void {
    this.stopDots()
    const row = document.createElement('div')
    row.className = 'plain'
    row.append(document.createTextNode(LOADING_LABEL))
    const dots = document.createElement('span')
    dots.className = 'dots'
    row.append(dots)
    this.content.replaceChildren(row)

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      dots.textContent = '.'.repeat(LOADING_MAX_DOTS)
      return
    }

    // 点数是这一串动画的**局部状态**：卡片上没有任何别的地方要读它，
    // 做成字段只会多出「谁负责重置」这个问题。
    let count = 1
    dots.textContent = '.'
    this.dotsTimer = window.setInterval(() => {
      count = (count % LOADING_MAX_DOTS) + 1
      dots.textContent = '.'.repeat(count)
    }, LOADING_DOTS_MS)
  }

  /** 停掉加载占位的点动画。可重入：没在跑时直接返回。 */
  private stopDots(): void {
    if (this.dotsTimer) window.clearInterval(this.dotsTimer)
    this.dotsTimer = 0
  }

  /**
   * 只占一行，所以换行与连续空白折成单个空格（否则截断位置很怪）；完整原文放 `title`。
   */
  private setQuote(text: string): void {
    const flat = text.replace(/\s+/g, ' ').trim()
    this.quote.textContent = flat
    this.quote.title = flat
    this.quote.classList.toggle('hidden', flat === '')
  }

  /**
   * 同 URL 只列一次；**搜了但没拿到来源也要写出来**——那种情况没有引用、却有计数，
   * 不写就会被当成「根本没联网」。
   */
  private setSources(sources: AiSource[], usage?: AiUsage): void {
    const items: {href: string; title: string}[] = []
    const seen = new Set<string>()
    for (const source of sources) {
      const href = sourceHref(source.url)
      if (!href || seen.has(href)) continue
      seen.add(href)
      const title = source.title.trim()
      // 标题为空的链接拿主机名顶上（`hostOf` 与「我的划线」同一口径），
      // 否则一排链接谁是谁看不出来。
      items.push({href, title: title || hostOf(href) || href})
      if (items.length >= MAX_SOURCES) break
    }

    this.sources.replaceChildren()
    this.sources.classList.toggle('hidden', items.length === 0)

    const caption = document.createElement('p')
    caption.className = 'caption'
    if (items.length === 0) {
      const attempts = (usage?.searches ?? 0) + (usage?.fetches ?? 0)
      if (attempts === 0) return
      caption.textContent = `已联网搜索 ${attempts} 次，但没有取得可引用的来源`
      this.sources.append(caption)
      this.sources.classList.remove('hidden')
      return
    }

    caption.textContent = '来源'
    const list = document.createElement('ol')
    for (const item of items) {
      const link = document.createElement('a')
      link.href = item.href
      link.textContent = item.title
      link.title = item.href
      link.target = '_blank'
      link.rel = 'noreferrer'
      const row = document.createElement('li')
      row.append(link)
      list.append(row)
    }
    this.sources.append(caption, list)
  }

  /** 没有用量时整个隐藏，不留一个「0 + 0 tokens」。 */
  private setUsage(usage?: AiUsage): void {
    const visible = Boolean(usage && (usage.prompt > 0 || usage.completion > 0))
    this.usageLabel.classList.toggle('hidden', !visible)
    if (!usage || !visible) {
      this.usageLabel.replaceChildren()
      this.usageLabel.removeAttribute('title')
      return
    }
    this.usageLabel.textContent = `${usage.prompt} + ${usage.completion} tokens`
    const parts = [`输入 ${usage.prompt}`, `输出 ${usage.completion}`]
    if (usage.searches > 0) parts.push(`联网搜索 ${usage.searches} 次`)
    if (usage.fetches > 0) parts.push(`抓取网页 ${usage.fetches} 次`)
    this.usageLabel.title = parts.join(' · ')
  }

  /** 只清状态、不弹提示（用于「又被点了一次」）。 */
  reset(): void {
    this.cancelFrame()
    this.stopDots()
    this.buffer = ''
    this.state = 'loading'
    this.position = null
  }

  hide(): void {
    this.cancelFrame()
    // 卡片收起后没人看那串点，定时器没有理由继续跑。
    this.stopDots()
    this.card.classList.remove('dragging')
    this.card.style.transform = ''
    this.card.classList.add('hidden')
    // 关掉就是一次会话结束：位置与钉住状态都不沿用。
    this.position = null
    this.setPinned(false)
  }

  get visible(): boolean {
    return !this.card.classList.contains('hidden')
  }

  get text(): string {
    return this.buffer
  }

  get stateName(): AiCardState {
    return this.state
  }

  /** 丢弃未渲染的增量（关卡片 / 重新开始时调用，避免旧回调把内容写回去）。 */
  private cancelFrame(): void {
    if (this.frame) window.clearTimeout(this.frame)
    this.frame = 0
  }

  /** 把排队中的增量立刻落地；不滚到底。 */
  private flush(): void {
    this.cancelFrame()
    if (this.buffer) this.renderBody()
    else {
      // 没有正文的空卡片（例如被中止）：连加载占位一起清掉。
      this.stopDots()
      this.content.replaceChildren()
    }
  }

  /**
   * 定位的唯一出口：`position` 有值就用它，否则按锚点算一次。
   * 宽高按实际量出来的走（内容长度不定）。
   */
  private place(anchor: Box, cascade = 0): void {
    const view = readViewport()
    const maxHeight = Math.round(view.vh * 0.6)
    const height = Math.min(this.card.offsetHeight || 160, maxHeight)
    this.card.style.width = `${CARD_WIDTH}px`
    this.card.style.maxHeight = `${maxHeight}px`

    let point =
      this.position ??
      belowAnchorXY(
        {x: view.sx + anchor.x + anchor.width / 2, y: view.sy + anchor.y + anchor.height + CARD_GAP},
        CARD_WIDTH,
        height,
        view
      )

    // 多张叠在同一锚点上时逐张错开：向下向右各移一格，让人看得出后面还有内容。
    if (cascade > 0) {
      const step = (cascade % CASCADE_MAX) * CASCADE_STEP
      point = {x: point.x + step, y: point.y + step}
    }

    this.position = clampToViewport(point, CARD_WIDTH, height, EDGE_MARGIN, view)
    this.applyPosition(this.position)
  }

  /** 只写坐标。配色在 CSS 里跟页面的 color-scheme 走，与 JS 无关。 */
  private applyPosition(point: Point): void {
    this.card.style.left = `${point.x}px`
    this.card.style.top = `${point.y}px`
  }

  /**
   * 整条 `.head` 都是抓手，头部里的可交互元素（语言下拉、钉住按钮）不参与——
   * 不排除的话「点一下下拉」会变成「拖了一下」，卡片被意外钉住。
   *
   * 拖拽期间**只写 `transform`**：不参与布局，交给合成器。早期版本每帧重算配色
   * （`elementFromPoint` + `getComputedStyle`），那是强制同步重排，肉眼可见地卡。
   * 视口与卡片尺寸在按下时量一次，整个拖拽复用。
   * **刻意不用 rAF 合并**：只写 transform 不触发重排，而 rAF 在后台标签页里不触发。
   * 松手时把 transform 换算回 left/top；拖过阈值就自动钉住。
   */
  private startDrag(event: PointerEvent): void {
    if (event.button !== 0) return
    if (this.isInteractiveTarget(event.target)) return
    // 真正要拦的是「拖动时选中了页面文字」，靠 preventDefault 解决。
    event.preventDefault()

    // 视口与卡片尺寸在整个拖拽期间不变，量一次就够。
    const view = readViewport()
    const rect = this.card.getBoundingClientRect()
    const start: Point = {x: view.sx + rect.left, y: view.sy + rect.top}
    const width = rect.width || CARD_WIDTH
    const height = Math.min(rect.height || 160, Math.round(view.vh * 0.6))
    const fromX = event.clientX
    const fromY = event.clientY
    const pinnedBefore = this.pinned
    let moved = false
    /** 拖拽期间的目标位置（页面坐标）。松手时提交给 `this.position`。 */
    let target = start

    this.card.classList.add('dragging')
    try {
      this.card.setPointerCapture(event.pointerId)
    } catch {
      // 部分环境不支持捕获（或被提前释放）：不致命，后面的 window 监听照样能收到 move。
    }

    const onMove = (move: PointerEvent): void => {
      const dx = move.clientX - fromX
      const dy = move.clientY - fromY
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      moved = true
      target = clampToViewport({x: start.x + dx, y: start.y + dy}, width, height, EDGE_MARGIN, view)
      // 只动这一个属性：不触发重排、不查样式。
      this.card.style.transform = `translate3d(${target.x - start.x}px, ${target.y - start.y}px, 0)`
    }

    const onUp = (): void => {
      this.card.classList.remove('dragging')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)

      try {
        this.card.releasePointerCapture(event.pointerId)
      } catch {
        // 同上：没有捕获时无需释放。
      }

      if (moved) {
        // 提交：清掉 transform，把最终坐标写回 left/top。视觉位置不变（两者等价）。
        this.card.style.transform = ''
        this.position = target
        this.applyPosition(target)
        this.setPinned(true)
      } else if (pinnedBefore !== this.pinned) {
        this.setPinned(pinnedBefore)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /** 只有 `select` 与 `button` 需要排除。 */
  private isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return target.closest('select, button') !== null
  }

  /** 复制原始 Markdown：粘进笔记软件时保留结构。 */
  private async copyAll(): Promise<void> {
    if (!this.buffer) return
    const ok = await copyText(this.buffer)
    window.clearTimeout(this.copyTimer)
    this.copyButton.replaceChildren(ok ? checkIcon(13) : closeIcon(13))
    this.copyTimer = window.setTimeout(() => this.resetCopy(), COPY_FEEDBACK_MS)
  }

  private resetCopy(): void {
    window.clearTimeout(this.copyTimer)
    this.copyTimer = 0
    this.copyButton.replaceChildren(copyIcon(13), document.createTextNode('复制'))
    this.copyButton.title = '复制原始 Markdown'
  }
}

/** 选区的首段矩形（视口坐标），作为卡片的锚点。 */
export function anchorBox(range: Range): Box {
  const rects = range.getClientRects()
  const rect = rects[0]
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return {x: rect.left, y: rect.top, width: rect.width, height: rect.height}
  }
  const first = range.getBoundingClientRect()
  return {x: first.left, y: first.top, width: first.width, height: first.height}
}
