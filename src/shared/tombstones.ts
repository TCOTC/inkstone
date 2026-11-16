/**
 * 删除墓碑（tombstone）。
 *
 * 为什么需要：同步只做并集的话，A 设备删掉的划线会被 B 设备的旧副本**复活**。
 * 所以「删一条」除了从页行里移掉，还要记下它的内容签名，等两边都同步过之后再清掉。
 *
 * 两处刻意的设计：
 * 1. **只用于同步合并**。本机读页面时从不看墓碑——否则「删掉 → 重新导入备份」会被
 *    墓碑挡住，看起来像导入失败。
 * 2. 有期限。签名只是「不建议再出现的旧内容」，留太久等于一份持续增长的隐藏数据；
 *    超过 `TOMBSTONE_TTL_MS` 或在单页超过 `MAX_PER_PAGE` 条就淘汰最旧的。
 */
import {highlightSignature} from './merge'
import {TOMBSTONES_KEY} from './storageKeys'
import type {HighlightRecord} from './types'

/** 保留期：两台设备都同步过的时间足够长，再久就该让内容回来了（例如站点恢复了原文）。 */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** 单页上限。正常使用远达不到，只是防止某页被反复增删时无限增长。 */
const MAX_PER_PAGE = 300

/** 页键（`pageKey`）→ 内容签名 → 删除时刻（毫秒）。 */
export type TombstoneMap = Record<string, Record<string, number>>

export async function loadTombstones(): Promise<TombstoneMap> {
  const stored = await chrome.storage.local.get(TOMBSTONES_KEY)
  const value = stored[TOMBSTONES_KEY]
  return value && typeof value === 'object' ? (value as TombstoneMap) : {}
}

async function saveTombstones(map: TombstoneMap): Promise<void> {
  await chrome.storage.local.set({[TOMBSTONES_KEY]: map})
}

/** 记下一条被删掉的划线。`pageKey` 是**存储键去掉前缀**后的规范 URL。 */
export async function recordDeletion(pageKey: string, highlight: HighlightRecord): Promise<void> {
  const map = await loadTombstones()
  const bucket = {...(map[pageKey] ?? {})}
  bucket[highlightSignature(highlight)] = Date.now()
  map[pageKey] = pruneBucket(bucket)
  await saveTombstones(pruneMap(map))
}

/** 清空（只在「清空全部数据」时跟着一起清）。直接删键，不留一个空对象在那里。 */
export async function clearTombstones(): Promise<void> {
  await chrome.storage.local.remove(TOMBSTONES_KEY)
}

function pruneBucket(bucket: Record<string, number>): Record<string, number> {
  const now = Date.now()
  const entries = Object.entries(bucket).filter(([, at]) => now - at < TOMBSTONE_TTL_MS)
  // 超上限时丢最旧的：签名是哈希串，没有语义顺序，只能按时间排。
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, MAX_PER_PAGE))
}

function pruneMap(map: TombstoneMap): TombstoneMap {
  const out: TombstoneMap = {}
  for (const [page, bucket] of Object.entries(map)) {
    const pruned = pruneBucket(bucket)
    if (Object.keys(pruned).length > 0) out[page] = pruned
  }
  return out
}
