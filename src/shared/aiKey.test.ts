/**
 * Key 加密存储的用例。重点是三件事：
 * 磁盘上真的没有明文、换一把包装密钥就解不开、旧版明文能迁上来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adoptKeyMaterial,
  AI_KEY_STORAGE,
  AI_WRAP_STORAGE,
  loadAiKey,
  maskKey,
  openKey,
  readKeyMaterial,
  saveAiKey,
  sealKey
} from './aiKey'
import {installStorage, type Store} from './storageFixture'
import {pullAiKey, pushAiKey, removeRemoteAiKey} from './sync'

const KEY = 'sk-abcdef0123456789abcdef0123456789'

/**
 * 确定性的包装密钥（32 字节全填同一个值）。
 *
 * **不要用 `crypto.getRandomValues`**：那样每次调用都不同，`wrap(6)` 两次就是两把密钥，
 * 「同参数应得到同一结果」的断言会莫名其妙失败。
 */
function wrap(seed: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(seed)
}

test('加密后能解回原文', async () => {
  const w = wrap(7)
  const sealed = await sealKey(KEY, w)
  assert.equal(await openKey(sealed, w), KEY)
})

test('密文里不含明文（这是整个改动的目的）', async () => {
  const w = wrap(1)
  for (const plain of [KEY, 'sk-short', '中文也可以']) {
    const sealed = await sealKey(plain, w)
    assert.ok(!sealed.includes(plain), sealed)
    // 连 base64 解出来也不该含明文
    const bytes = atob(sealed.slice(3))
    assert.ok(!bytes.includes(plain))
  }
  assert.ok(await sealKey(KEY, w).then((token) => token.startsWith('v1:')))
})

test('同一明文两次加密结果不同（IV 每次随机）', async () => {
  const w = wrap(2)
  const a = await sealKey(KEY, w)
  const b = await sealKey(KEY, w)
  assert.notEqual(a, b)
  assert.equal(await openKey(a, w), KEY)
  assert.equal(await openKey(b, w), KEY)
})

test('密文被改一个字符就解不开（GCM 带认证）', async () => {
  const w = wrap(3)
  const sealed = await sealKey(KEY, w)
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA')
  assert.equal(await openKey(tampered, w), null)
})

test('换一把包装密钥解不开', async () => {
  const sealed = await sealKey(KEY, wrap(4))
  assert.equal(await openKey(sealed, wrap(5)), null)
})

test('非 v1 前缀一律拒绝（不把明文当密文试）', async () => {
  for (const bad of ['', 'sk-plain', 'sk-abcdef0123456789abcdef0123456789', 'v2:abc', 'v1:', 'v1:!!!!']) {
    assert.equal(await openKey(bad, wrap(6)), null, bad)
  }
  assert.equal(await openKey(await sealKey(KEY, wrap(6)), wrap(6)), KEY)
})

test('save → load 往返，且磁盘上是密文', async () => {
  const store: Store = new Map()
  installStorage(store)

  await saveAiKey(`  ${KEY}\n`)
  assert.equal(await loadAiKey(), KEY)
  // 落盘的两样东西都不含明文
  const raw = store.get(AI_KEY_STORAGE)
  assert.equal(typeof raw, 'string')
  assert.ok(!String(raw).includes(KEY))
  assert.equal(typeof store.get(AI_WRAP_STORAGE), 'string')
})

test('旧版明文不被接受，也不会自动升级（不留迁移路径）', async () => {
  const store: Store = new Map()
  installStorage(store)
  store.set(AI_KEY_STORAGE, KEY)

  // 读到非密文就当作没配。**不清掉**：这对键会镜像到同步区，本机一次自愈就是全网删除。
  assert.equal(await loadAiKey(), '')
  assert.equal(store.get(AI_KEY_STORAGE), KEY)
})

test('包装密钥不在时解不开，且不会凭空生成一把', async () => {
  const store: Store = new Map()
  installStorage(store)
  await saveAiKey(KEY)

  store.delete(AI_WRAP_STORAGE)
  assert.equal(await loadAiKey(), '')
  assert.equal(store.has(AI_KEY_STORAGE), true, '密文要留着，同步区里可能还有能解开它的那一半')
  assert.equal(store.has(AI_WRAP_STORAGE), false, '不能新生成一把，那会覆盖掉同步区里的')
})

test('传空串会连包装密钥一起清除', async () => {
  const store: Store = new Map()
  installStorage(store)
  await saveAiKey(KEY)
  assert.ok(store.has(AI_WRAP_STORAGE))

  await saveAiKey('   ')
  assert.equal(store.has(AI_KEY_STORAGE), false)
  assert.equal(store.has(AI_WRAP_STORAGE), false, '删除 key 时不该留一把能解历史密文的密钥')
  assert.equal(await loadAiKey(), '')
})

