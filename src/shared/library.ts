/**
 * 「我的划线」列表页的纯逻辑：搜索与排序。
 *
 * 不碰 DOM / 存储，方便单测。hash 协议（`#library`、`#inkstone-hl=`）在 `shared/route.ts`。
 */
import type {PageRecord} from './types'
import {hostOf} from './url'

/**
 * 每页的搜索文本（大小写折叠后）。
 *
 * 缓存键是**页面对象本身**：管理页的 `pages` 只在加载时整体替换一次，对象身份稳定；
 * 导入/新增会产出新的 `PageRecord`，于是自然落到新的一条缓存上。
 * 不要改成按 URL 缓存——同一 URL 的标题与划线会在导入后变化。
 */
const searchTextCache = new WeakMap<PageRecord, string>()

/**
 * 搜索用的扁平文本：标题 + URL + 站点名 + 每条划线正文。
 *
 * 站点名是派生的（`hostOf`），所以搜「知乎」能命中 `zhuanlan.zhihu.com`，
 * 而不用把站点名存进每条记录。
 *
 * 搜索框每敲一个键都会重跑一遍过滤；不缓存时这一项按「全部页面的全部划线正文」
 * 线性计价（2000 页 / 16000 条实测 2.5 ms 一次按键）。
 */
function searchText(page: PageRecord): string {
  const cached = searchTextCache.get(page)
  if (cached !== undefined) return cached

  const parts = [page.title, page.url, hostOf(page.url)]
  for (const highlight of page.highlights) parts.push(highlight.text)
  const text = parts.join('\n').toLowerCase()
  searchTextCache.set(page, text)
  return text
}

/**
 * 按关键词过滤。空关键词返回全部（引用原数组顺序，调用方自己排）。
 *
 * 匹配范围刻意包含划线正文：用户常常只记得「那句话」，不记得标题。
 */
export function filterPages(pages: readonly PageRecord[], query: string): PageRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...pages]
  return pages.filter((page) => searchText(page).includes(needle))
}

/** 按创建时间倒序（新的在前），同时间用 URL 兜底，保证顺序稳定。 */
export function sortPages(pages: readonly PageRecord[]): PageRecord[] {
  return [...pages].sort((a, b) => b.createdAtSec - a.createdAtSec || a.url.localeCompare(b.url))
}
