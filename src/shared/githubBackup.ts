/**
 * GitHub 备份：仓库里放**一个文件**，每次备份是一次提交。
 *
 * 为什么不是一个时间戳一个文件：git 的历史本来就是「一串完整快照」，而 `GET commits?path=`
 * 直接给出 sha + 时间 + message。再建一层目录等于把同一件事做两遍，且两套时间线必然漂移。
 * 附带的好处是仓库里那个文件**本身就是可导入的备份**：人在网页上打开任意历史版本、
 * 下载、用「导入备份」就能救回来，不需要扩展。
 *
 * 硬规则：**只追加提交，永不改写历史**（不 force push、不删分支、不重建仓库）。
 * 历史是唯一的数据点来源，改写一次就丢一段时间点。
 */
import type {BackupFile} from './backup'
import type {PageRecord} from './types'

export const GITHUB_API = 'https://api.github.com'

/** 仓库里那个文件的名字。固定不变——改名等于把历史切成两段。 */
export const BACKUP_PATH = 'inkstone-backup.json'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** `owner/repo`。解析失败返回 null（用户手误时不要发请求）。 */
export function parseRepo(input: string): {owner: string; repo: string} | null {
  const match = input.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!match) return null
  const owner = match[1]
  const repo = match[2]
  if (!owner || !repo) return null
  return {owner, repo}
}

/** 仓库里当前那份文件。 */
export interface RemoteFile {
  /** 文件的 blob sha。更新时必须带上，否则 GitHub 返回 409。 */
  sha: string
  /** 解析后的备份对象；坏 JSON 或格式不对时为 null。 */
  backup: BackupFile | null
  /** 原始文本，用于「内容没变就不提交」的比对。 */
  text: string
}

/** 一条提交（备份历史里的一行）。 */
export interface BackupCommit {
  sha: string
  /** 毫秒时间戳。 */
  at: number
  /** 提交信息第一行（我们写的是摘要）。 */
  message: string
}

export interface RepoOptions {
  token: string
  repo: {owner: string; repo: string}
  fetchImpl?: FetchLike
  /** 分支，省略时用仓库默认分支。 */
  branch?: string
}

function doFetchOf(options: RepoOptions): FetchLike {
  return options.fetchImpl ?? ((input, init) => fetch(input, init))
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra
  }
}

function contentsUrl(options: RepoOptions, withRef = true): string {
  const base = `${GITHUB_API}/repos/${options.repo.owner}/${options.repo.repo}/contents/${BACKUP_PATH}`
  if (!withRef || !options.branch) return base
  return `${base}?ref=${encodeURIComponent(options.branch)}`
}

/** GitHub 返回的是带换行的 base64，`atob` 不吃换行，先清掉。 */
function decodeBase64(text: string): string {
  const clean = text.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function readBackup(text: string): BackupFile | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const file = parsed as Partial<BackupFile>
    if (typeof file.format !== 'string' || !Array.isArray(file.pages)) return null
    return file as BackupFile
  } catch {
    return null
  }
}

/**
 * 读远端当前那份。**仓库是空的（404）返回 null**，其他错误抛出。
 *
 * 超过 1 MB 时 `GET contents` 的 JSON 里 `content` 是空串（`encoding: "none"`），
 * 必须改用 raw 再取一次——2000 页量级一定会撞上这条。
 */
export async function readRemoteFile(options: RepoOptions): Promise<RemoteFile | null> {
  const doFetch = doFetchOf(options)
  const response = await doFetch(contentsUrl(options), {headers: headers(options.token)})
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`读取备份失败：GitHub 返回 ${response.status}`)

  const body = (await response.json()) as {sha?: unknown; content?: unknown; encoding?: unknown}
  const sha = typeof body.sha === 'string' ? body.sha : ''
  if (!sha) throw new Error('读取备份失败：响应里没有文件 sha')

  if (typeof body.content === 'string' && body.content.length > 0) {
    const text = decodeBase64(body.content)
    return {sha, text, backup: readBackup(text)}
  }

  // 大文件：走 raw。
  const raw = await doFetch(contentsUrl(options), {
    headers: headers(options.token, {Accept: 'application/vnd.github.raw'})
  })
  if (!raw.ok) throw new Error(`读取备份失败：raw 返回 ${raw.status}`)
  const text = await raw.text()
  return {sha, text, backup: readBackup(text)}
}

/**
 * 写一份新的备份。返回新提交的信息。
 *
 * `sha` 是乐观并发控制的全部依据：不带它 GitHub 会拒绝更新已有文件，带了但过期会 409。
 * 409 不在这里重试——重试要「重读 → 重新合并 → 再写」，那是调用方的决定（`pushBackup`）。
 */
