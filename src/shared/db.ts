/**
 * 存储访问层。键布局（`p:` / `m:` / `settings` / `unresolved`）见 `rowCodec.ts`。
 *
 * 键就是 URL 本身：打开网页时一次命中，不需要「URL → id」索引，导入导出也天然幂等。
 * 用 storage 而不是 IndexedDB 的理由见 `docs/design.md` §4.1。
 */
import {
  decodePage,
  decodeRows,
  encodePage,
  isLocalHighlight,
  PAGE_PREFIX,
  pageStorageKey,
  type PageRow
} from './rowCodec'
import {isLiveLock, LOCK_PREFIX, withPageLock, withPageLocks} from './lock'
import {clearRemote, pushPage, removeRemotePage} from './sync'
import {clearTombstones, recordDeletion} from './tombstones'
import {type HighlightRecord, type PageRecord} from './types'
import {looseKey, pageKey} from './url'

/** 库级信息的键前缀。 */
const META_PREFIX = 'm:'

/**
 * 只读 `p:` 行；`h` 为空的顺手删掉（老版本留下的，正常写入不产出空行）。
 */
async function readRows(): Promise<Array<{key: string; row: PageRow}>> {
  const all = await chrome.storage.local.get(null)
  const rows: Array<{key: string; row: PageRow}> = []
  const empty: string[] = []
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PAGE_PREFIX)) continue
    const row = value as PageRow | undefined
    if (!row || !Array.isArray(row.h) || row.h.length === 0) {
      empty.push(key)
      continue
    }
    rows.push({key, row})
  }
  if (empty.length > 0) await chrome.storage.local.remove(empty)
  return rows
}

export async function listPages(): Promise<PageRecord[]> {
  const rows = await readRows()
  return decodeRows(rows.map((item) => item.row))
}

export async function getPage(url: string): Promise<PageRecord | null> {
  const key = pageStorageKey(url)
  const stored = await chrome.storage.local.get(key)
  const row = stored[key] as PageRow | undefined
  return row ? decodePage(row) : null
}

/**
 * 按 URL 找页面：精确键 → 按 `looseKey` 比键名，**只在唯一命中时**采用。
 * 多个候选宁可返回 null——挑错会把别人的划线画到这页上。
 * 第二级只读键名不读值：键就是 `p:` + `pageKey(行.u)`，不必反序列化整库。
 */
export async function getPageByUrl(url: string): Promise<PageRecord | null> {
  const exact = await getPage(url)
  if (exact) return exact

  const loose = looseKey(url)
  // 先按「问号之前的部分」字符串预筛（`looseKey` 只删 query 参数）：
  // 逐个键算 `looseKey` 是「打开无划线页面」这条最常见路径上的固定成本。
  const target = pageKey(url)
  const mark = target.indexOf('?')
  const bare = mark < 0 ? target : target.slice(0, mark)

  const keys = await chrome.storage.local.getKeys()
  const candidates = keys.filter((key) => {
    if (!key.startsWith(PAGE_PREFIX)) return false
    const stored = key.slice(PAGE_PREFIX.length)
    if (stored !== target) {
      const end = stored.indexOf('?')
      if ((end < 0 ? stored : stored.slice(0, end)) !== bare) return false
    }
    return looseKey(stored) === loose
  })
  if (candidates.length !== 1) return null

  const key = candidates[0] as string
  const stored = await chrome.storage.local.get(key)
  const row = stored[key] as PageRow | undefined
  return row ? decodePage(row) : null
}

export interface ImportSummary {
  added: number
  updated: number
  highlights: number
}

/**
 * 按 URL 覆盖同页数据，但保留带 `local` 标记的线（本机划的）。
 * 本地线要**重新编号**接在后面：序号是页内整数，不重编会与导入数据撞号，
 * 之后按 id 删除会一次删两条。整段在页锁内执行。
 */
export async function importPages(pages: readonly PageRecord[]): Promise<ImportSummary> {
  return withPageLocks(
    pages.map((item) => item.url),
    () => importLocked(pages)
  )
}

async function importLocked(pages: readonly PageRecord[]): Promise<ImportSummary> {
  const existing = await readRows()
  const known = new Map(existing.map((item) => [item.key, decodePage(item.row)]))

  let added = 0
  let updated = 0
  let highlights = 0
  const batch: Record<string, PageRow> = {}

  for (const incoming of pages) {
    const key = pageStorageKey(incoming.url)
    const previous = known.get(key)
    // 本地线全留，其余整批由本次数据取代。**不能**用「id 不在本次数据里」判：
    // 两边序号都从 1 开始，同号会把用户自己划的线误删。
    const kept = previous ? previous.highlights.filter((item) => item.local === true) : []
    if (incoming.highlights.length === 0 && kept.length === 0) {
      // 这一页在备份里是 0 条：空页不落地（规则见 `deleteHighlight`），本机那条也删掉。
      if (previous) await chrome.storage.local.remove(key)
      continue
    }
    let nextId = incoming.highlights.reduce((max, item) => (item.id > max ? item.id : max), 0)
    const carried = kept.map((item) => ({...item, id: (nextId += 1)}))
    added += previous ? 0 : 1
    updated += previous ? 1 : 0
    highlights += incoming.highlights.length
    batch[key] = encodePage({...incoming, highlights: [...incoming.highlights, ...carried]})
  }

  await chrome.storage.local.set(batch)
  await setMeta('importedAt', Date.now())
  await setMeta('sourceCounts', {pages: pages.length, highlights})
  // 导入是「本机权威」，整批推给同步端；远端多出来的线仍由并集合并保留。
  for (const page of pages) void pushPage(page.url)

  return {added, updated, highlights}
}

