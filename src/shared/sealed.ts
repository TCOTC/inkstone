/**
 * 磁盘密文：AES-GCM，每个用途一把独立的包装密钥（各占一个 storage 键）。
 *
 * 只在「明文不该以可读形态躺在 profile 目录里」这类需求上用：API Key、GitHub token。
 * 它挡的是扫盘 `sk-` / `gho_` 与误截图，挡不住能读 profile 目录的程序——包装密钥也在
 * 同一份 storage 里。威胁模型见 `docs/design.md` §9.5。
 *
 * 包装密钥不写死、也不用扩展 ID 派生：开发版 ID 随加载路径变，派生会让密文解不开。
 */

const IV_BYTES = 12
const WRAP_BYTES = 32

export function toBase64(bytes: Uint8Array): string {
  let latin = ''
  for (const byte of bytes) latin += String.fromCharCode(byte)
  return btoa(latin)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const latin = atob(text)
    const bytes = new Uint8Array(latin.length)
    for (let i = 0; i < latin.length; i++) bytes[i] = latin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * 校验包装密钥的原始字节。
 *
 * 显式标 `Uint8Array<ArrayBuffer>`：`crypto.subtle` 的入参是 `BufferSource`，
 * 而裸 `Uint8Array` 的泛型默认是 `ArrayBufferLike`（可能含 `SharedArrayBuffer`），
 * strict 下会被判成不可赋值。
 */
export function wrapBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null
  const bytes = fromBase64(value)
  return bytes && bytes.length === WRAP_BYTES ? bytes : null
}

async function importWrapKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/**
 * 加密。返回 `base64(iv || ciphertext)`。
 *
 * AES-GCM 带认证标签：密文被改过就解不开（返回 null），不会静默给出错误明文。
 * IV 每次随机——重复 IV 会让 AES-GCM 直接失去安全性，这是最容易写错的一处。
 */
export async function sealText(plain: string, wrapKeyRaw: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await importWrapKey(wrapKeyRaw)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(plain))
  )
  const joined = new Uint8Array(iv.length + cipher.length)
  joined.set(iv, 0)
  joined.set(cipher, iv.length)
  return toBase64(joined)
}

/**
 * 解密。任何失败（base64 坏了、长度不够、认证失败、密钥不匹配）都返回 `null`。
 *
 * **不抛错**是有意的：调用方只想问「能拿到明文吗」，拿不到就当没配，
 * 让用户重填比抛一个 WebCrypto 的 DOMException 有用。
 */
export async function openText(token: string, wrapKeyRaw: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const bytes = fromBase64(token)
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

/** 读包装密钥；没有或坏了返回 null（**不生成**：调用方可能有同步区那一份）。 */
export async function readWrapKey(storageKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const stored = await chrome.storage.local.get(storageKey)
  return wrapBytes(stored[storageKey])
}

/**
 * 读包装密钥；没有就生成一个并落盘。
 *
 * 生成后再**回读一次**：两个上下文可能同时首次写入，后写的会覆盖先写的。
 * 回读保证返回的确实是磁盘上那一份，否则用它加密出来的密文下次解不开。
 */
export async function ensureWrapKey(storageKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const existing = await readWrapKey(storageKey)
  if (existing) return existing

  const fresh = crypto.getRandomValues(new Uint8Array(WRAP_BYTES))
  await chrome.storage.local.set({[storageKey]: toBase64(fresh)})
  const check = await readWrapKey(storageKey)
  return check ?? fresh
}
