import {DEFAULT_PEN_STYLE, type PenStyle} from './styles'
import {DEFAULT_AI_LANGUAGE, type AiAction} from './prompt'

/** 提示词的两块：`system` 是角色设定，`user` 是任务模板。 */
export type PromptKind = 'system' | 'user'

/**
 * 一块提示词两种状态：`default` 每次都取内置文案（改默认就能跟着升级），`custom` 取设置里那份。
 */
export type PromptMode = 'default' | 'custom'

/** 四个槽（两个动作 × 两块）各自的模式。 */
export type PromptModes = Record<AiAction, Record<PromptKind, PromptMode>>

/**
 * 跨版本保留的未知字段。
 *
 * 只存**本版本不认识的键**，原样带回写入端，所以「新版导出 → 旧版导入 → 旧版导出」
 * 不会把新字段抹掉。它不参与任何判断，也不该被业务代码读写。
 */
export type Extra = Record<string, unknown>

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
  /** 秒级时间戳，仅展示用。名字带单位，免得与毫秒的 tombstone / meta 混用 */
  createdAtSec: number
  /** 本版本不认识的存储字段（见 `Extra`） */
  extra?: Extra
}

/**
 * 一个页面的全部数据，划线内嵌存储（避免 join）。存储键就是页面身份，所以记录里不需要 id；
 * 站点名从 URL 派生，不存。
 */
export interface PageRecord {
  /** 规范形式的 URL（`pageKey`）；`decodePage` 负责归一，所以与存储键必然一致 */
  url: string
  title: string
  /** 秒级时间戳；「我的划线」的唯一排序键 */
  createdAtSec: number
  highlights: HighlightRecord[]
  /** 本版本不认识的存储字段（见 `Extra`） */
  extra?: Extra
}

export interface Settings {
  /** 1=荧光笔 2=实线下划线 3=虚线下划线 4=半透明底+下划线 */
  penStyle: PenStyle
  /** 关掉后 content script 不渲染也不响应划词 */
  highlightEnabled: boolean
  /** 只管划线数据是否镜像到 `storage.sync`；设置与 Key 始终镜像 */
  syncHighlights: boolean
  /** 翻译**目标**语言（含 `auto`）：中文译成英语、其余译成简体中文 */
  translateLang: string
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
  /**
   * 自动备份到 GitHub 的间隔（分钟）。**0 = 关闭**（默认）。
   * 只在连上 GitHub 且填了仓库时才有意义；取值限定在 `BACKUP_INTERVALS` 里。
   */
  autoBackupMinutes: number
  /** 本版本不认识的可序列化字段（见 `Extra`）：回退到旧版本再装新版时不至于丢新设置 */
  extra?: Extra
}

/**
 * 可选的自动备份间隔（分钟）。**0 表示关闭**。
 *
 * 只放这几档：`chrome.alarms` 的最小粒度是 1 分钟，但真按分钟备份只会把提交历史淹掉，
 * 而备份的价值全在「历史可读」上。
 */
export const BACKUP_INTERVALS = [0, 60, 360, 1440] as const

/**
 * 默认间隔：每小时。
 *
 * 它不是「默认开启备份」：排期还要「连上 GitHub」+「填了仓库」两个前提（见
 * `githubService.syncBackupAlarm`），两样都没有的人一条 alarm 也不会建。
 * 内容没变时不会产生提交，所以这一档不会把历史撑满。
 */
export const DEFAULT_BACKUP_MINUTES = 60

/** 每个档位的中文文案。键必须覆盖 `BACKUP_INTERVALS`（有用例锁着）。 */
export const BACKUP_INTERVAL_LABELS: Readonly<Record<number, string>> = {
  0: '关闭',
  60: '每小时',
  360: '每 6 小时',
  1440: '每天'
}

/**
 * 把任意来源的间隔收成合法值。
 *
 * 两件事分开：**缺字段**退回默认（老备份里没有这一项，不该因为导入就被关掉）；
 * **写了但不认识**当归零——那是明确的一个值，猜它想说什么不如让用户自己重选。
 */
export function normalizeBackupMinutes(value: unknown): number {
  if (value === undefined) return DEFAULT_BACKUP_MINUTES
  return typeof value === 'number' && (BACKUP_INTERVALS as readonly number[]).includes(value) ? value : 0
}

export const DEFAULT_SETTINGS: Settings = {
  penStyle: DEFAULT_PEN_STYLE,
  highlightEnabled: true,
  // 默认关：要占 sync 配额，而且只有登录了 Chrome 才有意义。
  syncHighlights: false,
  // 引用常量而不是再写一遍字面量：两处各写一个值必然漂移。
  translateLang: DEFAULT_AI_LANGUAGE,
  aiThinking: false,
  aiPromptMode: {
    translate: {system: 'default', user: 'default'},
    explain: {system: 'default', user: 'default'}
  },
  // 自定义文案的默认值是空串（= 没写过）：内置文案只在 `prompt.ts` 定义一次，这里再存一份就会漂移。
  aiSystemTranslate: '',
  aiSystemExplain: '',
  aiPromptTranslate: '',
  aiPromptExplain: '',
  // 默认每小时；真正排期还要「连上 GitHub」+「填了仓库」两个前提。
  autoBackupMinutes: DEFAULT_BACKUP_MINUTES
}
