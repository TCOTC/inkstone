import assert from 'node:assert/strict'
import test from 'node:test'
import {
  escapeMarkdownPlainText,
  formatCopyLink,
  pickLink,
  pickTitle,
  preferSelection
} from './copyLink'

test('pickTitle：按候选顺序取第一个非空', () => {
  assert.equal(pickTitle(['', '   ', 'og 标题', 'h1 标题'], 'example.com'), 'og 标题')
  assert.equal(pickTitle(['document 标题', 'og 标题'], 'example.com'), 'document 标题')
})

test('pickTitle：全空给占位，而不是空串', () => {
  assert.equal(pickTitle([], 'example.com'), 'No Title')
  assert.equal(pickTitle(['', ' '], 'example.com'), 'No Title')
})

test('pickTitle：普通站点截 256 字符', () => {
  const long = 'a'.repeat(300)
  assert.equal(pickTitle([long], 'example.com').length, 256)
  assert.equal(pickTitle(['a'.repeat(256)], 'example.com').length, 256)
})

test('pickTitle：社交站点只留第一行并截 64 字符', () => {
  assert.equal(pickTitle(['第一条\n第二条'], 'x.com'), '第一条')
  assert.equal(pickTitle(['  \n 第一条 \n'], 'x.com'), '第一条')
  assert.equal(pickTitle(['a'.repeat(100)], 'web.okjike.com').length, 64)
  // 别的域名不受这条规则影响。
  assert.equal(pickTitle(['a'.repeat(100)], 'example.com').length, 100)
})

test('pickLink：canonical 优先，相对地址按地址栏补全', () => {
  assert.equal(pickLink('https://example.com/a?utm=1', ['/clean']), 'https://example.com/clean')
  assert.equal(pickLink('https://example.com/a?utm=1', ['https://example.com/clean']), 'https://example.com/clean')
  assert.equal(pickLink('https://example.com/a?utm=1', ['//cdn.example.com/x']), 'https://cdn.example.com/x')
})

test('pickLink：canonical 无效时退到下一个候选，全空退回地址栏', () => {
  assert.equal(pickLink('https://example.com/a', ['', 'https://example.com/b']), 'https://example.com/b')
  assert.equal(pickLink('https://example.com/a', []), 'https://example.com/a')
  assert.equal(pickLink('https://example.com/a', ['   ']), 'https://example.com/a')
})

test('pickLink：只接受 http(s)，其余一律退回地址栏', () => {
  assert.equal(pickLink('https://example.com/a', ['javascript:alert(1)']), 'https://example.com/a')
  assert.equal(pickLink('https://example.com/a', ['chrome-extension://x/y']), 'https://example.com/a')
  assert.equal(pickLink('https://example.com/a', ['mailto:a@b.c']), 'https://example.com/a')
})

test('formatCopyLink：文本模式两行、无末尾换行', () => {
  assert.equal(formatCopyLink('标题', 'https://example.com/a', 'text'), '标题\nhttps://example.com/a')
})

test('formatCopyLink：文本模式保留多行选区，只去掉首尾空白', () => {
  assert.equal(
    formatCopyLink('第一段\n第二段\n', 'https://example.com/a', 'text'),
    '第一段\n第二段\nhttps://example.com/a'
  )
})

test('formatCopyLink：Markdown 模式', () => {
  assert.equal(formatCopyLink('标题', 'https://example.com/a', 'md'), '[标题](https://example.com/a)')
})

test('formatCopyLink：Markdown 里多行标题折成一行', () => {
  assert.equal(formatCopyLink('第一段\n\n第二段', 'https://e.com', 'md'), '[第一段 第二段](https://e.com)')
})

test('formatCopyLink：文本模式不转义，那里没有语法', () => {
  assert.equal(formatCopyLink('a[b]*c*', 'https://e.com', 'text'), 'a[b]*c*\nhttps://e.com')
})

test('escapeMarkdownPlainText：那些会改掉排版的字符逐个转义', () => {
  assert.equal(escapeMarkdownPlainText('a*b_c'), 'a\\*b\\_c')
  assert.equal(escapeMarkdownPlainText('[链接]'), '\\[链接\\]')
  assert.equal(escapeMarkdownPlainText('`代码`'), '\\`代码\\`')
  assert.equal(escapeMarkdownPlainText('1.2 (测试) #1 = $2 ^3 |4'), '1\\.2 \\(测试\\) \\#1 \\= \\$2 \\^3 \\|4')
})

test('escapeMarkdownPlainText：反斜杠先转义，且不会被后续规则再转一次', () => {
  assert.equal(escapeMarkdownPlainText('a\\b'), 'a\\\\b')
  assert.equal(escapeMarkdownPlainText('\\*'), '\\\\\\*')
})

test('escapeMarkdownPlainText：中文与字母不受影响', () => {
  assert.equal(escapeMarkdownPlainText('标题 abc 123'), '标题 abc 123')
})

test('escapeMarkdownPlainText：长文本走另一条分支，结果与短分支逐字符相同', () => {
  const alphabet = 'a*_[]!`<>&~{}()=#$^|.\\-'
  let seed = 7
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (const length of [511, 512, 513, 4000]) {
    let text = ''
    for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(random() * alphabet.length)] ?? 'a'
    const expected = text.replace(/[\\*_[\]!`<>&~{}()=#$^|.]/g, '\\$&')
    assert.equal(escapeMarkdownPlainText(text), expected, `length=${length}`)
  }
})

test('preferSelection：有选中文字就用它，空白才退回网页标题', () => {
  assert.equal(preferSelection('选中的一段话', '网页标题'), '选中的一段话')
  assert.equal(preferSelection('  两边有空白  ', '网页标题'), '两边有空白')
  assert.equal(preferSelection('', '网页标题'), '网页标题')
  assert.equal(preferSelection('  \n\t ', '网页标题'), '网页标题')
})

test('preferSelection：多行选区不折行、不截断（由拼装层按格式处理）', () => {
  const selected = '第一行\n第二行'.repeat(10)
  assert.equal(preferSelection(selected, '网页标题'), selected)
})
