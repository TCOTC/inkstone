/**
 * 存储编码层：可读的内存结构 ↔ 短键的存储行。
 *
 * **只有这一处做映射**。`chrome.storage.local` 与备份文件存的都是短键行，其余代码一律用
 * `PageRecord` / `HighlightRecord`。键名取 1~2 个字母是为了体积（117 条划线下实测省
 * 2.55 KB，占总量 14%），代价全部关在这个文件里。键名本身见 `storageKeys.ts`。
 *
 * ```
 * 页面行  u=url  t=title  c=createdAtSec  h=highlights
 * 划线行  i=id   x=text   p=prev         q=next   c=createdAtSec
 * ```
 *
 * 页面的**存储键**是 `p:` + `pageKey(url)`，行里的 `u` 也存同一份原始 URL：备份文件是数组、
 * 没有键可用，回退匹配也要拿它做宽松比较。解码时统一归一到 `pageKey`，所以内存里的
 * `PageRecord.url` 与存储键必然一致。
 *
 * `x` 而不是 `t` 表示正文（`t` 留给页面标题）；`q` 而不是 `n` 表示后文。
 * 划线不存「谁创建的」：合并与导入都按内容签名判同一性，来源不影响任何行为。
 *
 * **不认识的键原样保留**（`extra`）：解码时收出来，编码时先 spread 回去，已知键写在后面覆盖。
 * 于是「新版导出 → 旧版导入 → 旧版导出」不会把新字段抹掉，旧版本不是单向过滤器。
 */
import {type Extra, type HighlightRecord, type PageRecord} from './types'
import {pageKey} from './url'

/** 页面行的已知键。其余键进 `extra`。 */
const PAGE_KEYS: readonly string[] = ['u', 't', 'c', 'h']
/** 划线行的已知键。 */
const HIGHLIGHT_KEYS: readonly string[] = ['i', 'x', 'p', 'q', 'c']

/** 收集 `known` 之外的键；没有时返回 `undefined`（不往对象里塞空壳）。 */
function takeExtra(source: Record<string, unknown>, known: readonly string[]): Extra | undefined {
  let extra: Extra | undefined
  for (const key of Object.keys(source)) {
    if (known.includes(key)) continue
    extra ??= {}
    extra[key] = source[key]
  }
  return extra
}

/**
 * 两份未知字段取并集，`override` 优先。都为空时返回 `undefined`。
 *
 * 用在「同一份数据有两个版本」的两处：跨设备合并（本机优先）与备份导入
 * （本机那份的未知字段不能被旧备份抹掉）。
 */
export function mergeExtra(base: Extra | undefined, override: Extra | undefined): Extra | undefined {
  const merged = {...base, ...override}
  return Object.keys(merged).length > 0 ? merged : undefined
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
  /** 秒级时间戳 */
  c: number
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
  return {
    ...highlight.extra,
    i: highlight.id,
    x: highlight.text,
    p: highlight.prev,
    q: highlight.next,
    c: highlight.createdAtSec
  }
}

export function decodeHighlight(row: HighlightRow): HighlightRecord {
  const extra = takeExtra(row as unknown as Record<string, unknown>, HIGHLIGHT_KEYS)
  const highlight: HighlightRecord = {
    id: seq(row.i),
    text: text(row.x),
    prev: text(row.p),
    next: text(row.q),
    createdAtSec: seconds(row.c)
  }
  if (extra) highlight.extra = extra
  return highlight
}

export function encodePage(page: PageRecord): PageRow {
  return {
    ...page.extra,
    u: page.url,
    t: page.title,
    c: page.createdAtSec,
    h: page.highlights.map(encodeHighlight)
  }
}

/**
 * 行 → 记录。`u` 在这里归一到 `pageKey`：内存里的 `url` 只有一种写法，
 * 于是 `pageStorageKey(page.url)` 永远等于它本来所在的键。
 * 不认识的键进 `extra`，编码时原样写回。
 */
export function decodePage(row: PageRow): PageRecord {
  const extra = takeExtra(row as unknown as Record<string, unknown>, PAGE_KEYS)
  const url = text(row.u)
  const page: PageRecord = {
    url: url ? pageKey(url) : '',
    title: text(row.t),
    createdAtSec: seconds(row.c),
    highlights: Array.isArray(row.h) ? row.h.map(decodeHighlight) : []
  }
  if (extra) page.extra = extra
  return page
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
