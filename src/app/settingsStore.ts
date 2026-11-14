/**
 * 设置页各分组共用的状态。
 *
 * 为什么不是各自的 `ref`：分组是同一个页面的四个视图，切换分组会把组件卸载重建；
 * 状态落在模块作用域才不会被卸载带走（尤其是「刚保存」的提示与提示词草稿）。
 *
 * 为什么不是 Pinia：只有一份状态、没有 devtools 需求，`ref` 就够了，也与
 * 「不引 vue-router / Pinia」的既有约定一致。
 */
import {ref} from 'vue'
import {loadSettings, saveSettings} from '../shared/settings'
import {DEFAULT_SETTINGS, type Settings} from '../shared/types'

/** 当前设置。**唯一可写入口是 `updateSettings()` / `replaceSettings()`**。 */
export const settings = ref<Settings>({...DEFAULT_SETTINGS})

/**
 * 保存反馈（右下角的短暂提示）。
 *
 * `ok` 两秒后自动消失；`error` 常驻到下一次操作——失败要能被看见，不能一闪而过。
 */
type SaveState = {text: string; kind: '' | 'ok' | 'error'}
export const saveState = ref<SaveState>({text: '', kind: ''})

/**
 * 外部重新读盘的计数。
 *
 * 提示词草稿不能无脑 `watch(settings)`：那会在每次保存提示词时把正在编辑的内容冲掉。
 * 只有「导入备份」这类外部改写才需要重载草稿，用这个计数区分。
 */
export const settingsRevision = ref(0)

const FLASH_MS = 1800
let flashTimer: ReturnType<typeof setTimeout> | null = null

function flashSaved(): void {
  if (flashTimer) clearTimeout(flashTimer)
  saveState.value = {text: '已保存', kind: 'ok'}
  flashTimer = setTimeout(() => {
    if (saveState.value.kind === 'ok') saveState.value = {text: '', kind: ''}
    flashTimer = null
  }, FLASH_MS)
}

function reportError(error: unknown): void {
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = null
  saveState.value = {
    text: `保存失败：${error instanceof Error ? error.message : String(error)}`,
    kind: 'error'
  }
}

/**
 * 写盘串行化。
 *
 * 两个控件在同一帧里各触发一次保存（例如改完画笔立刻改语言）时，`storage.local.set`
 * 的完成顺序不保证；串起来才能保证后一次的结果是最终值，而不是被先返回的旧值盖回去。
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/**
 * 改一部分字段并立刻落盘。
 *
 * 乐观更新：先改界面再写盘（写盘是异步的，等回来再改会让开关慢半拍）；
 * 失败时回滚并把错误摆到右下角。返回 `false` 表示没存上。
 */
export async function updateSettings(patch: Partial<Settings>): Promise<boolean> {
  const before = settings.value
  const next = {...before, ...patch}
  settings.value = next
  return enqueue(async () => {
    try {
      await saveSettings(next)
      flashSaved()
      return true
    } catch (error) {
      // 只在「还没被后续改动覆盖」时回滚，否则会把新值一起打回去。
      if (settings.value === next) settings.value = before
      reportError(error)
      return false
    }
  })
}

/** 从存储重新读一次（页面挂载、导入备份之后）。 */
export async function refreshSettings(): Promise<void> {
  settings.value = await loadSettings()
  settingsRevision.value += 1
}
