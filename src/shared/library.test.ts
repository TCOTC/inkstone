import assert from 'node:assert/strict'
import test from 'node:test'
import {filterPages, sortPages} from './library'
import type {HighlightRecord, PageRecord} from './types'

function highlight(overrides: Partial<HighlightRecord> = {}): HighlightRecord {
  return {id: 1, text: '原文', prev: '', next: '', createdAt: 0, ...overrides}
}

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    url: 'https://example.com/a',
    title: '标题',
    createdAt: 0,
    highlights: [highlight()],
    ...overrides
  }
}

test('filterPages：空关键词返回全部', () => {
  const pages = [page({url: 'https://a.com/1'}), page({url: 'https://a.com/2'})]
  assert.equal(filterPages(pages, '   ').length, 2)
})

test('filterPages：匹配标题与 URL，忽略大小写', () => {
  const pages = [
    page({url: 'https://zhuanlan.zhihu.com/p/1', title: 'Anki 教程'}),
    page({url: 'https://sspai.com/post/2', title: '别的东西'})
  ]
  assert.deepEqual(filterPages(pages, 'anki').map((p) => p.url), ['https://zhuanlan.zhihu.com/p/1'])
  assert.deepEqual(filterPages(pages, 'sspai').map((p) => p.url), ['https://sspai.com/post/2'])
  assert.deepEqual(filterPages(pages, 'ZHIHU').map((p) => p.url), ['https://zhuanlan.zhihu.com/p/1'])
})

test('filterPages：站点名是派生的，搜索也能命中', () => {
  const pages = [page({url: 'https://www.zhihu.com/question/1'})]
  assert.deepEqual(filterPages(pages, 'zhihu').map((p) => p.url), ['https://www.zhihu.com/question/1'])
})

test('filterPages：搜索文本按页面对象缓存，但换一个对象就重新算', () => {
  // 管理页里 `pages` 只整体替换一次，所以同一次会话里重复过滤不会重拼串。
  // 代价是「同一个 URL 换了内容」必须对应一个新对象，否则缓存会停在旧值——
  // 下面这条就是把这个前提钉住。
  const url = 'https://example.com/cached'
  const before = page({url, title: '旧标题'})
  assert.deepEqual(filterPages([before], '旧标题').map((p) => p.url), [url])
  assert.deepEqual(filterPages([before], '新标题'), [])

  const after = page({url, title: '新标题'})
  assert.deepEqual(filterPages([after], '新标题').map((p) => p.url), [url])
})

test('filterPages：划线正文在搜索范围里', () => {
  const pages = [
    page({title: '无关标题', highlights: [highlight({text: '卡片写作的最小阻力'})]})
  ]
  assert.equal(filterPages(pages, '最小阻力').length, 1)
  assert.equal(filterPages(pages, '不存在的词').length, 0)
})

test('sortPages：按创建时间倒序，不修改原数组', () => {
  const pages = [page({url: 'https://a.com/1', createdAt: 10}), page({url: 'https://a.com/2', createdAt: 30})]
  assert.deepEqual(sortPages(pages).map((p) => p.url), ['https://a.com/2', 'https://a.com/1'])
  assert.deepEqual(pages.map((p) => p.url), ['https://a.com/1', 'https://a.com/2'])
})

test('sortPages：同一时间按 URL 字典序，顺序稳定', () => {
  const pages = [page({url: 'https://a.com/b', createdAt: 5}), page({url: 'https://a.com/a', createdAt: 5})]
  assert.deepEqual(sortPages(pages).map((p) => p.url), ['https://a.com/a', 'https://a.com/b'])
})
