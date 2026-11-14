import assert from 'node:assert/strict'
import test from 'node:test'
import {hashlessUrl, hostOf, looseKey, pageKey, samePageUrl} from './url'

test('hostOf：去掉 www. 与协议，非法 URL 返回空串', () => {
  assert.equal(hostOf('https://www.zhihu.com/question/1'), 'zhihu.com')
  assert.equal(hostOf('https://zh.javascript.info/tutorial/map'), 'zh.javascript.info')
  assert.equal(hostOf('不是 URL'), '')
})

test('hashlessUrl：只截 # 及其后内容', () => {
  assert.equal(hashlessUrl('https://a.com/x#part'), 'https://a.com/x')
  assert.equal(hashlessUrl('https://a.com/x'), 'https://a.com/x')
  assert.equal(hashlessUrl(''), '')
})

test('pageKey：做不改变语义的规范化（主机小写、空路径补 /、去默认端口、点段解析）', () => {
  assert.equal(pageKey('https://EXAMPLE.com'), 'https://example.com/')
  assert.equal(pageKey('https://example.com:443/x'), 'https://example.com/x')
  assert.equal(pageKey('https://example.com/./a/../b'), 'https://example.com/b')
  assert.equal(pageKey('https://example.com/a#section'), 'https://example.com/a')
})

test('pageKey：不合并那些「看着像同一页」的写法', () => {
  // 每一条都是刻意不做的归一化，改动会改变页面身份。
  assert.equal(pageKey('https://a.com/foo'), 'https://a.com/foo')
  assert.equal(pageKey('https://a.com/foo/'), 'https://a.com/foo/')
  assert.notEqual(pageKey('https://a.com/foo'), pageKey('https://a.com/foo/'))

  assert.notEqual(pageKey('http://a.com/x'), pageKey('https://a.com/x'))
  assert.notEqual(pageKey('https://www.a.com/x'), pageKey('https://a.com/x'))
  assert.notEqual(pageKey('https://a.com/Foo'), pageKey('https://a.com/foo'))
  assert.notEqual(pageKey('https://a.com/index.html'), pageKey('https://a.com/'))
})

test('pageKey：查询串保留原样，不排序也不删', () => {
  assert.equal(pageKey('https://a.com/?b=2&a=1'), 'https://a.com/?b=2&a=1')
  assert.notEqual(pageKey('https://a.com/?a=1&b=2'), pageKey('https://a.com/?b=2&a=1'))
  assert.equal(pageKey('https://a.com/?utm_source=x'), 'https://a.com/?utm_source=x')
})

test('pageKey：非法 URL 退回只截 hash', () => {
  assert.equal(pageKey('about:blank'), 'about:blank')
  assert.equal(pageKey('chrome-extension://abc/x.html#y'), 'chrome-extension://abc/x.html')
})

test('looseKey：剥掉 utm_* 与 Firefox ETP 那批参数', () => {
  assert.equal(looseKey('https://a.com/x?utm_source=news&utm_medium=email'), 'https://a.com/x')
  assert.equal(looseKey('https://a.com/x?fbclid=abc'), 'https://a.com/x')
  assert.equal(looseKey('https://a.com/x?gclid=1&mkt_tok=2'), 'https://a.com/x')
  assert.equal(looseKey('https://a.com/x?id=7&utm_source=news'), 'https://a.com/x?id=7')
})

test('looseKey：不动有语义的参数（删了会串页）', () => {
  assert.equal(looseKey('https://a.com/x?q=kagi'), 'https://a.com/x?q=kagi')
  assert.equal(looseKey('https://a.com/x?ref_=nav'), 'https://a.com/x?ref_=nav')
  assert.equal(looseKey('https://a.com/x?from=list'), 'https://a.com/x?from=list')
  assert.equal(looseKey('https://a.com/x?page=2'), 'https://a.com/x?page=2')
})

test('looseKey：没有查询串时与 pageKey 相同', () => {
  assert.equal(looseKey('https://a.com/x'), pageKey('https://a.com/x'))
  assert.equal(looseKey('https://a.com/x#frag'), pageKey('https://a.com/x#frag'))
})

test('samePageUrl：规范形式相同就算同一页', () => {
  assert.equal(samePageUrl('https://EXAMPLE.com/x', 'https://example.com/x'), true)
  assert.equal(samePageUrl('https://a.com/x#one', 'https://a.com/x#two'), true)
  assert.equal(samePageUrl('https://a.com/x', 'https://a.com/y'), false)
})

test('samePageUrl：只差追踪参数也算同一页', () => {
  assert.equal(samePageUrl('https://a.com/x?utm_source=news', 'https://a.com/x'), true)
  assert.equal(samePageUrl('https://a.com/x?fbclid=1&id=7', 'https://a.com/x?id=7'), true)
  // 有语义的参数不一样，就是不同页。
  assert.equal(samePageUrl('https://a.com/x?id=7', 'https://a.com/x?id=8'), false)
  assert.equal(samePageUrl('https://a.com/x?q=a', 'https://a.com/x?q=b'), false)
})

test('samePageUrl：空串一律不算同一页', () => {
  assert.equal(samePageUrl('', ''), false)
  assert.equal(samePageUrl('https://a.com/x', ''), false)
})
