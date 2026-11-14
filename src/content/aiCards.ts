/**
 * 多张 AI 卡片的生命周期管理。
 *
 * 每张卡片配**一条自己的长连接**：一次划词 = 一个卡片 = 一个 port = 一次请求。
 * 这样「重试 / 换语言」只影响自己那张，不会互相干扰；background 那边本来就是
 * 按 port 跑的（`runAi` 每个 port 一个 AbortController），不用改协议。
 *
 * 关闭规则（用户定的）：
 * - 默认**不钉住**：点卡片外面就收起；
 * - **拖一下**卡片就钉住（`AiCard` 内部判定），钉住后点外面不收；
 * - 右上角按钮可以在钉住 / 取消钉住之间切，**没有单独的关闭按钮**。
 *
 * 没用的卡片会从列表里摘掉、并且断开连接（否则后台那条 fetch 会继续烧 token）。
 */
import type {AiServerMessage, AiStartMessage} from '../shared/messages'
import {AI_PORT} from '../shared/messages'
import {AiCard, type AiCardHandlers} from './aiCard'
import type {Box} from './geometry'
import type {AiAction} from '../shared/prompt'

/** 一次划词请求需要的全部输入。 */
export interface AiAsk {
  action: AiAction
  /** 目标语言代码（可能是 `auto`） */
  lang: string
  /** 选中原文（已 trim） */
  text: string
  /** 前后文，可为空串 */
  context: string
  /** 选区锚点（视口坐标） */
  anchor: Box
}

interface Entry {
  card: AiCard
  port: chrome.runtime.Port | null
  /** 这张卡片最近一次请求的参数，供重试 / 换语言复用。 */
  lastAsk: AiStartMessage | null
}

export interface AiCardsHandlers {
  /** 用户点了「去设置」。 */
  onOpenSettings: () => void
  /** 某张卡片问「新的请求该发给谁」——这里把它投给 background。 */
  post: (port: chrome.runtime.Port, message: AiStartMessage) => void
  /** 建连接失败（扩展已脱钩等）。 */
  onConnectFailed: (card: AiCard) => void
}

export class AiCards {
  private entries: Entry[] = []
  private readonly handlers: AiCardsHandlers

  constructor(handlers: AiCardsHandlers) {
    this.handlers = handlers
  }

  /**
   * 打开一张新卡片并发起请求。
   *
   * 同一个锚点上已经有卡片时**阶梯错开**（`cascade`）：否则新卡片会把旧卡片完全盖住，
   * 用户会以为自己只是重试了一次。
   */
  ask(request: AiAsk): void {
    const card = new AiCard()
    const entry: Entry = {card, port: null, lastAsk: null}
    // **要在入列之前数**：入列后新卡片还没 show（仍然 hidden），但「已有几张」的语义
    // 是「新卡片要躲开几张」。反过来写会永远差一格，两张卡片完全重叠。
    const cascade = this.visibleCount()
    this.entries.push(entry)

    card.bind(this.bindHandlers(entry))
    card.show(request.action, request.anchor, {
      lang: request.lang,
      text: request.text,
      cascade
    })

    const message: AiStartMessage = {
      type: 'start',
      action: request.action,
      text: request.text,
      context: request.context,
      lang: request.lang
    }
    entry.lastAsk = message
    this.dispatch(entry, message)
  }

  get hasVisible(): boolean {
    return this.entries.some((entry) => entry.card.visible)
  }

  /** 可见卡片里有没有一张正在等首 token（用于断开时的提示措辞）。 */
  private visibleCount(): number {
    return this.entries.filter((entry) => entry.card.visible).length
  }

  /** 关掉所有**没钉住**的卡片（点卡片外面时调）。钉住的一张都不动。 */
  closeUnpinned(): void {
    for (const entry of this.entries) {
      if (!entry.card.visible || entry.card.isPinned) continue
      this.drop(entry)
    }
    this.prune()
  }

  /** 关掉全部（页面切换、扩展脱钩、Esc 兜底）。 */
  hideAll(): void {
    for (const entry of this.entries) this.drop(entry)
    this.entries = []
  }

  private bindHandlers(entry: Entry): AiCardHandlers {
    return {
      onRetry: () => {
        if (!entry.lastAsk) return
        this.reopen(entry, entry.lastAsk)
      },
      onRetranslate: (lang) => {
        if (!entry.lastAsk) return
        this.reopen(entry, {...entry.lastAsk, action: 'translate', lang})
      },
      onOpenSettings: () => this.handlers.onOpenSettings(),
      /** 钉住状态本身由卡片自己维护；这里什么都不用做，留着是为了将来要落存储。 */
      onPinnedChange: () => {}
    }
  }

  /** 重试 / 换语言：同一张卡片、同一个位置，换掉请求内容。 */
  private reopen(entry: Entry, message: AiStartMessage): void {
    const anchor = {x: 0, y: 0, width: 0, height: 0}
    entry.lastAsk = message
    entry.card.show(message.action, anchor, {
      lang: message.lang,
      text: message.text,
      keepPosition: true
    })
    this.dispatch(entry, message)
  }

  /** 建连接（复用同一张卡片的那条）并投递消息。 */
  private dispatch(entry: Entry, message: AiStartMessage): void {
    const port = this.ensurePort(entry)
    if (!port) {
      entry.card.fail('无法连接扩展后端，请刷新本页后重试。', 'network')
      return
    }
    this.handlers.post(port, message)
  }

  private ensurePort(entry: Entry): chrome.runtime.Port | null {
    if (entry.port) return entry.port
    try {
      const port = chrome.runtime.connect({name: AI_PORT})
      port.onMessage.addListener((message: AiServerMessage) => this.onMessage(entry, message))
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError
        entry.port = null
        // 还在等首 token 就说明是连接先断了；已经出字的话保留那半截，用户自己决定要不要重试。
        if (entry.card.visible && entry.card.stateName === 'loading') {
          entry.card.fail('与扩展后端的连接中断了，请重试。', 'network')
        }
      })
      entry.port = port
      return port
    } catch {
      this.handlers.onConnectFailed(entry.card)
      return null
    }
  }

  private onMessage(entry: Entry, message: AiServerMessage): void {
    if (message.type === 'delta') {
      entry.card.append(message.text)
      return
    }
    if (message.type === 'done') {
      entry.card.finish(message.usage, message.sources)
      return
    }
    entry.card.fail(message.message, message.kind)
  }

  /** 收起一张卡片并断开它的连接（让后台停掉那条流）。 */
  private drop(entry: Entry): void {
    entry.card.hide()
    try {
      entry.port?.postMessage({type: 'abort'})
    } catch {
      // 端口已断：后台那边 onDisconnect 已经收过尾了。
    }
    try {
      entry.port?.disconnect()
    } catch {
      // 同上。
    }
    entry.port = null
  }

  /** 摘掉已经不可见的条目，避免长页面反复划词时列表无限增长。 */
  private prune(): void {
    this.entries = this.entries.filter((entry) => entry.card.visible)
  }
}
