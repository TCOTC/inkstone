import {DEFAULT_PEN_STYLE, type PenStyle} from './styles'
import {DEFAULT_AI_LANGUAGE, type AiAction} from './prompt'

/** 提示词的两块：`system` 是角色设定，`prompt` 是 user 任务模板。 */
export type PromptKind = 'system' | 'prompt'

/**
 * 一块提示词两种状态：`default` 每次都取内置文案（改默认就能跟着升级），`custom` 取设置里那份。
 */
export type PromptMode = 'default' | 'custom'

/** 四个槽（两个动作 × 两块）各自的模式。 */
export type PromptModes = Record<AiAction, Record<PromptKind, PromptMode>>

/**
 * 划线记录。全部字段都是「运行时有人读」的，没有预留位；加字段前先说清它支撑哪个功能。
 * `text` / `prev` / `next` 是定位的全部依据，存**原始空白**（比较前才归一）。
 */
export interface HighlightRecord {
  /** 页内序号：整数，1 起。只在单页内唯一（存储键已经是页面） */
  id: number
  /** 划线原文，含原始空白 */
  text: string
  /** 前文，含原始空白；与 `text` 坐标系不同，比较前先 `stripWs` */
  prev: string
  /** 后文，含原始空白 */
  next: string
  /** 秒级时间戳，仅展示用 */
  createdAt: number
  /** 本地新划的（导入数据里没有这个字段） */
  local?: boolean
}

/**
 * 一个页面的全部数据，划线内嵌存储（避免 join）。存储键就是页面身份，所以记录里不需要 id；
 * 站点名从 URL 派生，不存。
 */
export interface PageRecord {
  /** 规范形式的 URL（`pageKey`）；也是存储键的来源 */
  url: string
  title: string
  /** 秒级时间戳；「我的划线」的唯一排序键 */
  createdAt: number
  highlights: HighlightRecord[]
}

export interface Settings {
  /** 1=荧光笔 2=实线下划线 3=虚线下划线 4=半透明底+下划线 */
  penStyle: PenStyle
  /** 关掉后 content script 不渲染也不响应划词 */
  enabled: boolean
  /** 开启后把页行镜像到 `chrome.storage.sync`（走 Chrome 自带账号同步） */
  sync: boolean
  /** 翻译目标语言（含 `auto`）：中文译成英语、其余译成简体中文 */
  aiLang: string
  /**
   * **默认关**：开启后首 token 慢很多，而 service worker 的 30 秒空闲判定正好卡在这段；
   * 与联网搜索叠加时还会变成深度思考搜索（多步、最慢）。
   */
  aiThinking: boolean
  /** 四个提示词槽各自用内置默认还是自定义，**与文案分开存**（理由见 design.md §9.7） */
  aiPromptMode: PromptModes
  /** 「翻译」的自定义 system。空串 = 没写过；是否生效看 `aiPromptMode` */
  aiSystemTranslate: string
  /** 「解释」的自定义 system，规则同上 */
  aiSystemExplain: string
  /** 「翻译」的自定义 user 模板。**缺 `{{text}}` 当作没写**，不拿坏模板发请求 */
  aiPromptTranslate: string
  /** 「解释」的自定义 user 模板，规则同上 */
  aiPromptExplain: string
}

export const DEFAULT_SETTINGS: Settings = {
  penStyle: DEFAULT_PEN_STYLE,
  enabled: true,
  // 默认关：要占 sync 配额，而且只有登录了 Chrome 才有意义。
  sync: false,
  // 引用常量而不是再写一遍字面量：两处各写一个值必然漂移。
  aiLang: DEFAULT_AI_LANGUAGE,
  aiThinking: false,
  aiPromptMode: {
    translate: {system: 'default', prompt: 'default'},
    explain: {system: 'default', prompt: 'default'}
  },
  // 自定义文案的默认值是空串（= 没写过）：内置文案只在 `prompt.ts` 定义一次，这里再存一份就会漂移。
  aiSystemTranslate: '',
  aiSystemExplain: '',
  aiPromptTranslate: '',
  aiPromptExplain: ''
}
