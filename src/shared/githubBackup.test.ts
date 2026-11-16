/**
 * GitHub 备份的传输层：读 / 写 / 历史 / 判等 / 摘要。
 *
 * 全部用注入的假 `fetch` 测：锁的是「请求长什么样」「大文件怎么读」、
 * 「什么情况下不提交」，真账号的端到端在设置页手工做。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKUP_PATH,
  commitMessage,
  listCommits,
  parseRepo,
  readAt,
  readRemoteFile,
  serializeBackup,
  shouldPush,
  tally,
  writeRemoteFile,
  type FetchLike,
  type RepoOptions
} from './githubBackup'
import {BACKUP_FORMAT} from './backup'
import {DEFAULT_SETTINGS, type PageRecord} from './types'

const REPO = {owner: 'TCOTC', repo: 'inkstone-backup'}

interface Call {
  url: string
  init?: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

function textResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => text
  } as unknown as Response
}

/** 按顺序回放的假 fetch。 */
function scripted(responses: Response[]): {fetchImpl: FetchLike; calls: Call[]} {
  const calls: Call[] = []
  let index = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({url, init})
    const response = responses[index] ?? jsonResponse({}, 500)
    index += 1
    return response
  }
  return {fetchImpl, calls}
}

function opts(fetchImpl: FetchLike, branch?: string): RepoOptions {
  return {token: 'ghu_test', repo: REPO, fetchImpl, ...(branch ? {branch} : {})}
}

function page(url: string, texts: string[]): PageRecord {
  return {
    url,
    title: '标题',
    createdAtSec: 1,
    highlights: texts.map((text, index) => ({
      id: index + 1,
      text,
      prev: '',
      next: '',
      createdAtSec: 1
    }))
  }
}

/** 备份对象的形态（`format` / `pages` 是 `readBackup` 的判据）。 */
function backupOf(pages: PageRecord[]): string {
  return JSON.stringify({format: BACKUP_FORMAT, exportedAt: 1, settings: {}, pages: pages.map((item) => ({
    u: item.url,
    t: item.title,
    c: item.createdAtSec,
    h: item.highlights.map((h) => ({i: h.id, x: h.text, p: h.prev, q: h.next, c: h.createdAtSec}))
  }))})
}

test('parseRepo：只认 owner/repo，脏串不发请求', () => {
  assert.deepEqual(parseRepo('TCOTC/inkstone-backup'), REPO)
  assert.deepEqual(parseRepo('  TCOTC/inkstone-backup  '), REPO)
  assert.equal(parseRepo('https://github.com/TCOTC/inkstone-backup'), null)
  assert.equal(parseRepo('TCOTC'), null)
  assert.equal(parseRepo(''), null)
  assert.equal(parseRepo('/repo'), null)
})

test('readRemoteFile：仓库空（404）返回 null，不当成失败', async () => {
  const {fetchImpl, calls} = scripted([jsonResponse({message: 'Not Found'}, 404)])
  assert.equal(await readRemoteFile(opts(fetchImpl)), null)
  assert.equal(calls[0]?.url, `https://api.github.com/repos/TCOTC/inkstone-backup/contents/${BACKUP_PATH}`)
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['Authorization'], 'Bearer ghu_test')
})

test('readRemoteFile：小文件走 JSON 的 base64，能解析出备份', async () => {
  const text = backupOf([page('https://a.test/1', ['甲'])])
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  // GitHub 会把 base64 折行，这里模拟带换行的形态。
  const wrapped = base64.replace(/(.{60})/g, '$1\n')
  const {fetchImpl, calls} = scripted([jsonResponse({sha: 'blob1', content: wrapped, encoding: 'base64'})])

  const file = await readRemoteFile(opts(fetchImpl))
  assert.equal(file?.sha, 'blob1')
  assert.equal(file?.text, text)
  assert.equal(file?.backup?.pages.length, 1)
  assert.equal(calls.length, 1, '小文件不该再发 raw 请求')
})

test('readRemoteFile：content 为空（>1MB）时改用 raw，且带 raw Accept 头', async () => {
  const text = backupOf([page('https://a.test/1', ['甲'])])
  const {fetchImpl, calls} = scripted([
    jsonResponse({sha: 'blob2', content: '', encoding: 'none'}),
    textResponse(text)
  ])

  const file = await readRemoteFile(opts(fetchImpl))
  assert.equal(file?.sha, 'blob2')
  assert.equal(file?.text, text)
  assert.equal(calls.length, 2)
  assert.equal((calls[1]?.init?.headers as Record<string, string>)['Accept'], 'application/vnd.github.raw')
})

test('readRemoteFile：坏 JSON 不抛，backup 给 null（仍然能拿到 sha 与原文）', async () => {
  const {fetchImpl} = scripted([jsonResponse({sha: 'blob3', content: Buffer.from('{坏').toString('base64')})])
  const file = await readRemoteFile(opts(fetchImpl))
  assert.equal(file?.sha, 'blob3')
  assert.equal(file?.backup, null)
})

test('readRemoteFile：非 404 的错误要抛，不能当「没有备份」', async () => {
  const {fetchImpl} = scripted([jsonResponse({message: 'Bad credentials'}, 401)])
  await assert.rejects(readRemoteFile(opts(fetchImpl)), /401/)
})

