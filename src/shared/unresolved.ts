/**
 * 未定位划线的记录。
 *
 * 定位失败的划线不能就这样消失：把它们落进 `chrome.storage.local`，
 * 管理页可以逐条列出、带错误码查看。设计上坚持的原则是**失败可见、可诊断**。
 */
import {hashlessUrl} from './url'

const STORAGE_KEY = 'unresolved'

export interface UnresolvedItem {
  id: number
  text: string
  errCode: number
  mode: number
}

export interface UnresolvedEntry {
  url: string
  title: string
  at: number
  items: UnresolvedItem[]
}

export type UnresolvedMap = Record<string, UnresolvedEntry>

export async function loadUnresolved(): Promise<UnresolvedMap> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return (stored[STORAGE_KEY] as UnresolvedMap | undefined) ?? {}
}

async function saveUnresolved(map: UnresolvedMap): Promise<void> {
  await chrome.storage.local.set({[STORAGE_KEY]: map})
}

/** 记录一个页面的未定位清单；空清单会删掉该页的旧记录。 */
export async function recordUnresolved(url: string, title: string, items: readonly UnresolvedItem[]): Promise<void> {
  const key = hashlessUrl(url)
  const map = await loadUnresolved()

  if (items.length === 0) {
    if (!(key in map)) return
    delete map[key]
  } else {
    map[key] = {url: key, title, at: Date.now(), items: [...items]}
  }

  await saveUnresolved(map)
}

export async function clearUnresolved(): Promise<void> {
  await saveUnresolved({})
}
