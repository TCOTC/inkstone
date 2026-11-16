/**
 * GitHub device flow 的请求与落盘语义。
 *
 * 全部走注入的假 `fetch`：这些用例锁的是「请求长什么样」「错误码怎么分类」，
 * 而不是网络本身。真账号的端到端验证在设置页手工做。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCESS_TOKEN_URL,
  clearGithubToken,
  DEVICE_CODE_URL,
  isTokenExpiring,
  loadGithubToken,
  pollDeviceCode,
  refreshAccessToken,
  requestDeviceCode,
  saveGithubToken,
  type FetchLike,
  type GithubToken
} from './githubAuth'
import {installStorage, type Store} from './storageFixture'
import {GH_TOKEN_STORAGE, GH_WRAP_STORAGE} from './storageKeys'

interface Call {
  url: string
  init?: RequestInit
}

/** 按顺序回放的假 fetch；`body` 原样作为 `json()` 的结果。 */
function fakeFetch(bodies: unknown[]): {fetchImpl: FetchLike; calls: Call[]} {
  const calls: Call[] = []
  let index = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({url, init})
    const body = bodies[index] ?? {}
    index += 1
    return {ok: true, status: 200, json: async () => body} as unknown as Response
  }
  return {fetchImpl, calls}
}

/** 表单编码的请求体 → 便于断言的普通对象。 */
function formOf(call: Call | undefined): Record<string, string> {
  assert.ok(call?.init?.body)
  return Object.fromEntries(new URLSearchParams(String(call.init.body)))
}

const DEVICE_BODY = {
  device_code: 'dev-123',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5
}

const TOKEN_BODY = {
  access_token: 'ghu_abc',
  refresh_token: 'ghr_def',
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
  token_type: 'bearer',
  scope: ''
}

test('requestDeviceCode：表单编码打到 device/code，解出码与间隔', async () => {
  const {fetchImpl, calls} = fakeFetch([DEVICE_BODY])
  const code = await requestDeviceCode({clientId: 'Iv1.abc', fetchImpl})

  assert.deepEqual(calls.map((call) => call.url), [DEVICE_CODE_URL])
  assert.equal(calls[0]?.init?.method, 'POST')
  // 不带这个头，GitHub 会回 `a=b&c=d` 而不是 JSON。
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['Accept'], 'application/json')
  assert.deepEqual(formOf(calls[0]), {client_id: 'Iv1.abc', scope: 'offline_access'})

  assert.deepEqual(code, {
    deviceCode: 'dev-123',
    userCode: 'WDJB-MJHT',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5
  })
})

test('requestDeviceCode：没配 client id 时直接报错，不发请求', async () => {
  const {fetchImpl, calls} = fakeFetch([DEVICE_BODY])
  await assert.rejects(requestDeviceCode({clientId: '', fetchImpl}), /client id/)
  assert.equal(calls.length, 0)
})

test('requestDeviceCode：缺 device_code 时当失败，不返回半成品', async () => {
  const {fetchImpl} = fakeFetch([{user_code: 'WDJB-MJHT'}])
  await assert.rejects(requestDeviceCode({clientId: 'x', fetchImpl}), /device code/)
})

test('pollDeviceCode：拿到 token 时把 expires_in 换成绝对时刻', async () => {
  const {fetchImpl, calls} = fakeFetch([TOKEN_BODY])
  const outcome = await pollDeviceCode({clientId: 'Iv1.abc', deviceCode: 'dev-123', fetchImpl, now: 1000})

  assert.equal(outcome.kind, 'token')
  if (outcome.kind !== 'token') return
  assert.equal(outcome.token.accessToken, 'ghu_abc')
  assert.equal(outcome.token.refreshToken, 'ghr_def')
  assert.equal(outcome.token.expiresAt, 1000 + 28800 * 1000)
  assert.equal(outcome.token.refreshExpiresAt, 1000 + 15897600 * 1000)

  assert.deepEqual(formOf(calls[0]), {
    client_id: 'Iv1.abc',
    device_code: 'dev-123',
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  })
  assert.equal(calls[0]?.url, ACCESS_TOKEN_URL)
})

test('pollDeviceCode：四种错误码各自分类，且都算「还没成」', async () => {
  const cases = [
    {body: {error: 'authorization_pending'}, kind: 'pending'},
    {body: {error: 'slow_down', interval: 15}, kind: 'slow-down'},
    {body: {error: 'expired_token'}, kind: 'expired'},
    {body: {error: 'access_denied'}, kind: 'denied'}
  ] as const

  for (const item of cases) {
    const {fetchImpl} = fakeFetch([item.body])
    const outcome = await pollDeviceCode({clientId: 'x', deviceCode: 'dev', fetchImpl})
    assert.equal(outcome.kind, item.kind, JSON.stringify(item.body))
  }
})

