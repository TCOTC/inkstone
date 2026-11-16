/**
 * content script 入口：读划线 → 重定位 → 渲染 → 事件绑定 → 脱钩降级。
 *
 * 存储访问一律走 `shared/db.ts`：storage 对 content script 直接可见，不经 background 转发。
 */
import {createAnchorFromRange, type AnchorFailure} from '../shared/anchor'
import {preferSelection, type CopyLinkStyle} from '../shared/copyLink'
import {addHighlight, deleteHighlight, getPageByUrl} from '../shared/db'
import {
  type AiReadyReply,
  type ContentMessage
} from '../shared/messages'
import {type AiAction} from '../shared/prompt'
import {relocateHighlight} from '../shared/relocate'
import {readHighlightAnchor} from '../shared/route'
import {encodePage, type PageRow} from '../shared/rowCodec'
import {loadSettings, normalizeSettings} from '../shared/settings'
import {AI_KEY_STORAGE, PAGE_PREFIX, pageStorageKey} from '../shared/storageKeys'
import {MIN_TEXT_LEN} from '../shared/whitespace'
import {PageTextIndex} from '../shared/textIndex'
import {type PageRecord, type Settings} from '../shared/types'
import {recordUnresolved, type UnresolvedItem} from '../shared/unresolved'
import {hashlessUrl, samePageUrl} from '../shared/url'
import {isPageEditable, isEventInEditable, isInEditable} from './editable'
import {isExtensionAlive} from './extensionAlive'
import {anchorBox} from './aiCard'
import {AiCards} from './aiCards'
import {copyText} from './clipboard'
import {isBackwardSelection} from './geometry'
import {Highlighter, type RenderItem} from './highlighter'
import {buildMarkerEntries} from './markerEntries'
import {Markers, type MarkerEntry} from './markers'
import {copyLinkText} from './pageMeta'
import {PagePanel} from './pagePanel'
import {collectSelectionContext} from './selectionContext'
import {Spotlight} from './spotlight'
import {Toast} from './toast'
import {Toolbar} from './toolbar'
import {ensureSelectable, resetSelectableProbe} from './userSelect'

/**
 * 实例登记处。扩展更新后 `chrome.scripting.executeScript` 会把新脚本注入到**同一个**
 * isolated world（与清单声明的 content script 同一个 global），而 Chrome **不会卸载**旧实例：
 * 它的 `document` 监听、`MutationObserver`、Shadow 宿主全在，只是 `chrome.*` 已失效。
 *
 * 于是约定：每个实例启动时把自己登记在这里，并给出一个能把自己拆干净的 `teardown`。
 * 新实例进来先把旧实例拆掉再接管，标签页就不必刷新。
 */
const INSTANCE_KEY = '__inkstoneInstance'
interface ContentInstance {
  alive: boolean
  teardown: () => void
}

function currentInstance(): ContentInstance | undefined {
  const slot = (globalThis as Record<string, unknown>)[INSTANCE_KEY]
  return slot && typeof slot === 'object' ? (slot as ContentInstance) : undefined
}

/** 有未定位的划线时，DOM 变动触发的重试最小间隔（正文常是后加载的）。 */
const UNRESOLVED_RETRY_MS = 5000
/** 弹划词工具条的延时。 */
const TOOLBAR_DELAY = 50
/** 检测「站点是否禁用选择」的最小间隔，避免每次空 mouseup 都扫一遍。 */
const SELECTABLE_PROBE_MS = 2000
/** `#inkstone-hl=` 跳转的重试次数与间隔（正文常常是后加载的）。 */
const JUMP_RETRIES = 6
const JUMP_RETRY_MS = 700