test('重复保存复用同一把包装密钥', async () => {
  const store: Store = new Map()
  installStorage(store)
  await saveAiKey('sk-first-0000000000')
  const wrapBefore = store.get(AI_WRAP_STORAGE)

  await saveAiKey(KEY)
  assert.equal(store.get(AI_WRAP_STORAGE), wrapBefore)
  assert.equal(await loadAiKey(), KEY)
})

test('maskKey 只露头尾', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('short'), '••••')
  assert.equal(maskKey(KEY), `${KEY.slice(0, 6)}…${KEY.slice(-4)}`)
  assert.ok(!maskKey(KEY).includes(KEY.slice(8, 20)))
})

test('Key 在设备之间搬运：密文 + 包装密钥成对搬', async () => {
  const store: Store = new Map()
  const syncStore: Store = new Map()
  installStorage(store, 0, syncStore)

  await saveAiKey(KEY)
  assert.equal(await pushAiKey(), true)
  // 两样都上去了：只搬密文的话对方解不开。
  assert.equal(typeof syncStore.get(AI_KEY_STORAGE), 'string')
  assert.equal(typeof syncStore.get(AI_WRAP_STORAGE), 'string')
  assert.ok(!String(syncStore.get(AI_KEY_STORAGE)).includes(KEY))

  // 内容没变时不重复写（写操作有配额）。
  assert.equal(await pushAiKey(), false)

  // 另一台设备：本地什么都没有，拉下来就能用。
  const other: Store = new Map()
  installStorage(other, 0, syncStore)
  assert.equal(await pullAiKey(), true)
  assert.equal(await loadAiKey(), KEY)
  assert.equal(await pullAiKey(), false)
})

test('同步区的密文与包装密钥对不上时不落盘', async () => {
  const local: Store = new Map()
  const syncStore: Store = new Map()
  installStorage(local, 0, syncStore)

  const sealed = await sealKey(KEY, wrap(1))
  syncStore.set(AI_KEY_STORAGE, sealed)
  syncStore.set(AI_WRAP_STORAGE, btoa(String.fromCharCode(...wrap(2))))

  assert.equal(await pullAiKey(), false)
  assert.equal(local.has(AI_KEY_STORAGE), false)
  assert.equal(local.has(AI_WRAP_STORAGE), false)
})

test('本机没配过时不搬空值，删除留空值标记', async () => {
  const store: Store = new Map()
  const syncStore: Store = new Map()
  installStorage(store, 0, syncStore)

  // 没配过：不能拿空值把别的设备存的 Key 抹掉。
  assert.equal(await pushAiKey(), false)
  assert.equal(syncStore.size, 0)

  await saveAiKey(KEY)
  await pushAiKey()
  assert.equal(syncStore.size, 2)

  await removeRemoteAiKey()
  // 留一个空值标记而不是删键：「键不存在」分不清「没配过」与「刚被删掉」。
  assert.equal(syncStore.get(AI_KEY_STORAGE), '')
  assert.equal(syncStore.has(AI_WRAP_STORAGE), false)
})

test('删除能传到另一台设备', async () => {
  const syncStore: Store = new Map()
  const old: Store = new Map()
  installStorage(old, 0, syncStore)
  await saveAiKey(KEY)
  await pushAiKey()

  // 另一台已经拿到 Key 的设备
  const other: Store = new Map()
  installStorage(other, 0, syncStore)
  assert.equal(await pullAiKey(), true)
  assert.equal(await loadAiKey(), KEY)

  // 一边删掉（注意 `installStorage` 换的是全局替身，要切回那一台）
  installStorage(old, 0, syncStore)
  await saveAiKey('')
  await removeRemoteAiKey()

  // 另一边把本机那份也清掉（否则本地和服务端就此分歧）
  installStorage(other, 0, syncStore)
  assert.equal(await pullAiKey(), true)
  assert.equal(other.has(AI_KEY_STORAGE), false)
  assert.equal(other.has(AI_WRAP_STORAGE), false)
  assert.equal(await loadAiKey(), '')
})

test('同步区里没有这个键（而不是空串）时不动本机', async () => {
  const local: Store = new Map()
  installStorage(local, 0, new Map())
  await saveAiKey(KEY)

  // 「从没同步过 / Chrome 关掉了扩展同步」也会是这种形状，不能当成删除。
  assert.equal(await pullAiKey(), false)
  assert.equal(local.has(AI_KEY_STORAGE), true)
})

test('readKeyMaterial：只存了一半时返回 null', async () => {
  const store: Store = new Map()
  installStorage(store)
  assert.equal(await readKeyMaterial(), null)

  await saveAiKey(KEY)
  const material = await readKeyMaterial()
  assert.ok(material)
  assert.equal(await adoptKeyMaterial(material), false, '内容相同就不写')
})
