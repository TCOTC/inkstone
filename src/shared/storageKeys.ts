/**
 * 存储键的**唯一出处**。所有模块从这里取键名，不要在别处写字面量。
 *
 * 两类键：
 * - 页行：`p:` + `pageKey(url)`，一页一个键，local 与 sync 同名同形；
 * - 单例键：设置、墓碑、未定位清单、API Key、页级写锁、库级元信息。
 */
import {pageKey} from './url'

/** 页行前缀。`listPages` / 同步都靠它从整个 storage 里筛出页面。 */
export const PAGE_PREFIX = 'p:'

/** 库级信息的键前缀（`m:` + 名字），只放一次性事件的时间戳。 */
export const META_PREFIX = 'm:'

/** 页级写锁的键前缀。锁住在 storage 里，才能被别的标签页看到。 */
export const LOCK_PREFIX = 'lock:'

/** 设置在 local 与 sync 用同一个键名：local 是权威，sync 是镜像。 */
export const SETTINGS_KEY = 'settings'

/** 删除墓碑：`pageKey` → 内容签名 → 删除时刻（毫秒）。 */
export const TOMBSTONES_KEY = 'tombstones'

/** 未定位清单：`hashlessUrl` → 该页的失败项。 */
export const UNRESOLVED_KEY = 'unresolved'

/** API Key 密文。 */
export const AI_KEY_STORAGE = 'ai:key'

/** 包装密钥，与密文成对搬运。 */
export const AI_WRAP_STORAGE = 'ai:wrap'

/** 某页在存储里的键（`chrome.storage.local` 与 `chrome.storage.sync` 都用它）。 */
export function pageStorageKey(url: string): string {
  return PAGE_PREFIX + pageKey(url)
}

/** 写锁的完整键。身份是 `looseKey(url)`，不是存储键（见 `shared/lock.ts`）。 */
export function lockStorageKey(identity: string): string {
  return LOCK_PREFIX + identity
}
