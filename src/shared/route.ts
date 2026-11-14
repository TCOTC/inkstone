/**
 * hash 协议：管理页的视图切换、选中页，以及「跳到网页上的某条划线」。
 *
 * 这份协议同时被 content script（读 `#inkstone-hl=`）与管理页（读写 `#library`）使用，
 * 所以单独一层：它既不是「我的划线」的列表逻辑（`shared/library.ts`），
 * 也不是页面身份（`shared/url.ts`）。
 *
 * 不碰 DOM / 存储，方便单测。
 */
import {hashlessUrl, pageKey} from './url'

/** 跳到某条划线用的 hash 参数名。content script 读它做一次性定位。 */
export const ANCHOR_PARAM = 'inkstone-hl'

/**
 * 「我的划线」视图的 hash。
 *
 * 选中某页时变成 `#library/<encodeURIComponent(规范 URL)>`——**视图标识必须留在里面**，
 * 否则刷新页面会掉回偏好设置（入口是按 hash 分发视图的）。
 */
export const LIBRARY_HASH = '#library'

/**
 * 「偏好设置」的 hash。选某一组时变成 `#settings/<group>`。
 *
 * 空 hash 也落在偏好设置上（旧链接、工具栏菜单都这么打开），所以这里只是**显式化**：
 * 分组要能分享、要能在刷新后保持，就必须进地址栏。
 */
export const SETTINGS_HASH = '#settings'

/** 偏好设置的三个分组，顺序即左栏顺序。 */
export const SETTINGS_GROUPS = ['highlight', 'ai', 'data'] as const

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/** 默认分组（也是认不出分组时的落点）。 */
export const DEFAULT_SETTINGS_GROUP: SettingsGroup = 'highlight'

/** 认不出的分组一律落回第一组——地址栏是用户可手改的输入。 */
export function readSettingsGroup(hash: string): SettingsGroup {
  const prefix = `${SETTINGS_HASH}/`
  if (!hash.startsWith(prefix)) return DEFAULT_SETTINGS_GROUP
  const raw = hash.slice(prefix.length)
  return SETTINGS_GROUPS.find((group) => group === raw) ?? DEFAULT_SETTINGS_GROUP
}

/** 某组的 hash。 */
export function settingsGroupHash(group: SettingsGroup): string {
  return `${SETTINGS_HASH}/${group}`
}

/**
 * 给页面 URL 挂上「定位到这条划线」的 hash。
 *
 * 原来的 `#` 会被替换掉——同一个页面只可能定位一条划线。
 */
export function withHighlightAnchor(url: string, highlightId: number): string {
  return `${hashlessUrl(url)}#${ANCHOR_PARAM}=${highlightId}`
}

/** 从 `location.hash` 里读出划线 id；没有或格式不对时返回 `null`。 */
export function readHighlightAnchor(hash: string): number | null {
  const prefix = `#${ANCHOR_PARAM}=`
  if (!hash.startsWith(prefix)) return null
  const raw = hash.slice(prefix.length)
  if (!raw) return null
  // 只认纯十进制：地址栏是用户可手改的输入，`Number('0x10')`、`Number(' 3 ')` 都不该通过。
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 从 `location.hash` 里读出选中的页面键（`pageKey` 形式）；没选具体页面时返回 null。
 */
export function readSelectedPage(hash: string): string | null {
  const prefix = `${LIBRARY_HASH}/`
  if (!hash.startsWith(prefix)) return null
  const raw = hash.slice(prefix.length)
  if (!raw) return null
  try {
    return decodeURIComponent(raw) || null
  } catch {
    return null
  }
}

/** 选中某页时写进地址栏的 hash。 */
export function selectedPageHash(url: string): string {
  return `${LIBRARY_HASH}/${encodeURIComponent(pageKey(url))}`
}
