/**
 * GitHub 备份的编排层：把授权、读远端、判等、写入、恢复串成几件事。
 *
 * 与 `shared/sync.ts`（Chrome 同步通道）**互不相干**：那条路是逐页键值的实时镜像，
 * 这条路是整份文件的定时快照。两套同时存在，任何一方挂掉都不影响另一方。
 */
import {applyBackup, buildBackup, parseBackup, type BackupParse} from './backup'
import {isTokenExpiring, loadGithubToken, refreshAccessToken, saveGithubToken, GITHUB_CLIENT_ID} from './githubAuth'
import {
  commitMessage,
  listCommits,
  parseRepo,
  readAt,
  readRemoteFile,
  serializeBackup,
  shouldPush,
  tally,
  writeRemoteFile,
  type BackupCommit,
  type RepoOptions
} from './githubBackup'
import {decodeRows} from './rowCodec'
import {loadSettings} from './settings'
import {GH_REPO_STORAGE} from './storageKeys'
import type {ImportSummary} from './db'

/** 备份目标仓库；没配过返回 null。 */
export async function loadRepo(): Promise<{owner: string; repo: string} | null> {
  const stored = await chrome.storage.local.get(GH_REPO_STORAGE)
  const value = stored[GH_REPO_STORAGE]
  return typeof value === 'string' ? parseRepo(value) : null
}

/** 记下目标仓库。传空串等于清除。非法值直接拒绝，别让手误变成一次失败的备份。 */
export async function saveRepo(input: string): Promise<boolean> {
  const trimmed = input.trim()
  if (!trimmed) {
    await chrome.storage.local.remove(GH_REPO_STORAGE)
    return true
  }
  if (!parseRepo(trimmed)) return false
  await chrome.storage.local.set({[GH_REPO_STORAGE]: trimmed})
  return true
}

/**
 * 拿一个可用的 access token。
 *
 * 快过期就先刷新（阈值 5 分钟），刷新失败返回 null——调用方按「需要重新登录」处理。
 * 刷新成功后**只在本机落盘**：这条凭据不进 `storage.sync`，重装后本来就要重新登录。
 */
export async function ensureAccessToken(now = Date.now()): Promise<string | null> {
  const token = await loadGithubToken()
  if (!token) return null
  if (!isTokenExpiring(token, now)) return token.accessToken

  const refreshed = await refreshAccessToken({
    clientId: GITHUB_CLIENT_ID,
    refreshToken: token.refreshToken,
    now
  })
  if (!refreshed) return null
  await saveGithubToken(refreshed)
  return refreshed.accessToken
}

async function repoOptions(extra: {branch?: string} = {}): Promise<RepoOptions | null> {
  const accessToken = await ensureAccessToken()
  if (!accessToken) return null
  const repo = await loadRepo()
  if (!repo) return null
  return {token: accessToken, repo, ...(extra.branch ? {branch: extra.branch} : {})}
}

/** 连接状态。给界面展示用，不含任何凭据。 */
export interface GithubStatus {
  connected: boolean
  /** 配了目标仓库。 */
  hasRepo: boolean
  /** access token 会不会过期（App 开了「Expire tokens」就是 true）。 */
  expiring: boolean
}

export async function githubStatus(): Promise<GithubStatus> {
  const token = await loadGithubToken()
  const repo = await loadRepo()
  return {
    connected: token !== null,
    hasRepo: repo !== null,
    expiring: (token?.expiresAt ?? 0) > 0
  }
}

export type PushOutcome =
  | {kind: 'pushed'; commit: BackupCommit; pages: number; highlights: number}
  | {kind: 'unchanged'; pages: number; highlights: number}
  | {kind: 'unconfigured'}
  /** 401 之类：凭据失效，要重新登录。 */
  | {kind: 'unauthorized'}
  | {kind: 'failed'; message: string}

/**
 * 备份一次。返回结果而不是抛错：调用方要区分「没变」与「失败」。
 *
 * 顺序是「先读远端 → 比指纹（忽略 `exportedAt`）→ 不同才提交」。不这样节流，
 * 一次未变的备份也会产生一个提交，历史列表就废了（配额反而不是问题，5000 请求/小时够用）。
 */
