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

/**
 * 上一次重注入用到的内容脚本构建指纹。
 *
 * **必须放 `chrome.storage.session`，不能放 `local`**。两者的失效时机正好卡在我们要区分的事件上：
 *
 * - worker 因空闲被回收（30 秒无事件）：**不清空** → 同一个构建不会重复注入；
 * - 扩展被 reload / 更新：`SessionStorageManager::OnExtensionUnloaded` 会 `Clear()`，
 *   **session 清空** → 记账归零，于是重新注入。
 *
 * 用 `local` 记的话，「点刷新扩展但没重新 build」与「worker 闲置重启」指纹相同，
 * 前者明明需要重注入却会被跳过 —— 那正是「刷新后标签页工具条只剩刷新按钮」的成因。
 */
export const BUILD_MARK_KEY = 'm:build'

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

/** GitHub 授权密文（access + refresh + 到期时刻，整体加密成一个值）。 */
export const GH_TOKEN_STORAGE = 'gh:token'

/** GitHub 的包装密钥，与上一条成对使用。**不镜像到同步区**：重装后本来就要重新登录。 */
export const GH_WRAP_STORAGE = 'gh:wrap'

/** 备份目标仓库（`owner/repo`，明文）。 */
export const GH_REPO_STORAGE = 'gh:repo'

/** 某页在存储里的键（`chrome.storage.local` 与 `chrome.storage.sync` 都用它）。 */
export function pageStorageKey(url: string): string {
  return PAGE_PREFIX + pageKey(url)
}

/** 写锁的完整键。身份是 `looseKey(url)`，不是存储键（见 `shared/lock.ts`）。 */
export function lockStorageKey(identity: string): string {
  return LOCK_PREFIX + identity
}