test('pollDeviceCode：slow_down 带回新的间隔，缺字段时给 10 秒保守值', async () => {
  const withInterval = await pollDeviceCode({
    clientId: 'x',
    deviceCode: 'dev',
    fetchImpl: fakeFetch([{error: 'slow_down', interval: 15}]).fetchImpl
  })
  assert.deepEqual(withInterval, {kind: 'slow-down', interval: 15})

  const without = await pollDeviceCode({
    clientId: 'x',
    deviceCode: 'dev',
    fetchImpl: fakeFetch([{error: 'slow_down'}]).fetchImpl
  })
  assert.deepEqual(without, {kind: 'slow-down', interval: 10})
})

test('pollDeviceCode：认不出的错误收成 failed，带原文便于排障', async () => {
  const {fetchImpl} = fakeFetch([{error: 'incorrect_device_code', error_description: 'device code 无效'}])
  const outcome = await pollDeviceCode({clientId: 'x', deviceCode: 'dev', fetchImpl})
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.match(outcome.message, /device code 无效/)
})

test('pollDeviceCode：HTTP 报错不会抛，收成 failed', async () => {
  const fetchImpl: FetchLike = async () => ({ok: false, status: 503, json: async () => ({})}) as unknown as Response
  const outcome = await pollDeviceCode({clientId: 'x', deviceCode: 'dev', fetchImpl})
  assert.equal(outcome.kind, 'failed')
})

test('refreshAccessToken：成功返回新的对，失败返回 null', async () => {
  const ok = fakeFetch([TOKEN_BODY])
  const token = await refreshAccessToken({clientId: 'x', refreshToken: 'ghr_old', fetchImpl: ok.fetchImpl, now: 0})
  assert.equal(token?.accessToken, 'ghu_abc')
  assert.deepEqual(formOf(ok.calls[0]), {
    client_id: 'x',
    'grant_type': 'refresh_token',
    'refresh_token': 'ghr_old'
  })

  // 没有 refresh token 时不该发请求。
  const empty = fakeFetch([TOKEN_BODY])
  assert.equal(await refreshAccessToken({clientId: 'x', refreshToken: '', fetchImpl: empty.fetchImpl}), null)
  assert.equal(empty.calls.length, 0)

  const bad = fakeFetch([{error: 'bad_refresh_token'}])
  assert.equal(await refreshAccessToken({clientId: 'x', refreshToken: 'ghr', fetchImpl: bad.fetchImpl}), null)
})

test('isTokenExpiring：提前 5 分钟算到期，不过期的 token 永远不用刷新', () => {
  const now = 1_000_000
  const live: GithubToken = {accessToken: 'a', refreshToken: 'r', expiresAt: now + 6 * 60_000, refreshExpiresAt: 0}
  assert.equal(isTokenExpiring(live, now), false)
  assert.equal(isTokenExpiring({...live, expiresAt: now + 4 * 60_000}, now), true)
  // 0 = 不过期：App 没开启「到期 token」时就是这个形态。
  assert.equal(isTokenExpiring({...live, expiresAt: 0}, now), false)
})

test('saveGithubToken：磁盘上是密文，读回来是同一个对象', async () => {
  const store: Store = new Map()
  installStorage(store, 0)
  const token: GithubToken = {
    accessToken: 'ghu_abcdef0123456789',
    refreshToken: 'ghr_abcdef0123456789',
    expiresAt: 123,
    refreshExpiresAt: 456
  }

  assert.equal(await saveGithubToken(token), true)
  assert.deepEqual(await loadGithubToken(), token)

  const sealed = store.get(GH_TOKEN_STORAGE)
  assert.equal(typeof sealed, 'string')
  assert.ok(!String(sealed).includes(token.accessToken), '磁盘上不得出现明文')
  assert.ok(store.has(GH_WRAP_STORAGE))

  // 内容没变时不重写（返回 false），省一次磁盘。
  assert.equal(await saveGithubToken(token), false)
})

test('loadGithubToken：没配过、缺包装密钥、密文坏了都返回 null 且不清盘', async () => {
  const store: Store = new Map()
  installStorage(store, 0)
  assert.equal(await loadGithubToken(), null)

  await saveGithubToken({accessToken: 'ghu_a', refreshToken: 'ghr_b', expiresAt: 0, refreshExpiresAt: 0})
  store.delete(GH_WRAP_STORAGE)
  assert.equal(await loadGithubToken(), null)
  assert.ok(store.has(GH_TOKEN_STORAGE), '密文要留着：包装密钥可能是同步过来的一半')

  store.set(GH_WRAP_STORAGE, 'AAAA')
  assert.equal(await loadGithubToken(), null)
})

test('clearGithubToken：连包装密钥一起删', async () => {
  const store: Store = new Map()
  installStorage(store, 0)
  await saveGithubToken({accessToken: 'ghu_a', refreshToken: 'ghr_b', expiresAt: 0, refreshExpiresAt: 0})

  await clearGithubToken()
  assert.equal(store.has(GH_TOKEN_STORAGE), false)
  assert.equal(store.has(GH_WRAP_STORAGE), false)
})