/** 创建失败时的提示文案。与 `shared/anchor.ts` 的 `AnchorFailure` 一一对应。 */
const ANCHOR_NOTICE: Record<AnchorFailure, string> = {
  TOO_SHORT: `选中内容过短，至少需要 ${MIN_TEXT_LEN} 个字符`,
  NOT_FOUND: '正文中不存在所选文字，未保存',
  AMBIGUOUS: '所选文字在页面中多处出现，无法区分上下文，未保存'
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** 订阅系统深浅色变化（主题变化时重画一次）。返回取消订阅函数。 */
function watchColorScheme(onChange: () => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!query?.addEventListener) return () => {}
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * 宿主在 light DOM 下零子节点，事件穿出影子边界会被 retarget 成宿主本身，所以比标签名就够。
 * **必须精确匹配**：`includes()` 是子串匹配，`inkstone-panel` 里的字母 `p` 会把 `<p>`
 * 当成浮层，工具条会全线失效。若将来往宿主直接 `append` 子节点，这里要退回 `closest()`。
 */
const OVERLAY_HOSTS = new Set([
  'inkstone-toolbar',
  'inkstone-markers',
  'inkstone-panel',
  'inkstone-ai',
  'inkstone-toast'
])

/**
 * 接管时要清掉的宿主标签。比 `OVERLAY_HOSTS` 多一个 `inkstone-spotlight`——
 * 那个盒子 `pointer-events: none`，不参与事件判定，所以不在上面那个集合里，
 * 但它同样必须拆掉，否则旧实例描的框会一直挂在页面上。
 */
const OVERLAY_TAGS = [...OVERLAY_HOSTS, 'inkstone-spotlight']

function removeOverlayHosts(): void {
  for (const tag of OVERLAY_TAGS) {
    for (const node of document.querySelectorAll(tag)) node.remove()
  }
}

function isOverlayNode(node: EventTarget | null): boolean {
  return node instanceof Element && OVERLAY_HOSTS.has(node.localName)
}

function isOurMutation(target: Node): boolean {
  return isOverlayNode(target instanceof Element ? target : target.parentElement)
}

/** 空索引表：`paint()` 在没有划线时用它，避免顺手把整页索引建出来。 */
const NO_NODES: readonly Text[] = []

/** 只要求「非空」；真正不建划线是锚定自己的规则（`ANCHOR_NOTICE`）。 */
function currentSelection(): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  if (selection.toString().trim().length === 0) return null
  return selection.getRangeAt(0) ?? null
}

