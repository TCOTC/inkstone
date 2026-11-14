/** URL 归一化：页面身份与页面匹配。 */

/**
 * 站点名：`hostname` 去掉 `www.`。非法 URL 返回空串。
 *
 * 页面记录里**不存**站点名，界面上要用时从这里派生——存一份就是多一份会失同步的副本。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * 页面的规范形式：**同时用作存储键**。
 *
 * 只做「不改变语义」的规范化——也就是 `new URL()` 免费给的那几件事：
 * scheme / host 小写、去默认端口、解析 `.` 与 `..`、空路径补 `/`、百分号编码统一。
 * 另外把 fragment 清空（RFC 3986 §6.1：检索比较时应排除 fragment）。
 *
 * **刻意不做**（每一条都会把不同资源并成一页）：
 * - 删 query 参数（追踪参数只在回退匹配时宽松处理，见 `looseKey`）
 * - 排序 query 参数
 * - 去尾斜杠（`/foo` 与 `/foo/` 可能是两页；RFC 3986 §6.2.4 要求先观察到重定向才能合并）
 * - 强制 https、删 `www.`、路径转小写、`index.html` → `/`、删默认分页参数
 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    // 不是合法绝对 URL（`about:blank`、扩展页、未编码的怪串）：退回只截 hash。
    return hashlessUrl(url)
  }
}

/**
 * Firefox ETP Strict 会剥掉的查询参数（2026-11 快照）。
 *
 * 出处：`https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/query-stripping/records`
 * 官方另有白名单 `googleadservices.com`（整域不剥），我们不做域名白名单——
 * 宽松键只在**唯一命中**时才被采用，误剥的后果是「退化为找不到」而不是「串页」。
 *
 * 注意 `utm_*` 不在这里：Firefox 不剥它，它只是 Google Analytics 定义的前缀。
 */
const TRACKING_PARAMS = new Set([
  'gclid',
  'dclid',
  'msclkid',
  '_openstat',
  'yclid',
  'wickedid',
  'twclid',
  '_hsenc',
  '__hssc',
  '__hstc',
  '__hsfp',
  'hsctatracking',
  'wbraid',
  'gbraid',
  'ysclid',
  'mc_eid',
  'oly_anon_id',
  'oly_enc_id',
  '__s',
  'vero_id',
  'mkt_tok',
  'fbclid'
])

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)
}

/**
 * 宽松键：在 `pageKey` 的基础上去掉追踪参数。
 *
 * **只在精确键未命中时用于回退比对**，永远不写进存储。这样「带 `?utm_source=` 的分享
 * 链接」仍能找到同一页，而两个真实不同的页面不会被合并成一个键。
 *
 * 只剥 `utm_*` 与 Firefox 那 21 个——`ref` / `ref_` / `from` / `source` / `q` / `url`
 * 这类在具体站点上有语义（搜索词、跳转目标、登录回跳），剥了会串页。
 */
export function looseKey(url: string): string {
  const canonical = pageKey(url)
  let parsed: URL
  try {
    parsed = new URL(canonical)
  } catch {
    return canonical
  }
  if (!parsed.search) return canonical

  const params = new URLSearchParams(parsed.search)
  for (const name of [...params.keys()]) {
    if (isTrackingParam(name)) params.delete(name)
  }
  parsed.search = params.toString() ? `?${params.toString()}` : ''
  return parsed.href
}

/** 去掉 `#` 及其后内容。`#inkstone-hl=` 深链与「打开扩展页时复用标签」用它。 */
export function hashlessUrl(url: string): string {
  const index = url.indexOf('#')
  return index < 0 ? url : url.substring(0, index)
}

/**
 * 两个 URL 是否指向同一页。与 `getPageByUrl` 的回退顺序一致：
 * 先比规范形式，再比去掉追踪参数的宽松形式。
 *
 * 用于「storage 变了，是不是本页的数据」这种廉价判定——两边的 URL 可能来自不同写法。
 */
export function samePageUrl(a: string, b: string): boolean {
  if (!a || !b) return false
  return pageKey(a) === pageKey(b) || looseKey(a) === looseKey(b)
}