export async function writeRemoteFile(
  options: RepoOptions & {text: string; sha?: string; message: string}
): Promise<BackupCommit> {
  const doFetch = doFetchOf(options)
  const payload: Record<string, unknown> = {
    message: options.message,
    content: encodeBase64(options.text)
  }
  if (options.sha) payload.sha = options.sha
  if (options.branch) payload.branch = options.branch

  const response = await doFetch(contentsUrl(options, false), {
    method: 'PUT',
    headers: headers(options.token, {'Content-Type': 'application/json'}),
    body: JSON.stringify(payload)
  })
  if (response.status === 409) throw new Error('CONFLICT')
  if (!response.ok) throw new Error(`写入备份失败：GitHub 返回 ${response.status}`)

  const body = (await response.json()) as {commit?: {sha?: unknown; commit?: {author?: {date?: unknown}}}}
  const sha = typeof body.commit?.sha === 'string' ? body.commit.sha : ''
  const date = body.commit?.commit?.author?.date
  return {sha, at: typeof date === 'string' ? Date.parse(date) || 0 : 0, message: options.message}
}

/** 备份历史：这个文件的提交，新的在前。 */
export async function listCommits(options: RepoOptions & {perPage?: number}): Promise<BackupCommit[]> {
  const doFetch = doFetchOf(options)
  const perPage = options.perPage ?? 30
  const base = `${GITHUB_API}/repos/${options.repo.owner}/${options.repo.repo}/commits`
  const query = `?path=${encodeURIComponent(BACKUP_PATH)}&per_page=${perPage}${options.branch ? `&sha=${encodeURIComponent(options.branch)}` : ''}`

  const response = await doFetch(base + query, {headers: headers(options.token)})
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`读取备份历史失败：GitHub 返回 ${response.status}`)

  const body = (await response.json()) as unknown
  if (!Array.isArray(body)) return []
  const commits: BackupCommit[] = []
  for (const item of body) {
    const row = item as {sha?: unknown; commit?: {author?: {date?: unknown}; message?: unknown}}
    const sha = typeof row.sha === 'string' ? row.sha : ''
    if (!sha) continue
    const date = row.commit?.author?.date
    const message = typeof row.commit?.message === 'string' ? row.commit.message : ''
    commits.push({
      sha,
      at: typeof date === 'string' ? Date.parse(date) || 0 : 0,
      message: message.split('\n')[0] ?? ''
    })
  }
  return commits
}

/** 读某个历史版本的备份内容。提交不存在返回 null。 */
export async function readAt(options: RepoOptions & {sha: string}): Promise<BackupFile | null> {
  const doFetch = doFetchOf(options)
  const url = `${GITHUB_API}/repos/${options.repo.owner}/${options.repo.repo}/contents/${BACKUP_PATH}?ref=${encodeURIComponent(options.sha)}`
  const response = await doFetch(url, {headers: headers(options.token)})
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`读取历史版本失败：GitHub 返回 ${response.status}`)

  const body = (await response.json()) as {content?: unknown}
  if (typeof body.content === 'string' && body.content.length > 0) {
    return readBackup(decodeBase64(body.content))
  }
  const raw = await doFetch(url, {headers: headers(options.token, {Accept: 'application/vnd.github.raw'})})
  if (!raw.ok) throw new Error(`读取历史版本失败：raw 返回 ${raw.status}`)
  return readBackup(await raw.text())
}

/** 一遍扫描得到「页数 / 条数」，摘要与判等都靠它。 */
export interface PageTally {
  pages: number
  highlights: number
}

export function tally(pages: readonly PageRecord[]): PageTally {
  let highlights = 0
  for (const page of pages) highlights += page.highlights.length
  return {pages: pages.length, highlights}
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value)
}

/**
 * 提交信息：`备份 21 页 / 130 条（+3 页 +13 条）`。
 *
 * 第一份（没有上一份）只写总量。历史列表里每一行都要能一眼看出「变了多少」，
 * 否则全是 `备份 21 页 / 130 条`，看不出哪次值得回滚。
 */
export function commitMessage(current: PageTally, previous: PageTally | null): string {
  const base = `备份 ${current.pages} 页 / ${current.highlights} 条`
  if (!previous) return base
  const pages = current.pages - previous.pages
  const highlights = current.highlights - previous.highlights
  if (pages === 0 && highlights === 0) return base
  return `${base}（${signed(pages)} 页 ${signed(highlights)} 条）`
}

/**
 * 该不该提交。**内容相同就不提交**——否则每次备份都留一个提交，历史会被噪声淹没。
 *
 * 比的是**指纹**（
 * 去掉 `exportedAt` 后的序列化），不是原文：`buildBackup()` 每次都填 `exportedAt: Date.now()`，
 * 拿原文比会恒不相等，等于每次备份都多一个提交。`exportedAt` 描述的是「这份文件何时写出」，
 * 不是「数据变了没变」，所以它不属于判等依据。
 */
export function shouldPush(nextText: string, remoteText: string | null): boolean {
  if (remoteText === null) return true
  return backupFingerprint(remoteText) !== backupFingerprint(nextText)
}

/**
 * 判等指纹：解析后去掉 `exportedAt` 再序列化。
 *
 * 解析失败就把原文当指纹（宁可直接比原文，也不要因为坏 JSON 而永远不提交）。
 */
export function backupFingerprint(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return text
    const value = {...(parsed as Record<string, unknown>)}
    delete value.exportedAt
    return JSON.stringify(value)
  } catch {
    return text
  }
}

/** 备份文件的序列化：**唯一的格式决定点**，导出与远端共用它才能判等。 */
export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup)
}
