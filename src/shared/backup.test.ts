import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {BACKUP_FORMAT, backupFileName, parseBackup} from './backup'
import {DEFAULT_AI_LANGUAGE} from './prompt'
import {encodePage} from './rowCodec'
import {DEFAULT_SETTINGS, type PageRecord} from './types'

function page(): PageRecord {
  return {
    url: 'https://example.com/a',
    title: '标题',
    createdAtSec: 100,
    highlights: [{id: 1, text: '原文', prev: '前文', next: '后文', createdAtSec: 50}]
  }
}

function backup(patch: Record<string, unknown> = {}): unknown {
  return {
    format: BACKUP_FORMAT,
    exportedAt: 1,
    settings: {
      penStyle: 3,
      highlightEnabled: false,
      syncHighlights: true,
      translateLang: 'ja',
      aiThinking: true
    },
    pages: [encodePage(page())],
    ...patch
  }
}

test('parseBackup：认得的文件解析出页面与设置', () => {
  const result = parseBackup(backup())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.pages, [page()])
  // 以 `DEFAULT_SETTINGS` 为底：提示词默认值是多行长字符串，在这里再抄一份
  // 就是两处要同步维护的副本（模板内容由 `prompt.test.ts` 锁着）。
  assert.deepEqual(result.settings, {
    ...DEFAULT_SETTINGS,
    penStyle: 3,
    highlightEnabled: false,
    syncHighlights: true,
    translateLang: 'ja',
    aiThinking: true
  })
})

test('parseBackup：格式不对时明确说「不是备份」', () => {
  const result = parseBackup({format: 'some-other-format', pages: []})
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /不是 Inkstone 的备份/)
})

test('parseBackup：没有 pages 或有坏行时给出可读的原因', () => {
  const missing = parseBackup({format: BACKUP_FORMAT})
  assert.equal(missing.ok, false)

  const broken = parseBackup(backup({pages: [{n: 'oops'}]}))
  assert.equal(broken.ok, false)
  if (broken.ok) return
  assert.match(broken.error, /没有可导入的页面/)
})

test('parseBackup：设置缺失或非法时按默认值补齐', () => {
  const result = parseBackup(backup({settings: {penStyle: 99}}))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.settings, {
    ...DEFAULT_SETTINGS,
    penStyle: 1,
    highlightEnabled: true,
    syncHighlights: false,
    // 引用常量而不是字面量：写死一个语言代码会让用例在默认值变动时无故变红。
    translateLang: DEFAULT_AI_LANGUAGE,
    aiThinking: false
  })

  const absent = parseBackup(backup({settings: undefined}))
  assert.equal(absent.ok, true)
  if (!absent.ok) return
  assert.equal(absent.settings, null)
})

test('backupFileName：带日期、可排序', () => {
  assert.equal(backupFileName(new Date(2026, 10, 13)), 'inkstone-backup-20261113.json')
  assert.equal(backupFileName(new Date(2026, 0, 5)), 'inkstone-backup-20260105.json')
})

/**
 * `docs/initial-highlights.json` 是验收基准（design.md §10），也是仓库里唯一一份真实备份。
 *
 * 它不参与构建，所以字段一改就会悄悄失效——这个用例把它当成「用户手里的一份旧文件」来读，
 * 一旦格式漂移（多写一个已废弃的 `version`、留着改名前的设置字段）就在这里红掉。
 */
test('仓库里的验收基准备份仍能被当前解析器读完', () => {
  const path = fileURLToPath(new URL('../../docs/initial-highlights.json', import.meta.url))
  const result = parseBackup(JSON.parse(readFileSync(path, 'utf8')))
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.pages.length, 18)
  assert.equal(
    result.pages.reduce((sum, page_) => sum + page_.highlights.length, 0),
    117
  )

  // 设置必须是**当前**字段名：旧字段名会被当成未知字段收进 `extra`，从此一直跟着同步。
  assert.ok(result.settings)
  assert.equal(result.settings.extra, undefined)
  assert.equal(result.settings.penStyle, 1)
  assert.equal(result.settings.highlightEnabled, true)
})
