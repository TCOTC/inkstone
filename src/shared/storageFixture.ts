/**
 * 测试替身：`chrome.storage.local` + `chrome.storage.sync` 的内存实现。
 *
 * **只给 `*.test.ts` 用**，不进产物。
 *
 * 每次操作都异步等 `delay` 毫秒，这是刻意的：同步实现的假 store 会让「读 → 改 → 写」
 * 之间的竞态窗口消失，互斥相关的测试就永远是绿的。需要放大窗口时传大一点的值。
 */

export type Store = Map<string, unknown>

export interface FakeArea {
  get: (keys: string | string[] | null) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
  getKeys: () => Promise<string[]>
  getBytesInUse: (keys: string | string[] | null) => Promise<number>
}

export interface FakeChrome {
  storage: {local: FakeArea; sync: FakeArea}
}

/** 装上假 store。省略 `syncStore` 时 `storage.sync` 用另一个空 map（与 local 独立）。 */
export function installStorage(store: Store, delay = 2, syncStore: Store = new Map()): FakeChrome {
  const chrome: FakeChrome = {storage: {local: makeArea(store, delay), sync: makeArea(syncStore, delay)}}
  ;(globalThis as unknown as {chrome: FakeChrome}).chrome = chrome
  return chrome
}

function makeArea(store: Store, delay: number): FakeArea {
  const pause = (): Promise<void> => (delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve())
  return {
    async get(keys) {
      await pause()
      if (keys === null) return Object.fromEntries(store)
      const wanted = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
      return out
    },
    async set(items) {
      await pause()
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    },
    async remove(keys) {
      await pause()
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
    },
    async getKeys() {
      await pause()
      return [...store.keys()]
    },
    async getBytesInUse(keys) {
      await pause()
      const wanted = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]
      let total = 0
      for (const key of wanted) {
        if (!store.has(key)) continue
        total += new TextEncoder().encode(JSON.stringify({[key]: store.get(key)})).length
      }
      return total
    }
  }
}
