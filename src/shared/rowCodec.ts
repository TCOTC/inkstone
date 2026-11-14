/**
 * 存储编码层：可读的内存结构 ↔ 短键的存储行。
 *
 * **只有这一处做映射**。`chrome.storage.local` 与备份文件存的都是短键行，其余代码一律用
 * `PageRecord` / `HighlightRecord`。键名取 1~2 个字母是为了体积（117 条划线下实测省
 * 2.55 KB，占总量 14%），代价全部关在这个文件里。
 *
 * ```
 * 页面行  u=url  t=title  c=createdAt  h=highlights
 * 划线行  i=id   x=text   p=prev       q=next   c=createdAt   l=本地
 * ```
 *
 * 页面的**存储键**是 `p:` + `pageKey(url)`，不在行里重复存。行里的 `u` 是原始 URL：
 * 备份文件是数组、没有键可用，且回退匹配要拿它做宽松比较。
 *
 * `x` 而不是 `t` 表示正文（`t` 留给页面标题）；`q` 而不是 `n` 表示后文。
 * `l` 只在本地新划的线上出现（值为 `1`）：来源靠字段表达，不塞进 id。
 */
import {type HighlightRecord, type PageRecord} from './types'
import {pageKey} from './url'

/** 页面键前缀。`listPages` / 同步都靠它从整个 storage 里筛出页面。 */
export const PAGE_PREFIX = 'p:'

/** 某页在存储里的键（`chrome.storage.local` 与 `chrome.storage.sync` 都用它）。 */
export function pageStorageKey(url: string): string {
  return PAGE_PREFIX + pageKey(url)
}

/** 页面行（存储形状）。 */
export interface PageRow {
  u: string
  t: string
  c: number
  h: HighlightRow[]
}

/** 划线行（存储形状）。 */
export interface HighlightRow {
  /** 页内序号（整数） */
  i: number
  x: string
  p: string
  q: string
  c: number
  /** 本地新划的标记；导入的行没有这个键 */
  l?: 1
}

/**
 * 这条划线是不是本地新划的。
 *
 * 来源靠 `local` 字段表达，不再从 id 的前缀猜：id 是主键，不该兼职当标签。
 */
export function isLocalHighlight(highlight: HighlightRecord): boolean {
  return highlight.local === true
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 序号是整数；没写或写坏时给 0（页内序号从 1 起，所以 0 一定不是合法 id）。 */
function seq(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function seconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function encodeHighlight(highlight: HighlightRecord): HighlightRow {
  const row: HighlightRow = {
    i: highlight.id,
    x: highlight.text,
    p: highlight.prev,
    q: highlight.next,
    c: highlight.createdAt
  }
  if (highlight.local) row.l = 1
  return row
}

export function decodeHighlight(row: HighlightRow): HighlightRecord {
  const highlight: HighlightRecord = {
    id: seq(row.i),
    text: text(row.x),
    prev: text(row.p),
    next: text(row.q),
    createdAt: seconds(row.c)
  }
  if (row.l === 1) highlight.local = true
  return highlight
}

export function encodePage(page: PageRecord): PageRow {
  return {
    u: page.url,
    t: page.title,
    c: page.createdAt,
    h: page.highlights.map(encodeHighlight)
  }
}

export function decodePage(row: PageRow): PageRecord {
  return {
    url: text(row.u),
    title: text(row.t),
    createdAt: seconds(row.c),
    highlights: Array.isArray(row.h) ? row.h.map(decodeHighlight) : []
  }
}

/**
 * 一行是不是本扩展认识的页面行。
 *
 * 只校验**定位必需的**一项：没有 `url` 的记录无法匹配到任何网页，也没有键可写。
 * 其余字段缺失按默认值补齐——手改备份后少写一个 `p` 不该让整份文件导入失败。
 */
export function isPageRow(value: unknown): value is PageRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<PageRow>
  return typeof row.u === 'string' && row.u.length > 0
}

/** 批量解码，丢掉不认识的记录（备份文件可能被人手改坏）。 */
export function decodeRows(rows: readonly unknown[]): PageRecord[] {
  const pages: PageRecord[] = []
  for (const row of rows) {
    if (!isPageRow(row)) continue
    pages.push(decodePage(row))
  }
  return pages
}
