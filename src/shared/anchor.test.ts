import assert from 'node:assert/strict'
import test from 'node:test'
import {buildAnchor} from './anchor'
import {fakeIndex} from './indexFixture'

test('唯一命中时保留上下文原文', () => {
  const index = fakeIndex(['前文核心后文'])
  const result = buildAnchor('核心', index, () => ({prev: '前文', next: '后文'}))
  assert.ok(result.ok)
  assert.equal(result.anchor.core, '核心')
  assert.equal(result.anchor.prev, '前文')
  assert.equal(result.anchor.next, '后文')
})

test('产出的字段与回放侧的输入完全对齐（只有 core / prev / next）', () => {
  const result = buildAnchor('核心', fakeIndex(['前文核心后文']), () => ({prev: '前文', next: '后文'}))
  assert.ok(result.ok)
  assert.deepEqual(Object.keys(result.anchor).sort(), ['core', 'next', 'prev'])
})

test('纯空白选区不创建（不足 MIN_TEXT_LEN）', () => {
  const index = fakeIndex(['a b'])
  assert.deepEqual(buildAnchor('   ', index, () => ({prev: '', next: ''})), {ok: false, reason: 'TOO_SHORT'})
})

test('单个字符可以创建：下限只卡 MIN_TEXT_LEN，不额外要求两个字', () => {
  const result = buildAnchor(' a ', fakeIndex(['a b']), () => ({prev: '', next: ''}))
  assert.ok(result.ok)
  assert.equal(result.anchor.core, ' a ')
})

test('正文里没有这段文字时拒绝创建（落库也回放不出来）', () => {
  const index = fakeIndex(['无关内容'])
  const result = buildAnchor('核心', index, () => ({prev: '不该用到', next: '也不该用到'}))
  assert.deepEqual(result, {ok: false, reason: 'NOT_FOUND'})
})

test('上下文不唯一时继续扩张，直到能唯一定位', () => {
  const index = fakeIndex(['核心A', '核心B'])
  let rounds = 0
  const result = buildAnchor('核心', index, () => {
    rounds += 1
    // 第 1~2 轮给不出区分度，第 3 轮才把 A 带上。
    return rounds >= 3 ? {prev: 'A', next: ''} : {prev: '', next: ''}
  })
  assert.ok(result.ok)
  assert.equal(result.anchor.prev, 'A')
  assert.ok(rounds >= 3)
})

test('扩张到上限仍不唯一时拒绝创建（不落库，回放才不会画到别处）', () => {
  const index = fakeIndex(['核心核心', '核心'])
  const result = buildAnchor('核心', index, () => ({prev: '', next: ''}))
  assert.deepEqual(result, {ok: false, reason: 'AMBIGUOUS'})
})

test('上下文不再增长（贴近文档首尾）时也要验唯一性', () => {
  const index = fakeIndex(['A核心A核心'])
  let rounds = 0
  const result = buildAnchor('核心', index, () => {
    rounds += 1
    return {prev: 'A', next: ''}
  })
  assert.deepEqual(result, {ok: false, reason: 'AMBIGUOUS'})
  // 第 2 轮发现 prev+next 与上一轮相同就停了，没有空转到上限。
  assert.equal(rounds, 2)
})
