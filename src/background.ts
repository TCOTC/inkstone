/**
 * 后台脚本：工具栏图标入口（左键面板、右键菜单、角标）、转发 AI 请求、全量同步。
 *
 * 划线数据不经过这里：storage 对 content script 与扩展页直接可见。
 * AI 请求是例外，两条硬理由：Key 不进页面上下文；流式要 port 逐块转发。
 */
import {
  AI_TIMEOUT_MS,
  CHAT_ENDPOINT,
  buildRequestInit,
  readStream,
  type AiSource,
  type AiUsage
} from './shared/ai'
import {loadAiKey} from './shared/aiKey'
import {badgeText} from './shared/badge'
import {BADGE_BACKGROUND, BADGE_TEXT} from './shared/colors'
import {
  AI_PORT,
  type AiClientMessage,
  type AiErrorKind,
  type AiServerMessage,
  type AiStartMessage,
  type ContentMessage
} from './shared/messages'
import {buildMessages} from './shared/prompt'
import {LIBRARY_HASH} from './shared/route'
import {loadSettings, effectivePrompt, effectiveSystem} from './shared/settings'
import {AI_KEY_STORAGE, AI_WRAP_STORAGE, PAGE_PREFIX, SETTINGS_KEY} from './shared/storageKeys'
import {
  mergeRemoteKeys,
  pullAiKey,
  pullAndMerge,
  pullSettings,
  pushAiKey,
  pushSettings,
  removeRemoteAiKey,
  syncNow
} from './shared/sync'
import {hashlessUrl} from './shared/url'

/** 清单里 `options_page` 的真实产物路径（构建工具会重排源码路径，不能写死）。 */
function optionsUrl(suffix = ''): string {
  const path = chrome.runtime.getManifest().options_page ?? 'options/index.html'
  return `${chrome.runtime.getURL(path)}${suffix}`
}

/**
 * 紧跟 `anchorTabId` 那枚标签后面、同一窗口（只读 windowId / index，不需要 `tabs` 权限）。
 * 源标签读不到时返回 undefined，调用方退回默认位置，别让「打开」失败。
 */
async function placeAfter(anchorTabId: number | undefined): Promise<{windowId: number; index: number} | undefined> {
  if (anchorTabId === undefined) return undefined
  try {
    const anchor = await chrome.tabs.get(anchorTabId)
    return {windowId: anchor.windowId, index: anchor.index + 1}
  } catch {
    return undefined
  }
}

/**
 * 同一个文档已打开就切过去并改 hash（两个视图是同一个 `options/index.html`）。
 * 不用 `tabs.query` 读 url：那要 `tabs` 权限，`runtime.getContexts` 不需要。
 */
async function focusOrOpen(url: string, anchorTabId?: number): Promise<void> {
  const wanted = hashlessUrl(url)
  const contexts = await chrome.runtime.getContexts({contextTypes: ['TAB']})
  const existing = contexts.find((context) => {
    const current = context.documentUrl
    return typeof current === 'string' && hashlessUrl(current) === wanted
  })

  if (existing?.tabId !== undefined && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, {url, active: true})
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, {focused: true})
    return
  }

  const at = await placeAfter(anchorTabId)
  await chrome.tabs.create(at ? {url, ...at} : {url})
}

/**
 * 当前标签是不是本扩展自己的页面。工具栏在扩展页上也要能点：
 * 那里没有 content script，硬发消息会报「Could not establish connection」。
 */
function isExtensionPage(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''))
}

/**
 * 拿不到 content script（`chrome://`、扩展页、未注入、旧脚本已脱钩）就退回打开偏好设置，
 * 至少让点击有反馈。
 */
async function togglePanel(): Promise<void> {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true})
  if (tab?.id !== undefined && tab.id >= 0 && !isExtensionPage(tab.url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, {type: 'panel:toggle'} satisfies ContentMessage)
      return
    } catch {
      // 落在下面：这个页面没有 content script。
    }
  }
  await focusOrOpen(optionsUrl(), tab?.id)
}

/** 不带 `tabId` = 全局设置，与按 tab 写文字互不干扰。 */
function applyBadgeStyle(): void {
  chrome.action.setBadgeBackgroundColor({color: BADGE_BACKGROUND}).catch(() => {})
  chrome.action.setBadgeTextColor({color: BADGE_TEXT}).catch(() => {})
}

/** 角标是每标签一份；写入失败（标签已关）忽略。 */
function setBadge(tabId: number, total: number): void {
  chrome.action.setBadgeText({tabId, text: badgeText(total)}).catch(() => {})
}

/** 左键点图标：在当前页面右侧展开（或收起）划线列表面板。 */
chrome.action.onClicked.addListener(() => {
  void togglePanel()
})

/**
 * 按 tab 的角标**不随导航自动清**，而新页要等到 content script 报数才有值；
 * 不擦的话扩展页 / `chrome://` / 未注入的标签会挂着上一页的数字。
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return
  chrome.action.setBadgeText({tabId, text: ''}).catch(() => {})
})

/**
 * `ai:ready` 只回布尔：密钥读取留在这一个上下文里（content script 全站注入）。
 * 判断只看有没有 Key——模型与地址都有默认值。`return true` 保持通道以便异步回复。
 */