async function boot(): Promise<void> {
  // 扩展更新后 `executeScript` 会把新实例注入到**同一个** isolated world，而 Chrome 不会
  // 卸载旧实例（它的监听与 Shadow 宿主都还在，只是 `chrome.*` 已失效）。先让旧实例自己拆，
  // 老版本没有这个能力就退化为下面按标签名清 DOM——两者都做，代价接近零。
  try {
    currentInstance()?.teardown()
  } catch {
    // 旧实例拆到一半抛错不影响接管。
  }
  removeOverlayHosts()

  const index = new PageTextIndex()
  const highlighter = new Highlighter()
  // 上一个实例若不会拆（老版本），它的注册名还挂在 `CSS.highlights` 上，这里一并清掉。
  highlighter.clear()
  const toolbar = new Toolbar()
  const markers = new Markers()
  const panel = new PagePanel()
  const spotlight = new Spotlight()
  const toast = new Toast()

  /** 拆解时要撤掉的东西（监听、定时器、观察者）。`teardown()` 逐个执行后清空。 */
  const disposers: Array<() => void> = []
  function disposeLater(off: () => void): void {
    disposers.push(off)
  }
  /** 已拆解：在途的异步回来时靠它早退（同一个 world 的 `CSS.highlights` 是共享的）。 */
  let disposed = false

  let settings: Settings = await loadSettings()
  /** 存了 API Key 才有翻译/解释入口。模型与地址都有默认值，不需要用户配。 */
  let aiReady = false
  /** 只问一个布尔：密钥读取只留在 background。脱钩时抛错就当作「没配」。 */
  async function refreshAiReady(): Promise<void> {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: 'ai:ready'
      } satisfies ContentMessage)) as AiReadyReply | undefined
      aiReady = reply?.ready === true
    } catch {
      aiReady = false
    }
  }
  await refreshAiReady()
  let page: PageRecord | null = null
  let items: RenderItem[] = []
  let lastReport = ''
  let observedUrl = hashlessUrl(location.href)
  /** 扩展已经和本页脱钩（更新 / 停用 / 卸载），页面上的东西都已拆掉 */
  let stale = false
  /** 本页未定位的划线（面板底部单独一块） */
  let unresolvedItems: UnresolvedItem[] = []
  /** 上次未定位的条数与重试时间（只在有失败项时才允许 DOM 变动触发重算） */
  let unresolvedCount = 0
  let lastRetry = 0
  /** mouseup 之后安排的那次判定 */
  let toolbarTimer = 0
  let lastSelectableProbe = 0
  /** 上次报给工具栏角标的数。`-1` = 还没报过（0 也要报一次，才能擦掉上一页的数字） */
  let reportedCount = -1
  /**
   * 弹工具条那一刻的选区快照。点浮层会清掉页面选区，首次请求靠它。
   * 重试 / 换语言读卡片自己记的参数，不再回来找它（那选区已经被清空）。
   */
  let askRange: Range | null = null

  /** 可同时开多张；每张卡自带一条 port，回调不需要知道当前是哪一张。 */
  const aiCards = new AiCards({
    onOpenSettings: () => {
      void chrome.runtime.sendMessage({type: 'open-settings'} satisfies ContentMessage)
    },
    post: (port, message) => port.postMessage(message),
    onConnectFailed: (card) => card.fail('无法连接扩展后端，请刷新本页后重试。', 'network')
  })

  /** 幂等地补救「站点禁用选择」，带最小间隔。 */
  function probeSelectable(): void {
    const now = performance.now()
    if (now - lastSelectableProbe < SELECTABLE_PROBE_MS) return
    lastSelectableProbe = now
    ensureSelectable()
  }

  /** 马上要碰 `chrome.*` 的入口先问一句，避免抛 `Extension context invalidated`。 */
  function checkAlive(): boolean {
    if (stale) return false
    if (isExtensionAlive()) return true
    enterStale()
    return false
  }

  /**
   * 脱钩后**不拆 UI**：高亮、命中检测与浮层都是纯 DOM/CSS，照常工作；
   * 只有存储与消息失效。所以只把入口换成「刷新本页」，而不是先把页面恢复原样。
   */
  function hideFloats(clear: boolean): void {
    toolbar.hideAll()
    spotlight.stop()
    aiCards.hideAll()
    if (clear) {
      markers.clear()
      panel.clear()
    } else {
      panel.hide()
    }
  }

  function enterStale(): void {
    if (stale) return
    stale = true
    hideFloats(false)
  }

  /**
   * 选区在点击浮层那一刻已经没了，所以原文与前后文都从 `askRange` 快照里取。
   * 卡片里换语言只影响那一次，**不写回设置**。
   */
  function startAsk(action: AiAction, lang = settings.translateLang): void {
    toolbar.hideAll()
    const range = askRange
    if (!range) return
    const text = range.toString().trim()
    if (!text) return

    aiCards.ask({
      action,
      lang,
      text,
      context: collectSelectionContext(range, text).contextText,
      anchor: anchorBox(range)
    })
  }


  toolbar.bind({
    onHighlight: () => void createHighlight(),
    onDelete: (id) => void removeHighlight(id),
    onReload: () => location.reload(),
    onAsk: (action) => {
      if (!checkAlive()) return
      startAsk(action)
    }
  })

  /**
   * 用**捕获**阶段监听：站点的部分组件会在冒泡阶段 `stopPropagation`，挂冒泡会让
   * 「点外面」在这一页永远失效。用 `mousedown` 而不是 `click`：按下就收，不用等松开。
   */
  function onDocumentMouseDown(event: MouseEvent): void {
    if (!aiCards.hasVisible) return
    if (isOverlayNode(event.target)) return
    aiCards.closeUnpinned()
  }
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  disposeLater(() => document.removeEventListener('mousedown', onDocumentMouseDown, true))

  markers.bind({onPick: (id) => goTo(id)})
  panel.bind({onPick: (id) => goTo(id)})
  spotlight.bind({rectsOf: (id) => highlighter.rectsOf(id)})

  /** 返回是否真的滚过去了——正文可能还没加载完，调用方据此重试。 */
  function goTo(id: number): boolean {
    if (!highlighter.scrollTo(id)) return false
    spotlight.show(id)
    markers.highlight(id)
    panel.highlight(id)
    return true
  }

  /** 正文常是后加载的，定位不到就重试；次数有限，避免真的找不到时一直空转。 */
  function jumpToAnchor(attempt = 0): void {
    const id = readHighlightAnchor(location.hash)
    if (id === null) return
    if (goTo(id)) return
    if (attempt >= JUMP_RETRIES) return
    window.setTimeout(() => jumpToAnchor(attempt + 1), JUMP_RETRY_MS)
  }

  /** 导航顺序规则在 `markerEntries.ts`。 */
  function markerEntries(): MarkerEntry[] {
    const measured = new Map(highlighter.measure().map((item) => [item.id, item]))
    return buildMarkerEntries(items, measured)
  }

  function syncNavigators(): void {
    const entries = markerEntries()
    markers.update(entries)
    panel.update(entries, unresolvedItems)
    reportCount()
  }

  /**
   * 数 `page.highlights.length`，**包含未定位的**（它们同样是用户划过的线）。
   * 值没变就不发：`paint()` 会被主题变化、设置改动反复调到。
   */
  function reportCount(): void {
    const total = settings.highlightEnabled ? (page?.highlights.length ?? 0) : 0
    if (total === reportedCount) return
    reportedCount = total
    try {
      chrome.runtime.sendMessage({type: 'count', total} satisfies ContentMessage).catch(() => {})
    } catch {
      // 扩展已脱钩（更新 / 停用）：角标由下一次导航清掉。
    }
  }

  /** 某条划线的完整原文（点划线时复制用）。找不到就返回空串，复制按钮点了不做事。 */
  function highlightText(id: number): string {
    const found = items.find((item) => item.highlight.id === id)
    return found ? found.highlight.text.trim() : ''
  }

  /** 按当前设置重画。不重定位——主题/画笔变化只影响样式。 */
  function paint(nodes?: readonly Text[]): void {
    if (disposed || !settings.highlightEnabled) return
    // 没有划线时不去建索引：那等于把整页文本节点遍历一遍，却什么都不产出。
    const textNodes = nodes ?? (items.length === 0 ? NO_NODES : index.indexData().nodes)
    highlighter.render(items, textNodes, {
      penStyle: settings.penStyle,
      dark: prefersDark()
    })
    syncNavigators()
  }

  /**
   * `change` 来自 MutationObserver：先做廉价的有效性检查（区间还在、文字没变），
   * 站点无关的 DOM 变动（广告、评论区、懒加载）不必全量重建索引。
   */
  function render(reason: 'load' | 'change' = 'load'): void {
    if (disposed || !settings.highlightEnabled) return
    if (reason === 'change' && !highlighter.isStale()) {
      if (unresolvedCount === 0) return
      const now = performance.now()
      if (now - lastRetry < UNRESOLVED_RETRY_MS) return
      lastRetry = now
    }

    const source = page?.highlights ?? []
    const list: RenderItem[] = []
    const unresolved: UnresolvedItem[] = []

    if (source.length > 0) {
      index.rebuild()
      for (const highlight of source) {
        const result = relocateHighlight(highlight, index)
        list.push({highlight, result})
        if (result.errCode !== 0) {
          unresolved.push({
            id: highlight.id,
            preview: highlight.text.length > 80 ? `${highlight.text.slice(0, 80)}…` : highlight.text,
            errCode: result.errCode
          })
        }
      }
    }
    // 本页一条划线也没有（最常见的情形）：**不建索引**。`buildTextIndex` 要遍历整页
    // 文本节点并做去空白，页面越大越贵，而我们这里什么都画不出来。

    items = list
    unresolvedCount = unresolved.length
    unresolvedItems = unresolved
    // 重定位过程中可能触发过 `rebuild()`，span 的 nodeIndex 对应的是重建后的节点表。
    paint(source.length > 0 ? index.indexData().nodes : NO_NODES)

    // 只在清单变化时写 storage，避免 MutationObserver 重算时反复写盘。
    // 降级态（扩展已更新）写不了：跳过，但高亮照旧按本地结果画（纯 CSS，不需要 chrome）。
    const signature = `${location.href}:${unresolved.length}:${unresolved.map((item) => item.id).join(',')}`
    if (!stale && signature !== lastReport) {
      lastReport = signature
      void recordUnresolved(location.href, page?.title || document.title, unresolved)
    }
  }

  async function loadPage(): Promise<void> {
    if (!checkAlive()) return
    page = await getPageByUrl(location.href)
    // 读取期间被新实例接管了：不要拿旧数据去画（同一个 world 的注册表是共享的）。
    if (disposed) return
    render()
    // 扩展被关掉时 `render()` 直接返回（不会走到 `syncNavigators()`），这里补一次：
    // 这种情况得把角标擦掉，否则会挂着上一次的数字。
    reportCount()
  }

  async function createHighlight(): Promise<void> {
    if (!checkAlive()) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return

    const range = selection.getRangeAt(0).cloneRange()
    if (index.indexData().nodes.length === 0) index.rebuild()

    // 拿不到唯一位置就不落库，并把原因就地告诉用户（否则点高亮看着像没反应）。
    const result = createAnchorFromRange(range, index)
    if (!result.ok) {
      toolbar.showNotice(ANCHOR_NOTICE[result.reason], range)
      return
    }

    // id 由存储层分配（页内自增），这里只给内容。
    page = await addHighlight(
      location.href,
      {
        text: result.anchor.core,
        prev: result.anchor.prev,
        next: result.anchor.next,
        createdAtSec: Math.floor(Date.now() / 1000)
      },
      document.title
    )

    selection.removeAllRanges()
    toolbar.hideAll()
    render('load')
  }

  async function removeHighlight(id: number): Promise<void> {
    if (!page || !checkAlive()) return
    page = await deleteHighlight(page.url, id)
    toolbar.hideAll()
    render('load')
  }

  /**
   * 划词工具条的显隐。
   *
   * 1. 在输入框 / 按钮 / 可编辑区域里 → 完全不管。
   * 2. mouseup 落在**已有划线上** → 不参与判定：交给 `click` 去弹删除工具条。
   * 3. 其余 mouseup 一律延时 50ms 后判定：选区有效 → 弹工具条；无效 → 浮层都收起来。
   *    「点一下就收起来」就是靠这一条（点别处会清掉选区）。
   *
   * 降级态（扩展已更新、本页没刷新）弹的是只有 ↻ 的工具条：划不了新划线也删不了旧的，
   * 但入口还在原处，点一下就重载页面、把功能换回来。
   */
  function onMouseUp(event: MouseEvent): void {
    if (!settings.highlightEnabled || isOverlayNode(event.target)) return
    if (isEventInEditable(event) || isPageEditable()) return

    window.clearTimeout(toolbarTimer)
    if (highlighter.hitTest(event.clientX, event.clientY)) {
      toolbarTimer = 0
      return
    }

    toolbarTimer = window.setTimeout(() => {
      toolbarTimer = 0
      const range = currentSelection()
      if (!range) {
        toolbar.hideAll()
        probeSelectable()
        return
      }
      if (isInEditable(range.startContainer)) {
        toolbar.hideAll()
        return
      }
      const backward = isBackwardSelection()
      if (stale) {
        toolbar.showStaleToolbar({range, backward})
        return
      }
      // 点浮层会清掉页面选区，AI 要用的原文与前后文只能在快照里拿。
      askRange = range.cloneRange()
      toolbar.showToolbar(range, backward, aiReady)
    }, TOOLBAR_DELAY)
  }

  function onClick(event: MouseEvent): void {
    if (!settings.highlightEnabled || isOverlayNode(event.target)) return

    const hit = highlighter.hit(event.clientX, event.clientY)
    if (!hit) {
      toolbar.hideToolbar()
      askRange = null
      return
    }
    // 弹工具条时必须取消掉 mouseup 安排的那次判定，否则 50ms 后会被刚弹的浮层收起。
    window.clearTimeout(toolbarTimer)
    toolbarTimer = 0

    // 在划线里拖选后松手也会走到这里：有选区就照划词那套摆（方向决定左上/右下），
    // 只剩光标（单纯点一下）时横向跟落点、纵向跟**这一行文字**（`hit.rect.top`）——
    // 直接用 `clientY` 的话，同一行里点得靠上靠下会让工具条上下跳。
    const range = currentSelection()
    const anchor = range ? {range, backward: isBackwardSelection()} : {x: event.clientX, top: hit.rect.top}
    if (stale) {
      toolbar.showStaleToolbar(anchor)
    } else {
      // 点浮层会清掉选区，所以这里定下快照：有选区用选区（划线内部那一段），
      // 没有就用整条划线的 Range。拿不到就置空，那两个按钮点了不做事。
      askRange = (range ?? highlighter.rangeOf(hit.id))?.cloneRange() ?? null
      toolbar.showAnchorToolbar(hit.id, highlightText(hit.id), anchor, aiReady)
    }
    event.stopPropagation()
  }

  /** 钉住的是用户特意留的，Esc 顺手清掉反而是意外的数据丢失。 */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    toolbar.hideAll()
    panel.hide()
    aiCards.closeUnpinned()
  }

  // SPA 换页用 hashless URL 判断。顺便每秒问一句「扩展还活着吗」：更新 / 停用后旧脚本
  // 收不到任何通知，只能自己发现。只读本地属性，比开长连接便宜。
  const urlWatcher = window.setInterval(() => {
    if (disposed) return
    if (!isExtensionAlive()) {
      enterStale()
      return
    }
    const next = hashlessUrl(location.href)
    if (next === observedUrl) return
    observedUrl = next
    // 换页=换了实现，禁选判定与滚动容器都要重新看过。
    resetSelectableProbe()
    markers.resetLayout()
    hideFloats(true)
    void loadPage()
  }, 1000)
  disposeLater(() => window.clearInterval(urlWatcher))

  // 合并成一次空闲任务，连续变动不占满主线程；要不要重算由 `render('change')` 里的
  // `isStale()` 决定。
  let scheduled = 0
  const scheduleRender = (): void => {
    if (disposed || scheduled) return
    const run = (): void => {
      scheduled = 0
      if (disposed) return
      render('change')
    }
    scheduled =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, {timeout: 1000})
        : window.setTimeout(run, 300)
  }

  const observer = new MutationObserver((records) => {
    if (!settings.highlightEnabled) return
    if (records.every((record) => isOurMutation(record.target))) return
    scheduleRender()
  })

  // 工具栏图标左键点击 → 在页面右侧展开/收起本页划线列表（background 转发）。
  // 右键菜单的「复制标题和链接」也走这条通道（style 由菜单项决定）。
  function onContentMessage(message: ContentMessage): void {
    if (message?.type === 'panel:toggle') {
      // 关掉扩展时页面上什么都没画，直接 toggle 会显示「本页没有划线」，容易被当成坏了。
      if (settings.highlightEnabled) panel.toggle()
      else panel.notice('扩展已在偏好设置里关闭。')
      return
    }
    if (message?.type === 'copy:title-link') {
      // 实时选区优先：菜单带过来的那份可能被 Chrome 截断。两者都取不到时用网页标题。
      const live = window.getSelection()?.toString() ?? ''
      void copyTitleLink(message.style, preferSelection(live, message.selectionText ?? ''))
    }
  }
  chrome.runtime.onMessage.addListener(onContentMessage)
  disposeLater(() => chrome.runtime.onMessage.removeListener(onContentMessage))

  /**
   * 复制不需要扩展是启用的：它不碰划线数据，也不写存储。
   * 失败（页面失焦、剪贴板被拒）要说出来，静默比不提供这个功能更让人困惑。
   */
  async function copyTitleLink(style: CopyLinkStyle, selected: string): Promise<void> {
    const ok = await copyText(copyLinkText(style, selected))
    if (!ok) {
      toast.show('复制失败，请重试')
      return
    }
    toast.show(selected.trim() === '' ? '已复制标题和链接' : '已复制选中文本和链接')
  }

  /** 关掉时清高亮并擦角标；重新打开要从头渲染（之前可能一次都没定位过）。 */
  function onSettingsChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName
  ): void {
    if (area !== 'local') return
    if (!changes.settings) return
    const wasEnabled = settings.highlightEnabled
    settings = normalizeSettings(changes.settings.newValue)
    // AI 能不能用只看 Key，所以这里只看高亮总开关。
    if (settings.highlightEnabled) {
      // 从关到开：之前一次都没定位过，必须重新渲染，不能只重画。
      if (wasEnabled) paint()
      else render('load')
      return
    }
    highlighter.clear()
    hideFloats(true)
    reportCount()
  }
  chrome.storage.onChanged.addListener(onSettingsChanged)
  disposeLater(() => chrome.storage.onChanged.removeListener(onSettingsChanged))

  /** 设置页填了 / 删了 API Key → 立刻更新「能不能用 AI」，不必刷新页面。 */
  function onAiKeyChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName
  ): void {
    if (area !== 'local' || !changes[AI_KEY_STORAGE]) return
    void refreshAiReady()
  }
  chrome.storage.onChanged.addListener(onAiKeyChanged)
  disposeLater(() => chrome.storage.onChanged.removeListener(onAiKeyChanged))

  // 别的标签页改了本页 → 重读重画（只重画会把已被删掉的线继续画着）。
  // 判定「是不是本页」不能只看键：页面可能是靠回退匹配找到的，那时它存在另一个键上，
  // 所以键对不上时还要拿行里的 `u` 再比一次。
  function onPagesChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName
  ): void {
    if (area !== 'local' || !settings.highlightEnabled) return

    const ownKey = pageStorageKey(location.href)
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(PAGE_PREFIX)) continue

      const current = change.newValue as PageRow | undefined
      const previous = change.oldValue as PageRow | undefined
      // 键对不上时用行里的 `u` 认：本页可能是靠回退匹配置上的，存在另一个键上。
      const mine =
        key === ownKey ||
        [current, previous].some((row) => Boolean(row) && samePageUrl(location.href, row!.u))
      if (!mine) continue

      // 删除时 oldValue 恰好等于内存里的值，所以这一支必须在「值没变就跳过」之前。
      if (!current) {
        void loadPage()
        return
      }

      // 自己刚写完：存储里的内容与内存一致，重读重画收益为零，跳过。
      if (page && JSON.stringify(current) === JSON.stringify(encodePage(page))) return

      void loadPage()
      return
    }
  }
  chrome.storage.onChanged.addListener(onPagesChanged)
  disposeLater(() => chrome.storage.onChanged.removeListener(onPagesChanged))

  disposeLater(watchColorScheme(() => paint()))

  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('mousemove', onMouseMove, {passive: true})
  disposeLater(() => {
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    // `removeEventListener` 只认 capture，不认 `passive`。
    document.removeEventListener('mousemove', onMouseMove as unknown as EventListener)
  })
  // 不监听 scroll / resize：浮层用页面坐标绝对定位，滚动时随内容走。
  // （试过 position:fixed + 隐藏，结果是浮层「不跟着文字走」，不能回到那条路。）

  // hover 换色用 mousemove + 命中检测；浏览器已节流，这里再降一档频率。
  let hoverAt = 0
  function onMouseMove(event: MouseEvent): void {
    if (!settings.highlightEnabled) return
    // 没有划线时先早退：`hitTest` 会先做一次 `caretRangeFromPoint`（122µs）才发现表是空的。
    if (highlighter.size === 0) return
    const now = performance.now()
    if (now - hoverAt < 60) return
    hoverAt = now
    highlighter.setHover(highlighter.hitTest(event.clientX, event.clientY))
  }

  if (document.body) {
    observer.observe(document.body, {childList: true, subtree: true, characterData: true})
    disposeLater(() => observer.disconnect())
  }

  // 被站点禁用选择（典型：微信公众号）时先解锁，否则后面的一切交互都无从谈起。
  ensureSelectable()

  await loadPage()
  jumpToAnchor()

  /**
   * 文档高度变了（字体、图片、折叠），而标记点位置是相对内容高度的百分比：只重量尺寸、
   * 不重定位。`invalidateMeasure()` 不能省——Range 与 `scrollY` 都没变，`measure()`
   * 会直接返回旧值，而这里唯一的目的就是重量。
   */
  function resyncMarkers(): void {
    if (stale || !settings.highlightEnabled || items.length === 0) return
    highlighter.invalidateMeasure()
    syncNavigators()
  }

  /** 布局可能整体换过（文档加载完 / 字体就位）：连「谁是滚动容器」的判定一起重来。 */
  function relayoutMarkers(): void {
    markers.resetLayout()
    resyncMarkers()
  }

  window.addEventListener('load', relayoutMarkers)
  disposeLater(() => window.removeEventListener('load', relayoutMarkers))
  void document.fonts.ready.then(relayoutMarkers)
  if (typeof ResizeObserver === 'function' && document.body) {
    let resyncTimer = 0
    const resizeObserver = new ResizeObserver(() => {
      if (resyncTimer) return
      resyncTimer = window.setTimeout(() => {
        resyncTimer = 0
        resyncMarkers()
      }, 200)
    })
    resizeObserver.observe(document.body)
    disposeLater(() => {
      resizeObserver.disconnect()
      window.clearTimeout(resyncTimer)
    })
  }

  /**
   * 把自己拆干净：撤监听 / 定时器 / 观察者，断开 AI 长连接，清掉共享的高亮注册表与宿主。
   *
   * 顺序有讲究：**先撤监听**（否则拆除过程中页面事件还会回来写新实例的状态），
   * 再停 rAF / 断开端口，最后清注册表与宿地。
   */
  function teardown(): void {
    if (disposed) return
    disposed = true
    for (const off of disposers.splice(0)) {
      try {
        off()
      } catch {
        // 单个 disposer 出错不影响其余部分。
      }
    }
    spotlight.stop()
    aiCards.hideAll()
    highlighter.clear()
    removeOverlayHosts()
    ;(globalThis as Record<string, unknown>)[INSTANCE_KEY] = undefined
  }

  ;(globalThis as Record<string, unknown>)[INSTANCE_KEY] = {alive: true, teardown}
}

void boot()
