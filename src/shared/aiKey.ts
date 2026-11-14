/**
 * API Key：**磁盘密文，内存明文**（AES-GCM，包装密钥与密文分两个键）。
 *
 * 包装密钥也在同一份 storage 里，所以这层只挡「扫磁盘明文」与误操作，
 * 挡不住能读 profile 目录的程序。威胁模型与取舍见 `docs/design.md` §9.5。
 * 包装密钥不写死、也不用扩展 ID 派生：开发版 ID 随加载路径变，派生会让 key 解不开。
 *
 * 密文与包装密钥会**成对**镜像到 `storage.sync`（见 `shared/sync.ts`）：分开搬运会出现
 * 「密文能拿到、密钥没有」的死状态，而本模块每次都会重新生成一把包装密钥。
 */

export const AI_KEY_STORAGE = 'ai:key'
/** 与密文分两个键，便于单独重置。 */
export const AI_WRAP_STORAGE = 'ai:wrap'

/** 只防手滑粘进一大段东西。 */
const MAX_KEY_LENGTH = 400

/** 带版本是为了将来换算法时能识别旧格式，也用来区分「旧版明文」。 */
const TOKEN_PREFIX = 'v1:'
/** AES-GCM 的 IV 长度（规范要求 12 字节）。 */
const IV_BYTES = 12
/** 包装密钥长度（AES-256）。 */
const WRAP_BYTES = 32

function toBase64(bytes: Uint8Array): string {
  let latin = ''
  for (const byte of bytes) latin += String.fromCharCode(byte)
  return btoa(latin)
}

/**
 * 显式标 `Uint8Array<ArrayBuffer>`：`crypto.subtle` 的入参是 `BufferSource`，
 * 而裸 `Uint8Array` 的泛型默认是 `ArrayBufferLike`（可能含 `SharedArrayBuffer`），
 * strict 下会被判成不可赋值。
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const latin = atob(text)
    const bytes = new Uint8Array(latin.length)
    for (let i = 0; i < latin.length; i++) bytes[i] = latin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

async function importWrapKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/**
 * 加密。返回 `v1:<base64(iv || ciphertext)>`。
 *
 * AES-GCM 带认证标签：密文被改过就解不开（返回 null），不会静默给出错误明文。
 * IV 每次随机——重复 IV 会让 AES-GCM 直接失去安全性，这是最容易写错的一处。
 */
export async function sealKey(plain: string, wrapKeyRaw: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await importWrapKey(wrapKeyRaw)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(plain))
  )
  const joined = new Uint8Array(iv.length + cipher.length)
  joined.set(iv, 0)
  joined.set(cipher, iv.length)
  return TOKEN_PREFIX + toBase64(joined)
}

/**
 * 解密。任何失败（前缀不对、base64 坏了、认证失败、密钥不匹配）都返回 `null`。
 *
 * **不抛错**是有意的：调用方只想问「能拿到 key 吗」，拿不到就当没配，
 * 让用户重填比在页面上抛一个 WebCrypto 的 DOMException 有用。
 */
export async function openKey(
  token: string,
  wrapKeyRaw: Uint8Array<ArrayBuffer>
): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const bytes = fromBase64(token.slice(TOKEN_PREFIX.length))
  if (!bytes || bytes.length <= IV_BYTES) return null
  try {
    const key = await importWrapKey(wrapKeyRaw)
    const plain = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES)},
      key,
      bytes.subarray(IV_BYTES)
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/**
 * 读包装密钥；没有就生成一个并落盘。
 *
 * 生成后再**回读一次**：两个上下文可能同时首次写入，后写的会覆盖先写的。
 * 回读保证返回的确实是磁盘上那一份，否则用它加密出来的密文下次解不开。
 */
async function ensureWrapKey(): Promise<Uint8Array<ArrayBuffer>> {
  const stored = await chrome.storage.local.get(AI_WRAP_STORAGE)
  const existing = stored[AI_WRAP_STORAGE]
  if (typeof existing === 'string') {
    const bytes = fromBase64(existing)
    if (bytes && bytes.length === WRAP_BYTES) return bytes
  }
  const fresh = crypto.getRandomValues(new Uint8Array(WRAP_BYTES))
  await chrome.storage.local.set({[AI_WRAP_STORAGE]: toBase64(fresh)})
  const check = await chrome.storage.local.get(AI_WRAP_STORAGE)
  const bytes = typeof check[AI_WRAP_STORAGE] === 'string' ? fromBase64(check[AI_WRAP_STORAGE]) : null
  return bytes && bytes.length === WRAP_BYTES ? bytes : fresh
}

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

/** 校验并解出包装密钥的原始字节。 */
function wrapBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null
  const bytes = fromBase64(value)
  return bytes && bytes.length === WRAP_BYTES ? bytes : null
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
    const wrap = wrapBytes(stored[AI_WRAP_STORAGE])
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
  const wrap = await ensureWrapKey()
  await chrome.storage.local.set({[AI_KEY_STORAGE]: await sealKey(trimmed, wrap)})
}

/** 界面上展示用的掩码：只露头尾，避免截图泄露。 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return '••••'
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