async function isAiReady(): Promise<boolean> {
  return (await loadAiKey()) !== ''
}

chrome.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
  if (message.type === 'open-settings') {
    // 新标签落在发起请求的这枚标签后面，而不是窗口末尾。
    void focusOrOpen(optionsUrl(), sender.tab?.id)
    return false
  }
  if (message.type === 'ai:ready') {
    void isAiReady().then((ready) => sendResponse({ready}))
    return true
  }
  if (message.type === 'count') {
    const tabId = sender.tab?.id
    if (tabId !== undefined && tabId >= 0) setBadge(tabId, message.total)
    return false
  }
  return false
})

/** 右键点工具栏图标时出现的两个入口。 */
const MENU_LIBRARY = 'inkstone-library'
const MENU_SETTINGS = 'inkstone-settings'

/**
 * `contextMenus.create` 对已存在的 id 是更新，所以幂等。worker 冷启动也要跑：
 * 开发模式「刷新扩展」不一定触发 `onInstalled`，只在安装事件里建会拿不到菜单。
 */
function installMenus(): void {
  const done = (): void => void chrome.runtime.lastError
  chrome.contextMenus.create({id: MENU_LIBRARY, title: '我的划线', contexts: ['action']}, done)
  chrome.contextMenus.create({id: MENU_SETTINGS, title: '偏好设置', contexts: ['action']}, done)
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_LIBRARY) void focusOrOpen(optionsUrl(LIBRARY_HASH), tab?.id)
  else if (info.menuItemId === MENU_SETTINGS) void focusOrOpen(optionsUrl(), tab?.id)
})

/**
 * worker 每次启动都把「与鼠标无关的外壳」重设一遍：右键菜单与角标配色。
 * 两者都是幂等的，而且**都不能只在 `onInstalled` 里做**——开发者模式点「刷新扩展」
 * 不一定触发安装事件，刷新后右键就没有条目、角标会退回默认的蓝底白字。
 */
function installShell(): void {
  installMenus()
  applyBadgeStyle()
}

// 安装 / 更新时先清干净：上一次构建若留下条目，标题或顺序会与代码不一致。
chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.removeAll(installShell))
chrome.runtime.onStartup.addListener(installShell)
installShell()

/**
 * 把错误收成一条能看懂的提示，并分好类。
 *
 * `auth` 单独一类是因为它最常见、且用户能自己修（Key 填错 / 欠费 / 模型名不对）；
 * `aborted` 单独一类是因为「用户主动停止」不该显示成红色错误。
 */
function describeError(error: unknown, aborted: boolean): {message: string; kind: AiErrorKind} {
  if (aborted) return {message: '已停止', kind: 'aborted'}
  const text = error instanceof Error ? error.message : String(error)
  if (/401|403|unauthor|invalid.*key|api key/i.test(text)) {
    return {message: `API Key 无效或已失效：${text}`, kind: 'auth'}
  }
  if (/Failed to fetch|NetworkError|ERR_|net::/i.test(text)) {
    return {message: `网络请求失败：${text}`, kind: 'network'}
  }
  return {message: text || '请求失败', kind: 'unknown'}
}

/**
 * 一次 AI 请求的完整生命周期。
 *
 * **保活的真实机制**（别自己发明心跳）：每收到一个增量就 `port.postMessage` 一次，
 * 这个动作本身就落在 Chrome 114+「通过长连接端口发送消息会重置空闲计时器」的规则里。
 * 官方只给了 WebSocket（116+）和 port 发消息两个口子，**没有**给 `fetch` 流式读取开口子，
 * 所以「读 response.body 期间算活动」是不成立的假设。
 *
 * 真正危险的窗口只有**等首 token** 那一段：思考模式默认开启时可能十几秒，
 * 而空闲判定是 30 秒。因此在请求体里显式关掉 thinking（见 `shared/ai.ts`），
 * 再加一层客户端超时兜住最坏情况。
 *
 * 断线不自动重试：重发会重新生成、重新计费，而且服务端没有幂等键。
 * 内容脚本那边保留已收到的半截 + 一个显式的「重试」按钮，这是唯一不会让用户困惑的兜底。
 */
