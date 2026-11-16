import {SETTINGS_KEY} from './storageKeys'
import {DEFAULT_SETTINGS, type Extra, type PromptKind, type PromptMode, type PromptModes, type Settings} from './types'
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

/** 设置的已知键。其余键收进 `extra`，原样写回。 */
const SETTINGS_KEYS: readonly string[] = [
  'penStyle',
  'highlightEnabled',
  'syncHighlights',
  'translateLang',
  'aiThinking',
  'aiPromptMode',
  'aiSystemTranslate',
  'aiSystemExplain',
  'aiPromptTranslate',
  'aiPromptExplain',
  // `extra` 自己不是设置项：它承载的就是「不认识的键」，不能把自己再收进去套成两层。
  'extra'
]

/**
 * 收集未知键：既包括平铺在顶层的（手改 / 更旧的格式），也包括已经收在 `extra` 里的
 * （本模块上次写回的形态）。两处合起来才能保证「归一两次」与「归一一一次」结果相同。
 */
function takeExtra(value: Partial<Settings> & Record<string, unknown>): Extra | undefined {
  let extra: Extra | undefined
  const inherited = value.extra
  if (inherited && typeof inherited === 'object') extra = {...inherited}
  for (const key of Object.keys(value)) {
    if (SETTINGS_KEYS.includes(key)) continue
    extra ??= {}
    extra[key] = value[key]
  }
  return extra
}

/**
 * 把任意来源的设置收成合法值（存储 / 备份文件 / 手改过的 JSON）。
 *
 * **校验只写在这一处**：`penStyle` 越界时 `highlightName()` 会产出一个没有任何
 * `::highlight()` 规则的名字，结果是高亮静默消失——宁可退回默认值。
 *
 * 提示词的**模式与文案分开归一**：文案走 `normalizeCustom*()`（无效就存空串，不退回默认），
 * 模式走 `normalizeMode()`。退回默认是拼装层的事（`effectiveSystem()` / `effectivePrompt()`），
 * 设置里只负责如实记录用户填了什么。
 *
 * **不认识的字段进 `extra` 并原样保留**：新版加了设置项之后回退旧版本，旧版本既不会把
 * 那几项抹掉，也不会因为「不认识」而报错。代价是旧版本改不到它们（它本就不懂）。
 */
export function normalizeSettings(raw: unknown): Settings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings> & Record<string, unknown>
  const aiSystemTranslate = normalizeCustomSystem(value.aiSystemTranslate)
  const aiSystemExplain = normalizeCustomSystem(value.aiSystemExplain)
  const aiPromptTranslate = normalizeCustomPrompt(value.aiPromptTranslate)
  const aiPromptExplain = normalizeCustomPrompt(value.aiPromptExplain)
  const modes = value.aiPromptMode
  const extra = takeExtra(value)
  const settings: Settings = {
    penStyle: isPenStyle(value.penStyle) ? value.penStyle : DEFAULT_SETTINGS.penStyle,
    highlightEnabled:
      typeof value.highlightEnabled === 'boolean' ? value.highlightEnabled : DEFAULT_SETTINGS.highlightEnabled,
    syncHighlights:
      typeof value.syncHighlights === 'boolean' ? value.syncHighlights : DEFAULT_SETTINGS.syncHighlights,
    translateLang: normalizeTranslateLang(value.translateLang),
    aiThinking: typeof value.aiThinking === 'boolean' ? value.aiThinking : DEFAULT_SETTINGS.aiThinking,
    aiPromptMode: {
      translate: {
        system: normalizeMode(modes?.translate?.system),
        user: normalizeMode(modes?.translate?.user)
      },
      explain: {
        system: normalizeMode(modes?.explain?.system),
        user: normalizeMode(modes?.explain?.user)
      }
    },
    aiSystemTranslate,
    aiSystemExplain,
    aiPromptTranslate,
    aiPromptExplain
  }
  if (extra) settings.extra = extra
  return settings
}

/**
 * 模式归一：除 `custom` 外一律「默认」。
 *
 * 刻意**不**用「文案是否等于默认」推断模式：内置默认一改，那个猜法就把从没自定义过的人
 * 认成「自定义」，从此锁在旧文案上。文案归 `normalizeCustom*()` 管，两件事分开存。
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
  const custom = customText(settings, action, 'user')
  return settings.aiPromptMode[action].user === 'custom' && custom ? custom : defaultPrompt(action)
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

/** 目标语言：不认识的代码退回默认语言，否则 prompt 里会写出一个模型看不懂的名字。 */
function normalizeTranslateLang(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS.translateLang
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
    value.highlightEnabled === right.highlightEnabled &&
    value.syncHighlights === right.syncHighlights &&
    value.translateLang === right.translateLang &&
    value.aiThinking === right.aiThinking &&
    sameModes(value.aiPromptMode, right.aiPromptMode) &&
    value.aiSystemTranslate === right.aiSystemTranslate &&
    value.aiSystemExplain === right.aiSystemExplain &&
    value.aiPromptTranslate === right.aiPromptTranslate &&
    value.aiPromptExplain === right.aiPromptExplain &&
    extraKey(value.extra) === extraKey(right.extra)
  )
}

/**
 * `extra` 的结构不可知，只能序列化比较；先按键名排序，免得同一个对象因写入顺序不同被判成两份。
 * 嵌套对象仍按键序计入——`extra` 只在跨版本时才有内容，这点差异可以接受。
 */
function extraKey(extra: Extra | undefined): string {
  if (!extra || Object.keys(extra).length === 0) return ''
  return JSON.stringify(Object.keys(extra).sort().map((key) => [key, extra[key]]))
}

/** 四个槽逐一比模式（避免 JSON 序列化：键序变化不该算「改过」）。 */
function sameModes(left: PromptModes, right: PromptModes): boolean {
  return (['translate', 'explain'] as const).every(
    (action) => left[action].system === right[action].system && left[action].user === right[action].user
  )
}