export async function pushBackup(): Promise<PushOutcome> {
  const options = await repoOptions()
  if (!options) {
    const token = await loadGithubToken()
    return token ? {kind: 'unconfigured'} : {kind: 'unauthorized'}
  }

  const backup = await buildBackup()
  const counts = tally(decodeRows(backup.pages))
  const text = serializeBackup(backup)

  try {
    const remote = await readRemoteFile(options)
    if (shouldPush(text, remote?.text ?? null)) {
      const previous = remote?.backup ? tally(decodeRows(remote.backup.pages)) : null
      const commit = await writeRemoteFile({
        ...options,
        text,
        message: commitMessage(counts, previous),
        ...(remote ? {sha: remote.sha} : {})
      })
      return {kind: 'pushed', commit, ...counts}
    }
    return {kind: 'unchanged', ...counts}
  } catch (error) {
    if (error instanceof Error && error.message === 'CONFLICT') {
      // 另一台设备刚写过：重读再比一次就够了（并集由下一次备份覆盖，这里不抢）。
      const remote = await readRemoteFile(options).catch(() => null)
      if (!shouldPush(text, remote?.text ?? null)) return {kind: 'unchanged', ...counts}
      return {kind: 'failed', message: '远端刚被其它设备更新，请再备份一次'}
    }
    const message = error instanceof Error ? error.message : String(error)
    return /40[13]/.test(message) ? {kind: 'unauthorized'} : {kind: 'failed', message}
  }
}

/** 备份历史（新的在前）。没配置或凭据失效时返回空数组。 */
export async function backupHistory(perPage = 30): Promise<BackupCommit[]> {
  const options = await repoOptions()
  if (!options) return []
  try {
    return await listCommits({...options, perPage})
  } catch {
    return []
  }
}

/**
 * 从某个历史版本恢复。
 *
 * **语义是并集**：本机独有的线保留（`importPages` 的规则），不删任何东西。
 * 想真正回滚成那个时间点要先「清空数据」——界面把两件事分开写。
 */
export async function restoreCommit(sha: string): Promise<{ok: true; summary: ImportSummary} | {ok: false; error: string}> {
  const options = await repoOptions()
  if (!options) return {ok: false, error: '还没有连接 GitHub 或没有指定仓库。'}

  let backup: unknown
  try {
    backup = await readAt({...options, sha})
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
  if (!backup) return {ok: false, error: '这个提交里没有可读的备份。'}

  const parsed: BackupParse = parseBackup(backup)
  if (!parsed.ok) return {ok: false, error: parsed.error}

  // 恢复划线**不覆盖当前设置**：用户可能故意改过设置，回滚数据不该顺带改偏好。
  const summary = await applyBackup({pages: parsed.pages, settings: null})
  return {ok: true, summary}
}

/* ── 定时备份 ────────────────────────────────────────────────────────────
   用 `chrome.alarms` 而不是 `setTimeout`：MV3 的 service worker 会被终止，
   定时器跟着一起没。alarm 由浏览器保存，worker 醒来时会补发。
   一次只排一个**一次性** alarm，触发后再排下一个——不用周期 alarm，
   因为间隔与开关随时可改，周期 alarm 改一次要 `clear` + `create` 两趟。 */

/** 唯一的 backup alarm 名字。 */
export const BACKUP_ALARM = 'inkstone-backup'

/** 划一条线就排一次备份显然不行，但也不该等到下一个整点：写入后先等这么久再合并成一次。 */
const WRITE_DEBOUNCE_MINUTES = 5

/**
 * 按当前状态（凭据 + 仓库 + 间隔）对齐 alarm。
 *
 * 三种情况要清掉：没连上、没填仓库、间隔是 0。
 * 已经排着就不动它——每次写划线都往后推等于永远不备份。
 */
export async function syncBackupAlarm(): Promise<void> {
  const settings = await loadSettings()
  const status = await githubStatus()
  if (!status.connected || !status.hasRepo || settings.autoBackupMinutes <= 0) {
    await chrome.alarms.clear(BACKUP_ALARM)
    return
  }
  const pending = await chrome.alarms.get(BACKUP_ALARM)
  if (pending) return
  chrome.alarms.create(BACKUP_ALARM, {delayInMinutes: settings.autoBackupMinutes})
}

/**
 * 刚写完划线：如果没有排期，就排一个「间隔与 debounce 取小」的备份。
 *
 * 取小是刻意的：设成「每天」的人也希望当天划完不久就存一次，
 * 而不是等满 24 小时；设成「每小时」时则不必更勤。
 */
export async function scheduleAfterWrite(): Promise<void> {
  const settings = await loadSettings()
  const status = await githubStatus()
  if (!status.connected || !status.hasRepo || settings.autoBackupMinutes <= 0) return
  const pending = await chrome.alarms.get(BACKUP_ALARM)
  if (pending) return
  const minutes = Math.min(settings.autoBackupMinutes, WRITE_DEBOUNCE_MINUTES)
  chrome.alarms.create(BACKUP_ALARM, {delayInMinutes: minutes})
}

/**
 * alarm 触发：备份一次，然后排下一次。
 *
 * 凭据失效时**不再排下次**：一个过期 token 每 5 分钟失败一轮没有意义，
 * 用户重新连接时 `syncBackupAlarm()` 会把排期接上。
 */
export async function runScheduledBackup(): Promise<PushOutcome> {
  const outcome = await pushBackup()
  if (outcome.kind === 'unauthorized') {
    await chrome.alarms.clear(BACKUP_ALARM)
    return outcome
  }
  await syncBackupAlarm()
  return outcome
}