test('writeRemoteFile：PUT 带 message + base64 内容，首次不带 sha', async () => {
  const {fetchImpl, calls} = scripted([
    jsonResponse({commit: {sha: 'commit1', commit: {author: {date: '2026-11-16T00:00:00Z'}}}})
  ])
  const commit = await writeRemoteFile({...opts(fetchImpl), text: '{"a":1}', message: '备份 1 页 / 1 条'})

  assert.equal(commit.sha, 'commit1')
  assert.ok(commit.at > 0)
  assert.equal(calls[0]?.init?.method, 'PUT')
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
  assert.equal(body.message, '备份 1 页 / 1 条')
  assert.equal('sha' in body, false, '新文件不该带 sha')
  assert.equal(Buffer.from(String(body.content), 'base64').toString('utf8'), '{"a":1}')
})

test('writeRemoteFile：已有文件时带 sha；409 抛 CONFLICT 交给上层重试', async () => {
  const ok = scripted([jsonResponse({commit: {sha: 'c2', commit: {author: {date: '2026-11-16T00:00:00Z'}}}})])
  await writeRemoteFile({...opts(ok.fetchImpl), text: 'x', sha: 'blob1', message: 'm'})
  const body = JSON.parse(String(ok.calls[0]?.init?.body)) as Record<string, unknown>
  assert.equal(body.sha, 'blob1')

  const conflict = scripted([jsonResponse({message: 'sha does not match'}, 409)])
  await assert.rejects(
    writeRemoteFile({...opts(conflict.fetchImpl), text: 'x', sha: 'stale', message: 'm'}),
    /CONFLICT/
  )
})

test('listCommits：只取这个文件的历史，新的在前，message 只留第一行', async () => {
  const {fetchImpl, calls} = scripted([
    jsonResponse([
      {sha: 'c3', commit: {author: {date: '2026-11-16T10:00:00Z'}, message: '备份 2 页 / 3 条（+1 页 +2 条）\n\n正文'}},
      {sha: 'c2', commit: {author: {date: '2026-11-15T10:00:00Z'}, message: '备份 1 页 / 1 条'}}
    ])
  ])

  const commits = await listCommits(opts(fetchImpl))
  assert.deepEqual(commits.map((item) => item.sha), ['c3', 'c2'])
  assert.equal(commits[0]?.message, '备份 2 页 / 3 条（+1 页 +2 条）')
  assert.ok((commits[0]?.at ?? 0) > (commits[1]?.at ?? 0))

  const url = calls[0]?.url ?? ''
  assert.ok(url.includes(`path=${encodeURIComponent(BACKUP_PATH)}`), url)
  assert.ok(url.includes('per_page=30'), url)
})

test('listCommits：仓库空（404）返回空数组', async () => {
  const {fetchImpl} = scripted([jsonResponse({}, 404)])
  assert.deepEqual(await listCommits(opts(fetchImpl)), [])
})

test('readAt：按 sha 读历史版本', async () => {
  const text = backupOf([page('https://a.test/old', ['旧'])])
  const {fetchImpl, calls} = scripted([jsonResponse({content: Buffer.from(text).toString('base64')})])

  const backup = await readAt({...opts(fetchImpl), sha: 'c2'})
  assert.equal(backup?.pages.length, 1)
  assert.ok((calls[0]?.url ?? '').includes('ref=c2'))
})

test('tally / commitMessage：摘要带增减，第一份只写总量', () => {
  const before = tally([page('https://a.test/1', ['甲']), page('https://a.test/2', ['乙', '丙'])])
  assert.deepEqual(before, {pages: 2, highlights: 3})
  assert.equal(commitMessage(before, null), '备份 2 页 / 3 条')

  const after = tally([page('https://a.test/1', ['甲']), page('https://a.test/2', ['乙', '丙', '丁'])])
  assert.equal(commitMessage(after, before), '备份 2 页 / 4 条（+0 页 +1 条）')

  const shrunk = tally([page('https://a.test/1', ['甲'])])
  assert.equal(commitMessage(shrunk, before), '备份 1 页 / 1 条（-1 页 -2 条）')

  // 完全没变时不写括号：历史里不该出现「+0 页 +0 条」这种噪声。
  assert.equal(commitMessage(before, before), '备份 2 页 / 3 条')
})

test('shouldPush：内容相同就不提交；远端为空一定提交', () => {
  const text = backupOf([page('https://a.test/1', ['甲'])])
  assert.equal(shouldPush(text, null), true)
  assert.equal(shouldPush(text, text), false)
  assert.equal(shouldPush(text, text.replace('甲', '乙')), true)
})

test('shouldPush：只有 exportedAt 不同时不算变化（否则每次备份都多一个提交）', () => {
  const base = JSON.parse(backupOf([page('https://a.test/1', ['甲'])])) as Record<string, unknown>
  base.exportedAt = 1000
  const later = {...base, exportedAt: 999999}
  assert.equal(shouldPush(JSON.stringify(later), JSON.stringify(base)), false)

  // 真正的内容变化仍然要提交。
  const changed = {...base, exportedAt: 999999, pages: []}
  assert.equal(shouldPush(JSON.stringify(changed), JSON.stringify(base)), true)
})

test('shouldPush：远端是坏 JSON 时按原文判等，不会因此永远不提交', () => {
  assert.equal(shouldPush('{"a":1}', '{坏'), true)
  assert.equal(shouldPush('{坏', '{坏'), false)
})

test('serializeBackup：同一份数据序列化结果稳定（判等的前提）', () => {
  const backup = {format: BACKUP_FORMAT, exportedAt: 1, settings: DEFAULT_SETTINGS, pages: []}
  assert.equal(serializeBackup(backup), serializeBackup(backup))
  assert.equal(serializeBackup(backup), JSON.stringify(backup))
})
