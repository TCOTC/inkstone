/**
 * 未定位划线的记录。
 *
 * 定位失败的划线不能就这样消失：把它们落进 `chrome.storage.local`，
 * 管理页可以逐条列出、带错误码查看。设计上坚持的原则是**失败可见、可诊断**。
 *
 * 键是 `hashlessUrl`（不带 fragment）：它只是「哪一页」，与页行的统计口径无关，
 * 所以不再是 `pageKey`，也不在条目里重复存一份。
 */
import {UNRESOLVED_KEY} from './storageKeys'
import {hashlessUrl} from './url'

export interface UnresolvedItem {
  id: number
  /** 原文预览（过长会截断），只用于列表展示 */
  preview: string
  errCode: number
}

export interface UnresolvedEntry {
  title: string
  /** 记录时刻（毫秒） */
  failedAt: number
  items: UnresolvedItem[]
}

export type UnresolvedMap = Record<string, UnresolvedEntry>

/** 一条带 URL 的清单项：URL 来自 map 的键。 */
export type UnresolvedPage = UnresolvedEntry & {url: string}

export async function loadUnresolved(): Promise<UnresolvedMap> {
  const stored = await chrome.storage.local.get(UNRESOLVED_KEY)
  return (stored[UNRESOLVED_KEY] as UnresolvedMap | undefined) ?? {}
}

/** 管理页用：按记录时刻倒序（新的在前）。 */
export async function listUnresolved(): Promise<UnresolvedPage[]> {
  const map = await loadUnresolved()
  return Object.entries(map)
    .map(([url, entry]) => ({url, ...entry}))
    .sort((a, b) => b.failedAt - a.failedAt)
}

/** 记录一个页面的未定位清单；空清单会删掉该页的记录。 */
export async function recordUnresolved(url: string, title: string, items: readonly UnresolvedItem[]): Promise<void> {
  const key = hashlessUrl(url)
  const map = await loadUnresolved()

  if (items.length === 0) {
    if (!(key in map)) return
    delete map[key]
    if (Object.keys(map).length === 0) {
      await chrome.storage.local.remove(UNRESOLVED_KEY)
      return
    }
  } else {
    map[key] = {title, failedAt: Date.now(), items: [...items]}
  }

  await chrome.storage.local.set({[UNRESOLVED_KEY]: map})
}

/** 直接删键：不留一个空对象在那里。 */
export async function clearUnresolved(): Promise<void> {
  await chrome.storage.local.remove(UNRESOLVED_KEY)
}
