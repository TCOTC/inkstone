/**
 * 提示词的编辑状态（草稿、校验错误）与两个动作。
 *
 * 状态放在模块作用域而不是组件里：切到别的分组会把组件卸载，草稿不能跟着丢。
 */
import {ref, watch} from 'vue'
import {
  defaultPrompt,
  defaultSystem,
  normalizeCustomPrompt,
  normalizeCustomSystem,
  PROMPT_TEXT_SLOT,
  type AiAction
} from '../shared/prompt'
import {withPromptMode} from '../shared/settings'
import type {PromptKind, PromptMode, Settings} from '../shared/types'
import {settings, settingsRevision, updateSettings} from './settingsStore'

/** 各分组的字段：`system` 是角色设定（短），`user` 是完整任务模板（长）。 */
export const PROMPT_FIELDS = [
  {kind: 'system', label: '系统提示词', rows: 3},
  {kind: 'user', label: '用户提示词', rows: 8}
] as const satisfies readonly {kind: PromptKind; label: string; rows: number}[]

/** 自定义文案草稿（空串 = 没写过，切到「自定义」时用内置文案打底）。 */
export const drafts = ref<Record<AiAction, Record<PromptKind, string>>>({
  translate: {system: '', user: ''},
  explain: {system: '', user: ''}
})

/**
 * 校验错误（每槽一条）。**成功不写这里**——「已保存」由右下角统一提示，
 * 这一行只负责「为什么没存上」，否则四个字段各冒一句回执，比说明文字还吵。
 */
export const promptErrors = ref<Record<AiAction, Record<PromptKind, string>>>({
  translate: {system: '', user: ''},
  explain: {system: '', user: ''}
})

/** 内置文案——「默认」模式用的就是它，也是切到「自定义」时的起点。 */
function promptFallback(action: AiAction, kind: PromptKind): string {
  return kind === 'system' ? defaultSystem(action) : defaultPrompt(action)
}

/** 设置里存的自定义文案（空串 = 没写过）。 */
function storedCustom(action: AiAction, kind: PromptKind): string {
  if (kind === 'system') {
    return action === 'translate' ? settings.value.aiSystemTranslate : settings.value.aiSystemExplain
  }
  return action === 'translate' ? settings.value.aiPromptTranslate : settings.value.aiPromptExplain
}

function setError(action: AiAction, kind: PromptKind, text: string): void {
  promptErrors.value[action][kind] = text
}

/** 草稿是根据哪一版的设置加载的。与 `settingsRevision` 不同就说明该重读一次。 */
let loadedRevision = -1

/**
 * 把设置里的自定义文案同步到草稿。
 *
 * **不要**在每次保存提示词后调它——那会把用户正在编辑的另一段冲掉。
 */
function loadPrompts(): void {
  drafts.value = {
    translate: {system: storedCustom('translate', 'system'), user: storedCustom('translate', 'user')},
    explain: {system: storedCustom('explain', 'system'), user: storedCustom('explain', 'user')}
  }
  promptErrors.value = {
    translate: {system: '', user: ''},
    explain: {system: '', user: ''}
  }
  loadedRevision = settingsRevision.value
}

/**
 * 组件挂载时调。
 *
 * 比对读盘版本而不是「加载过一次就跳过」：在别的分组导入备份后，这一组才挂载，
 * 那时必须看到新设置；而在组间来回切换时版本没变，草稿不能被冲掉。
 */
export function ensurePromptsLoaded(): void {
  if (loadedRevision === settingsRevision.value) return
  loadPrompts()
}

/**
 * 直接打开 `#settings/ai` 时，这个模块会在 `refreshSettings()` 之前挂载：
 * 那时读到的是默认设置，草稿是空的。所以还要跟着读盘版本再重载一次。
 * 这里只 `loadPrompts()`，**不要**回调 `refreshSettings()`（会自我触发）。
 */
watch(settingsRevision, loadPrompts)

/** 取出某个动作的两块自定义文案（切到自定义时要一起落盘）。 */
function customTexts(action: AiAction, kind: PromptKind): [string, string] {
  const draft = drafts.value[action][kind]
  const system = kind === 'system' ? draft : storedCustom(action, 'system')
  const prompt = kind === 'user' ? draft : storedCustom(action, 'user')
  return [system, prompt]
}

/** 把某个动作的两块自定义文案包成一次设置修改。 */
function promptPatch(action: AiAction, system: string, prompt: string): Partial<Settings> {
  return action === 'translate'
    ? {aiSystemTranslate: system, aiPromptTranslate: prompt}
    : {aiSystemExplain: system, aiPromptExplain: prompt}
}

/**
 * 保存某一块自定义文案，并把这一槽切到「自定义」。
 *
 * user 模板里没有 `{{text}}` 时**不保存**：那样模型看不到选中的文字，等于坏了。
 */
export async function savePrompt(action: AiAction, kind: PromptKind): Promise<void> {
  const draft = drafts.value[action][kind]
  if (kind === 'user' && !draft.includes(PROMPT_TEXT_SLOT)) {
    setError(action, kind, `必须保留 ${PROMPT_TEXT_SLOT}，否则模型看不到选中的文字。`)
    return
  }
  setError(action, kind, '')
  const saved = kind === 'system' ? normalizeCustomSystem(draft) : normalizeCustomPrompt(draft)
  // 去首尾空白后的值回填到输入框，让「看到的」与「存下来的」始终是同一份。
  drafts.value[action][kind] = saved
  const [system, prompt] = customTexts(action, kind)
  const mode = withPromptMode(settings.value, action, kind, 'custom').aiPromptMode
  await updateSettings({...promptPatch(action, system, prompt), aiPromptMode: mode})
}

/**
 * 切换某一块的「默认 / 自定义」。
 *
 * **只改模式，不动自定义文案**——这正是两者分开存的价值：切回「默认」不会删掉写过的内容，
 * 再切回来就能拿回，所以不必弹「内容会丢失」的确认框。
 */
export async function setPromptMode(action: AiAction, kind: PromptKind, mode: PromptMode): Promise<void> {
  setError(action, kind, '')
  if (mode === 'custom' && !drafts.value[action][kind]) {
    drafts.value[action][kind] = promptFallback(action, kind)
  }
  const [system, prompt] = customTexts(action, kind)
  const next = withPromptMode(settings.value, action, kind, mode)
  await updateSettings({...promptPatch(action, system, prompt), aiPromptMode: next.aiPromptMode})
}
