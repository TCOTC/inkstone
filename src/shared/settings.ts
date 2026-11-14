import {DEFAULT_SETTINGS, type PromptKind, type PromptMode, type PromptModes, type Settings} from './types'
import {isPenStyle} from './styles'
import {
  AI_LANGUAGES,
  DEFAULT_AI_LANGUAGE,
  defaultPrompt,
  defaultSystem,
  normalizeCustomPrompt,
  normalizeCustomSystem,
  type AiAction
} from './prompt'

/**
 * 设置在两个存储区里用**同一个键名**：`storage.local` 是本机权威，
 * `storage.sync` 是镜像（见 `shared/sync.ts` 的 `pushSettings`）。
 */
export const SETTINGS_KEY = 'settings'

/**
 * 把任意来源的设置收成合法值（存储 / 备份文件 / 手改过的 JSON）。
 *
 * **校验只写在这一处**：`penStyle` 越界时 `highlightName()` 会产出一个没有任何
 * `::highlight()` 规则的名字，结果是高亮静默消失——宁可退回默认值。
 *
 * 提示词的**模式与文案分开归一**：文案走 `normalizeCustom*()`（无效就存空串，不退回默认），
 * 模式走 `normalizeMode()`。退回默认是拼装层的事（`effectiveSystem()` / `effectivePrompt()`），
 * 设置里只负责如实记录用户填了什么。
 */
export function normalizeSettings(raw: unknown): Settings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  const aiSystemTranslate = normalizeCustomSystem(value.aiSystemTranslate)
  const aiSystemExplain = normalizeCustomSystem(value.aiSystemExplain)
  const aiPromptTranslate = normalizeCustomPrompt(value.aiPromptTranslate)
  const aiPromptExplain = normalizeCustomPrompt(value.aiPromptExplain)
  const modes = value.aiPromptMode
  return {
    penStyle: isPenStyle(value.penStyle) ? value.penStyle : DEFAULT_SETTINGS.penStyle,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    sync: typeof value.sync === 'boolean' ? value.sync : DEFAULT_SETTINGS.sync,
    aiLang: normalizeLang(value.aiLang),
    aiThinking: typeof value.aiThinking === 'boolean' ? value.aiThinking : DEFAULT_SETTINGS.aiThinking,
    aiPromptMode: {
      translate: {
        system: normalizeMode(modes?.translate?.system),
        prompt: normalizeMode(modes?.translate?.prompt)
      },
      explain: {
        system: normalizeMode(modes?.explain?.system),
        prompt: normalizeMode(modes?.explain?.prompt)
      }
    },
    aiSystemTranslate,
    aiSystemExplain,
    aiPromptTranslate,
    aiPromptExplain
  }
}

/**
 * 模式归一。**缺字段就是「默认」**——包括旧版本落盘的设置。
 *
 * 旧版本没有这个字段，只能靠「文案是否等于默认」猜，而那个猜法有个治不好的毛病：
 * 内置默认一改，旧值就不再等于新默认，从没自定义过的人也会被认成「自定义」，从此锁在
 * 旧文案上。所以这次升级**只判一次**，一律按「默认」处理：内置文案能继续升级。
 * 旧文案不会被删（它仍在 `aiSystem*` / `aiPrompt*` 里），设置页会提示「切到自定义即可恢复」。
 */
function normalizeMode(raw: unknown): PromptMode {
  return raw === 'custom' ? 'custom' : 'default'
}

/** 取某个槽存的自定义文案（空串 = 没写过）。 */
function customText(settings: Settings, action: AiAction, kind: PromptKind): string {
  if (kind === 'system') {
    return action === 'translate' ? settings.aiSystemTranslate : settings.aiSystemExplain
  }
  return action === 'translate' ? settings.aiPromptTranslate : settings.aiPromptExplain
}

/**
 * 这个动作**实际会发出去**的 system。
 *
 * 只有「模式是自定义」且「自定义文案确实写过」时才用它；否则取内置默认。
 * 两个条件都要判：显式模式可能指向一段空文案（用户切了自定义但还没填、或旧数据被清过），
 * 那时退回默认比发一条空的 system 给模型好。
 */
export function effectiveSystem(settings: Settings, action: AiAction): string {
  const custom = customText(settings, action, 'system')
  return settings.aiPromptMode[action].system === 'custom' && custom ? custom : defaultSystem(action)
}

/** 这个动作实际会发出去的 user 模板，规则同上。 */
export function effectivePrompt(settings: Settings, action: AiAction): string {
  const custom = customText(settings, action, 'prompt')
  return settings.aiPromptMode[action].prompt === 'custom' && custom ? custom : defaultPrompt(action)
}

/** 改某一槽的模式（返回新对象，不动原对象）。 */
export function withPromptMode(
  settings: Settings,
  action: AiAction,
  kind: PromptKind,
  mode: PromptMode
): Settings {
  const current: PromptModes = settings.aiPromptMode
  return {
    ...settings,
    aiPromptMode: {
      ...current,
      [action]: {...current[action], [kind]: mode}
    }
  }
}

/** 语言：不认识的代码退回默认语言，否则 prompt 里会写出一个模型看不懂的名字。 */
function normalizeLang(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS.aiLang
  return AI_LANGUAGES.some((item) => item.code === raw) ? raw : DEFAULT_AI_LANGUAGE
}

/** 读设置，与默认值合并。 */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  return normalizeSettings(stored[SETTINGS_KEY])
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({[SETTINGS_KEY]: settings})
}

/**
 * 两份设置是不是同一个值（比较前先归一，所以「缺字段」与「显式默认值」相等）。
 *
 * 同步靠它判断「要不要写」：写 `storage.sync` 有每分钟配额，镜像一次设置不该白烧一次。
 */
export function sameSettings(left: unknown, right: Settings): boolean {
  const value = normalizeSettings(left)
  return (
    value.penStyle === right.penStyle &&
    value.enabled === right.enabled &&
    value.sync === right.sync &&
    value.aiLang === right.aiLang &&
    value.aiThinking === right.aiThinking &&
    sameModes(value.aiPromptMode, right.aiPromptMode) &&
    value.aiSystemTranslate === right.aiSystemTranslate &&
    value.aiSystemExplain === right.aiSystemExplain &&
    value.aiPromptTranslate === right.aiPromptTranslate &&
    value.aiPromptExplain === right.aiPromptExplain
  )
}

/** 四个槽逐一比模式（避免 JSON 序列化：键序变化不该算「改过」）。 */
function sameModes(left: PromptModes, right: PromptModes): boolean {
  return (['translate', 'explain'] as const).every(
    (action) => left[action].system === right[action].system && left[action].prompt === right[action].prompt
  )
}
