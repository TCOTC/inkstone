/**
 * GitHub 授权：**device flow**（RFC 8628），不用 `client_secret`。
 *
 * 为什么不是 web flow：`POST /login/oauth/access_token` 用授权码换 token 时**要求**
 * `client_secret`，而扩展是公开产物，塞 secret 等于公开。device flow 官方明确写
 * *the `client_secret` is not needed*，这是唯一能不做后端的路子。
 *
 * 流程由选项页驱动，**不要在 service worker 里轮询**：码 15 分钟有效、poll 间隔数秒，
 * SW 活不了那么久，而这个界面本来就开着。
 *
 * 请求 `offline_access` 拿 refresh token（access 8 小时，refresh 6 个月不用才失效）。
 * 刷新时是否同样豁免 `client_secret` 尚未实测——若需要，整个 device flow 方案要重做，
 * 这里没有留 secret 的位置（刻意的）。
 */
import {ensureWrapKey, openText, readWrapKey, sealText} from './sealed'
import {GH_TOKEN_STORAGE, GH_WRAP_STORAGE} from './storageKeys'

/** GitHub App 的 client id（公开标识，可以入库）。**留空 = 未配置，界面不该显示入口。** */
export const GITHUB_CLIENT_ID = 'Iv23liJUIB9qVrR7b0VC'

export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** 用户在浏览器里输码的地址。 */
export const DEVICE_VERIFY_URL = 'https://github.com/login/device'

/** 只要这一个 scope：拿 refresh token。权限由 App 注册时的 `Contents` 决定。 */
const DEVICE_SCOPE = 'offline_access'

/** 提前多久刷新 access token。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

/** 只用到 `fetch` 的这一点点能力，测试里换成假的即可。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** device flow 第一步给回来的凭据。 */
export interface DeviceCode {
  deviceCode: string
  /** 8 位，带连字符，显示给用户抄。 */
  userCode: string
  /** 用户输码的地址（GitHub 目前固定是 `DEVICE_VERIFY_URL`）。 */
  verificationUri: string
  /** 码的有效期（秒）。 */
  expiresIn: number
  /** 轮询最小间隔（秒）。 */
  interval: number
}

/** 一对 token 加上到期时刻。**只以密文形态落盘**。 */
export interface GithubToken {
  accessToken: string
  refreshToken: string
  /** access token 到期时刻（毫秒）；0 = 不过期（App 未开启到期特性时）。 */
  expiresAt: number
  /** refresh token 到期时刻（毫秒）；0 = 未知。 */
  refreshExpiresAt: number
}

/** 一次轮询的结果。**四种失败分开**，否则「用户还没输」会被当成错误。 */
export type PollOutcome =
  | {kind: 'token'; token: GithubToken}
  | {kind: 'pending'}
  /** 轮询太快，GitHub 要求把间隔加到这个值（秒）。 */
  | {kind: 'slow-down'; interval: number}
  | {kind: 'expired'}
  | {kind: 'denied'}
  | {kind: 'failed'; message: string}

export interface AuthOptions {
  clientId: string
  /** 注入点，默认全局 `fetch`。 */
  fetchImpl?: FetchLike
  /** 当前时刻（毫秒），测试用。 */
  now?: number
}

function resolve(options: AuthOptions): {clientId: string; doFetch: FetchLike; now: number} {
  return {
    clientId: options.clientId,
    doFetch: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    now: options.now ?? Date.now()
  }
}

/**
 * GitHub 的这两个端点只认表单编码，且**默认返回 `application/x-www-form-urlencoded`**；
 * 不带 `Accept: application/json` 就得自己解析 `a=b&c=d`。
 */