/**
 * 页内序号，1 起，取 max + 1。不用内容 hash / 随机串：它们不可复现、必须全表查重，
 * 而追加划线本来就要读出整页数据，max 顺手就有。删最大号后再划会复用那个序号，
 * 唯一影响是深链的历史值可能指向新线（深链不会被存成 URL）。
 */
function nextLocalId(highlights: readonly HighlightRecord[]): number {
  let max = 0
  for (const item of highlights) if (item.id > max) max = item.id
  return max + 1
}

/**
 * 追加一条本地线（页面不存在时创建）。`id` / `local` 由这里填，调用方不必凑主键；
 * 整段读 → 算序号 → 写在页锁内执行，并发写者拿到的序号一定不同。
 */
export async function addHighlight(
  url: string,
  draft: Omit<HighlightRecord, 'id' | 'local'>,
  title: string
): Promise<PageRecord> {
  return withPageLock(url, async () => {
    const existing = await getPageByUrl(url)
    const page: PageRecord = existing ?? {
      url: pageKey(url),
      title,
      createdAt: Math.floor(Date.now() / 1000),
      highlights: []
    }

    const highlight: HighlightRecord = {...draft, id: nextLocalId(page.highlights), local: true}
    const next: PageRecord = {...page, highlights: [...page.highlights, highlight]}

    // 键必须取自**记录自己的 URL**，不是传进来的 `url`：本页可能是靠回退匹配找到的
    // （URL 规范漂移、带追踪参数的分享链接），那条记录存在另一个键上。用 `url` 会写出
    // 第二条记录，于是同一页变成两条、旧划线在新记录里看不见。
    await chrome.storage.local.set({[pageStorageKey(next.url)]: encodePage(next)})
    void pushPage(next.url)
    return next
  })
}

export async function deleteHighlight(url: string, id: number): Promise<PageRecord | null> {
  return withPageLock(url, async () => {
    const page = await getPageByUrl(url)
    if (!page) return null
    // 先记墓碑再删：同步端靠它判断「这条是真被删了」而不是「另一台设备还没有」。
    // 墓碑只用于合并远端数据，本机读页面时不看它（否则重新导入备份会被挡住）。
    const removed = page.highlights.find((item) => item.id === id)
    if (removed) await recordDeletion(pageKey(page.url), removed)

    const key = pageStorageKey(page.url)
    const remaining = page.highlights.filter((item) => item.id !== id)
    if (remaining.length === 0) {
      // 删掉最后一条 → 整页记录一起删。一页没有划线时页行什么都显示不出来，留着只会
      // 变成「我的划线」里一条「0 条」的空条目（还白占同步端的项数额度）。
      // 返回 `null` 与「这一页没有记录」同义：content 那边按 `page` 为空重画。
      await chrome.storage.local.remove(key)
      // 同步端是按键整值写的，这里**必须删键**而不是推一行空页行——空行会被另一台设备
      // 当成「本机数据」存下来，于是 0 条的条目在那边长出来。
      void removeRemotePage(page.url)
      return null
    }

    const next: PageRecord = {...page, highlights: remaining}
    await chrome.storage.local.set({[key]: encodePage(next)})
    void pushPage(next.url)
    return next
  })
}

export async function getMeta<T = unknown>(name: string): Promise<T | null> {
  const key = META_PREFIX + name
  const stored = await chrome.storage.local.get(key)
  return (stored[key] as T | undefined) ?? null
}

export async function setMeta(name: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({[META_PREFIX + name]: value})
}

/**
 * 清空数据：删本地 `p:`、`m:`、墓碑与已过期的写锁，**以及同步端的页行**，
 * 不动设置与未定位清单。
 *
 * 同步端也必须清：否则下次启动的全量拉取会把整库原样搬回来，看起来像「清空失败」。
 * 还在租期内的锁不碰——那种只可能是别的标签页正在写入。
 */
export async function clearAll(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const keys = Object.keys(all).filter((key) => {
    if (key.startsWith(PAGE_PREFIX) || key.startsWith(META_PREFIX)) return true
    return key.startsWith(LOCK_PREFIX) && !isLiveLock(all[key])
  })
  if (keys.length > 0) await chrome.storage.local.remove(keys)
  // 墓碑跟着走：记录里已经没有任何划线，留着它们只会挡住以后的重新导入。
  await clearTombstones()
  await clearRemote()
}

/** 统计口径：页行里的划线只会是 1 条以上（空页不落地），所以不再单列「有划线的页数」。 */
export interface DatabaseStats {
  pages: number
  highlights: number
  localHighlights: number
  importedAt: number | null
}

export async function stats(): Promise<DatabaseStats> {
  const pages = await listPages()
  let highlights = 0
  let localHighlights = 0

  for (const page of pages) {
    for (const item of page.highlights) {
      highlights += 1
      if (isLocalHighlight(item)) localHighlights += 1
    }
  }

  return {
    pages: pages.length,
    highlights,
    localHighlights,
    importedAt: await getMeta<number>('importedAt')
  }
}
