/**
 * 消息契约。三处各用一段：background → content、content → background、
 * 以及 content ↔ background 之间承载流式 AI 回复的长连接。
 *
 * 数据读写不走消息——`chrome.storage.local` 对 content script 直接可见，
 * content script 自己调 `shared/db.ts` 就行。这里只放「必须跨上下文」的几件事。
 */
import type {AiSource, AiUsage} from './ai'
import type {CopyLinkStyle} from './copyLink'
import type {AiAction} from './prompt'

/** background → content：工具栏图标左键（面板开合）、右键菜单等。 */
export type ContentMessage =
  | {type: 'panel:toggle'}
  | {type: 'open-settings'}
  /**
   * 右键菜单「复制标题和链接」。标题与 canonical 只有页面里读得到，
   * 剪贴板也只能在页面上下文写（见 `content/clipboard.ts`）。
   *
   * `selectionText` 是菜单带过来的选区（右键落在选中的文字上时才有）：非空就顶替网页标题。
   * 它可能被 Chrome 截断，所以页面那边还会先读一次实时选区。
   */
  | {type: 'copy:title-link'; style: CopyLinkStyle; selectionText?: string}
  /**
   * 「配好 AI 了吗」——只回布尔，**不回密钥**。
   *
   * content script 全站注入，能少读一次 `ai:key` 就少一次：判断要不要显示翻译/解释按钮
   * 不需要密钥本身，只需要「填过没有」。读取与使用都留在 background 与设置页。
   */
  | {type: 'ai:ready'}
  /**
   * content → background：本页划线总数，写到工具栏图标的角标上。
   *
   * 带的是**总数**（含未定位的那些），由 background 统一收成角标文字（`shared/badge.ts`）。
   * 数据仍由 content script 自己读，这条消息只是把「显示」搬到一个页面碰不到的地方。
   */
  | {type: 'count'; total: number}

/** `ai:ready` 的回复。 */
export interface AiReadyReply {
  ready: boolean
}

/**
 * content → background → content 的 AI 长连接端口名。
 *
 * **为什么用 port 而不是 `sendMessage`**：`sendMessage` 是一次性请求-应答，装不下流式增量。
 * 而且每收到一个 chunk 就往 port 上发一条消息，正好落在 Chrome 114+ 的
 * 「通过长连接发消息保活」机制里——这是 SW 在流式过程中不被 30 秒空闲判定杀掉的主要依据
 * （详见 `background.ts` 里 `runAi` 的注释）。
 */
export const AI_PORT = 'inkstone-ai'

/** content → background：开始一次请求。 */
export interface AiStartMessage {
  type: 'start'
  action: AiAction
  /** 选中原文（已 trim） */
  text: string
  /** 前后文，可为空串 */
  context: string
  /** 目标语言代码，仅翻译用 */
  lang: string
}

/** content → background：用户点了「停止」。 */
export interface AiAbortMessage {
  type: 'abort'
}

export type AiClientMessage = AiStartMessage | AiAbortMessage

/** background → content：增量正文。 */
export interface AiDeltaMessage {
  type: 'delta'
  text: string
}

/** background → content：正常结束（可能带着用量与引用来源）。 */
export interface AiDoneMessage {
  type: 'done'
  usage?: AiUsage
  /** 联网搜索的来源。模型没搜过时整个字段不出现。 */
  sources?: AiSource[]
}

/** 失败的分类。只用于挑文案与颜色，不参与逻辑分支。 */
export type AiErrorKind = 'no-key' | 'auth' | 'network' | 'aborted' | 'unknown'

/** background → content：失败或中途断开。 */
export interface AiErrorMessage {
  type: 'error'
  message: string
  kind: AiErrorKind
}

export type AiServerMessage = AiDeltaMessage | AiDoneMessage | AiErrorMessage