async function postForm(doFetch: FetchLike, url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(fields).toString()
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
  const parsed: unknown = await response.json()
  if (!parsed || typeof parsed !== 'object') throw new Error('GitHub 返回的不是 JSON 对象')
  return parsed as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 响应里的 `expires_in` 是「还有多少秒」，换成绝对时刻。 */
function tokenFrom(body: Record<string, unknown>, now: number): GithubToken | null {
  const accessToken = str(body.access_token)
  if (!accessToken) return null
  const expiresIn = num(body.expires_in)
  const refreshExpiresIn = num(body.refresh_token_expires_in)
  return {
    accessToken,
    refreshToken: str(body.refresh_token),
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : 0,
    refreshExpiresAt: refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : 0
  }
}

/** 第一步：要一个 8 位码。失败就抛（调用方展示错误）。 */
export async function requestDeviceCode(options: AuthOptions): Promise<DeviceCode> {
  const {clientId, doFetch} = resolve(options)
  if (!clientId) throw new Error('没有配置 GitHub App 的 client id')
  const body = await postForm(doFetch, DEVICE_CODE_URL, {client_id: clientId, scope: DEVICE_SCOPE})

  const deviceCode = str(body.device_code)
  const userCode = str(body.user_code)
  if (!deviceCode || !userCode) throw new Error('GitHub 没有返回 device code')

  return {
    deviceCode,
    userCode,
    verificationUri: str(body.verification_uri) || DEVICE_VERIFY_URL,
    expiresIn: num(body.expires_in) || 900,
    interval: num(body.interval) || 5
  }
}

/**
 * 第三步：轮询换 token。**一次一个请求**，循环交给调用方（界面要能显示进度、能取消）。
 *
 * 错误码按官方表逐个映射：`authorization_pending` 继续等、`slow_down` 加间隔、
 * `expired_token` 重新取码、`access_denied` 收起界面，其余当作失败。
 */
export async function pollDeviceCode(options: AuthOptions & {deviceCode: string}): Promise<PollOutcome> {
  const {clientId, doFetch, now} = resolve(options)
  let body: Record<string, unknown>
  try {
    body = await postForm(doFetch, ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: options.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  } catch (error) {
    return {kind: 'failed', message: error instanceof Error ? error.message : String(error)}
  }

  const token = tokenFrom(body, now)
  if (token) return {kind: 'token', token}

  switch (str(body.error)) {
    case 'authorization_pending':
      return {kind: 'pending'}
    case 'slow_down':
      return {kind: 'slow-down', interval: num(body.interval) || 10}
    case 'expired_token':
      return {kind: 'expired'}
    case 'access_denied':
      return {kind: 'denied'}
    default:
      return {kind: 'failed', message: str(body.error_description) || str(body.error) || 'GitHub 没有返回 access token'}
  }
}

/** 用 refresh token 换一对新的。失败返回 null（调用方按「需要重新登录」处理）。 */
export async function refreshAccessToken(options: AuthOptions & {refreshToken: string}): Promise<GithubToken | null> {
  const {clientId, doFetch, now} = resolve(options)
  if (!options.refreshToken) return null
  try {
    const body = await postForm(doFetch, ACCESS_TOKEN_URL, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken
    })
    return tokenFrom(body, now)
  } catch {
    return null
  }
}

/**
 * 该不该先刷新。`expiresAt === 0`（不过期）永远返回 false；
 * 提前 `REFRESH_SKEW_MS` 算「要刷新」，免得刚好在请求途中过期。
 */
export function isTokenExpiring(token: GithubToken, now = Date.now(), skewMs = REFRESH_SKEW_MS): boolean {
  if (token.expiresAt <= 0) return false
  return token.expiresAt - skewMs <= now
}

/**
 * 落盘（整体加密）。返回是否真的写了——token 没变就不写，省一次磁盘与一次重新加密。
 *
 * 判等要**解出明文再比**：AES-GCM 的 IV 每次随机，同一份明文两次加密的密文必然不同，
 * 拿密文比会永远判成「变了」。
 *
 * **不镜像到 `storage.sync`**：重装后凭据本来就要重新做 device flow，
 * 镜像它只是把「能写私有仓库的凭据」多复制一份。
 */
export async function saveGithubToken(token: GithubToken): Promise<boolean> {
  const existing = await loadGithubToken()
  if (existing && sameToken(existing, token)) return false
  const wrap = await ensureWrapKey(GH_WRAP_STORAGE)
  const sealed = await sealText(JSON.stringify(token), wrap)
  await chrome.storage.local.set({[GH_TOKEN_STORAGE]: sealed})
  return true
}

function sameToken(left: GithubToken, right: GithubToken): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.refreshExpiresAt === right.refreshExpiresAt
  )
}

/** 读回来解密；没配过或解不开都返回 null。**解不开时不清掉**，留给用户重新登录。 */
export async function loadGithubToken(): Promise<GithubToken | null> {
  try {
    const stored = await chrome.storage.local.get(GH_TOKEN_STORAGE)
    const sealed = stored[GH_TOKEN_STORAGE]
    if (typeof sealed !== 'string' || !sealed) return null
    const wrap = await readWrapKey(GH_WRAP_STORAGE)
    if (!wrap) return null
    const plain = await openText(sealed, wrap)
    if (!plain) return null
    const parsed: unknown = JSON.parse(plain)
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Partial<GithubToken>
    if (typeof value.accessToken !== 'string' || !value.accessToken) return null
    return {
      accessToken: value.accessToken,
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : '',
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : 0,
      refreshExpiresAt: typeof value.refreshExpiresAt === 'number' ? value.refreshExpiresAt : 0
    }
  } catch {
    return null
  }
}

/** 清掉 token 与它的包装密钥（那把只服务这一份密文）。 */
export async function clearGithubToken(): Promise<void> {
  await chrome.storage.local.remove([GH_TOKEN_STORAGE, GH_WRAP_STORAGE])
}