async function runAi(
  port: chrome.runtime.Port,
  message: AiStartMessage,
  setActive: (controller: AbortController | null) => void
): Promise<void> {
  const post = (payload: AiServerMessage): void => {
    try {
      port.postMessage(payload)
    } catch {
      // 端口已断（标签页关了 / content script 被换掉）：后面的 chunk 没人收，直接放弃。
    }
  }

  const apiKey = await loadAiKey()
  if (!apiKey) {
    post({type: 'error', kind: 'no-key', message: '还没有配置 API Key，请先到偏好设置填写。'})
    return
  }

  const settings = await loadSettings()
  const controller = new AbortController()
  setActive(controller)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, AI_TIMEOUT_MS)

  try {
    // 地址与模型都写死在 `shared/ai.ts`：只支持 DeepSeek 官方接口（见那里的说明）。
    // host 权限就在清单的 `host_permissions` 里，不会有「用户没授权」这种中间态。
    let usage: AiUsage | undefined
    let sources: AiSource[] = []

    const response = await fetch(CHAT_ENDPOINT, buildRequestInit({
      apiKey,
      thinking: settings.aiThinking,
      messages: buildMessages(message.action, {
        text: message.text,
        context: message.context,
        language: message.lang,
        // 由模式决定用内置还是自定义：内置文案一改就能自动跟上。
        system: effectiveSystem(settings, message.action),
        template: effectivePrompt(settings, message.action)
      }),
      signal: controller.signal
    }))
    await readStream(response, {
      onDelta: (text) => post({type: 'delta', text}),
      onUsage: (value) => {
        usage = value
      },
      onSources: (value) => {
        sources = value
      }
    })
    // 用量与引用都在最后一帧，所以只在流读完时发一次 `done`（提前发会把它们弄丢）。
    post({type: 'done', ...(usage ? {usage} : {}), ...(sources.length ? {sources} : {})})
  } catch (error) {
    if (timedOut) {
      post({type: 'error', kind: 'network', message: `超过 ${AI_TIMEOUT_MS / 1000} 秒没有完成，已中止。`})
    } else {
      const described = describeError(error, controller.signal.aborted && !timedOut)
      post({type: 'error', ...described})
    }
  } finally {
    clearTimeout(timer)
    setActive(null)
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AI_PORT) return

  let active: AbortController | null = null
  const setActive = (controller: AbortController | null): void => {
    active = controller
  }

  port.onMessage.addListener((message: AiClientMessage) => {
    if (message.type === 'abort') {
      active?.abort()
      return
    }
    if (message.type !== 'start') return
    // 同一个 port 上再来一次 start：先掐掉上一次，避免两条流同时往一个卡片里写字。
    active?.abort()
    void runAi(port, message, setActive)
  })

  // 标签页关闭 / 页面导航：停掉后台的请求，别留一个还在烧 token 的流。
  port.onDisconnect.addListener(() => {
    active?.abort()
    void chrome.runtime.lastError
  })
})

/**
 * 设置与 API Key 始终镜像，划线数据才看开关；全量拉取只在这里做（content script 每页都跑，
 * 不能让每个页面都拉整库）。合并幂等，重复调用无害。
 */
async function pullOnBoot(): Promise<void> {
  // 先采用远端的设置：它可能刚在另一台设备上把同步打开/关掉。
  await pullSettings()
  await pushSettings()
  // Key 同理，但顺序是先采用再推：新装的设备靠这一步拿到已存的 Key。
  await pullAiKey()
  await pushAiKey()
  const settings = await loadSettings()
  if (!settings.syncHighlights) return
  await pullAndMerge()
}

/**
 * 本机 Key 变了 → 镜像上去。
 *
 * 删除单独处理：`pushAiKey()` 不搬空值（它分不清「没配」与「刚删掉」），
 * 而这里拿得到 `oldValue`，能确定这是一次删除。
 */
async function mirrorAiKey(changes: Record<string, chrome.storage.StorageChange>): Promise<void> {
  const key = changes[AI_KEY_STORAGE]
  if (key && key.newValue === undefined && key.oldValue !== undefined) {
    await removeRemoteAiKey()
    return
  }
  await pushAiKey()
}

chrome.runtime.onStartup.addListener(() => void pullOnBoot())
chrome.runtime.onInstalled.addListener(() => void pullOnBoot())

/** 它刚把同步打开就补一次完整同步，否则本机只在本地存在的划线永远上不去。 */
async function onRemoteSettingsChanged(): Promise<void> {
  const before = await loadSettings()
  const changed = await pullSettings()
  if (!changed) return
  const after = await loadSettings()
  if (!before.syncHighlights && after.syncHighlights) await syncNow()
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    // 本机改了设置 → 镜像上去（`pushSettings` 自己会比较，没变就不写）。
    if (changes[SETTINGS_KEY]) {
      void pushSettings()
      return
    }
    // Key 与设置同一条口径：始终镜像（密文 + 包装密钥成对搬）。
    if (changes[AI_KEY_STORAGE] || changes[AI_WRAP_STORAGE]) {
      void mirrorAiKey(changes)
      return
    }
  }
  if (area !== 'sync') return

  if (changes[SETTINGS_KEY]) void onRemoteSettingsChanged()
  // Key 用同一个键名镜像过来：解不开就不落盘，所以可以无条件采用。
  if (changes[AI_KEY_STORAGE] || changes[AI_WRAP_STORAGE]) void pullAiKey()

  // 只合并 `p:` 键；其余（设置与 Key）由上面两条处理。
  const keys = Object.keys(changes).filter((key) => key.startsWith(PAGE_PREFIX))
  if (keys.length > 0) void mergeRemoteKeys(keys)
})
