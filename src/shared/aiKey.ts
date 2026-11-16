/**
 * API Key：**磁盘密文，内存明文**。加密本体在 `shared/sealed.ts`，这里只管存取语义。
 *
 * 包装密钥也在同一份 storage 里，所以这层只挡「扫磁盘明文」与误操作，
 * 挡不住能读 profile 目录的程序。威胁模型与取舍见 `docs/design.md` §9.5。
 *
 * 密文与包装密钥会**成对**镜像到 `storage.sync`（见 `shared/sync.ts`）：分开搬运会出现
 * 「密文能拿到、密钥没有」的死状态，而缺密钥时这里只会解不开（不会凭空生成一把去覆盖同步区的）。
 */

import {ensureWrapKey, openText, readWrapKey, sealText, wrapBytes} from './sealed'
import {AI_KEY_STORAGE, AI_WRAP_STORAGE} from './storageKeys'

/** 只防手滑粘进一大段东西。 */
const MAX_KEY_LENGTH = 400

/** 加密与解密。保留这两个名字：调用方与用例都按「Key」称呼它。 */
export const sealKey = sealText
export const openKey = openText

/** 本机的密文与包装密钥。**同步时必须成对搬运**，否则解不开。 */
export interface KeyMaterial {
  key: string
  wrap: string
}

/** 读出本机存的那一对；没配过（或只存了一半）时返回 null。 */
export async function readKeyMaterial(): Promise<KeyMaterial | null> {
  const stored = await chrome.storage.local.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  const key = stored[AI_KEY_STORAGE]
  const wrap = stored[AI_WRAP_STORAGE]
  if (typeof key !== 'string' || !key) return null
  if (typeof wrap !== 'string' || !wrap) return null
  return {key, wrap}
}

/**
 * 采用另一台设备的密文与包装密钥。返回是否真的改动了本机。
 *
 * **先验证解得开再落盘**：落一份解不开的密文等于把「没配」与「配错了」混成一件事，
 * 而且这对象还会被镜像回同步区，把别的设备也弄坏。
 */
export async function adoptKeyMaterial(material: KeyMaterial): Promise<boolean> {
  const wrap = wrapBytes(material.wrap)
  if (!wrap) return false
  if ((await openKey(material.key, wrap)) === null) return false

  const stored = await chrome.storage.local.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  if (stored[AI_KEY_STORAGE] === material.key && stored[AI_WRAP_STORAGE] === material.wrap) return false
  await chrome.storage.local.set({[AI_WRAP_STORAGE]: material.wrap, [AI_KEY_STORAGE]: material.key})
  return true
}

/**
 * 读 Key，解密后返回明文（只存活在内存里）。没配过、解不开时返回空串。
 *
 * **解不开时不清掉密文**：这对键会镜像到同步区，本机一次「自愈」就是一次全网删除。
 * **包装密钥不在时也不新生成**：那会把同步区里那把覆盖掉，两台设备一起解不开。
 * 用户想换 Key 就直接重新填一次，不需要这里做清理。
 */
export async function loadAiKey(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
    const raw = stored[AI_KEY_STORAGE]
    if (typeof raw !== 'string' || raw === '') return ''
    const wrap = await readWrapKey(AI_WRAP_STORAGE)
    if (!wrap) return ''
    return (await openKey(raw, wrap)) ?? ''
  } catch {
    // 扩展上下文失效（更新后没刷新）时不要让整个入口抛错。
    return ''
  }
}

/**
 * 清掉本机的两个键。返回是否真的清掉了什么。
 *
 * 同步端收到「删除」标记时走这里（见 `shared/sync.ts` 的 `pullAiKey`）。
 */
export async function clearAiKey(): Promise<boolean> {
  const stored = await chrome.storage.local.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  if (stored[AI_KEY_STORAGE] === undefined && stored[AI_WRAP_STORAGE] === undefined) return false
  await chrome.storage.local.remove([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  return true
}

/** 写 Key（加密后落盘）。传空串等于清除。两端空白会被去掉（复制粘贴常带换行）。 */
export async function saveAiKey(raw: string): Promise<void> {
  const trimmed = raw.trim().slice(0, MAX_KEY_LENGTH)
  if (!trimmed) {
    // 连包装密钥一起清：用户既然要删除，就别在磁盘上留一把能解历史密文的密钥。
    await clearAiKey()
    return
  }
  const wrap = await ensureWrapKey(AI_WRAP_STORAGE)
  await chrome.storage.local.set({[AI_KEY_STORAGE]: await sealKey(trimmed, wrap)})
}

/** 界面上展示用的掩码：只露头尾，避免截图泄露。 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return '••••'
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
