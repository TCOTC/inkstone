/**
 * 上下文预算的用例。重点是「从远端砍」与「不劈开码点」这两条，不是覆盖率。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTEXT_BUDGET_BYTES,
  byteLength,
  headWithin,
  pickContext,
  tailWithin
} from './contextBudget'

test('byteLength 按 UTF-8 算：中文 3 字节，西文 1 字节', () => {
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('中文'), 6)
  assert.equal(byteLength('🙂'), 4)
})

test('tailWithin 从结尾取，不劈开代理对', () => {
  // '🙂' 是 4 字节，预算 3 时只能丢掉整个字符。
  assert.equal(tailWithin('ab🙂', 3), 'ab')
  assert.equal(tailWithin('ab🙂', 5), 'b🙂')
  assert.equal(tailWithin('abcdef', 0), '')
})

test('headWithin 从开头取，不劈开代理对', () => {
  // 预算 3 塞不下 4 字节的 emoji，就跳过它、继续取后面的字。
  assert.equal(headWithin('🙂ab', 3), 'ab')
  assert.equal(headWithin('🙂ab', 4), '🙂')
  assert.equal(headWithin('中文', 3), '中')
})

test('两侧都不超预算时不截断', () => {
  const parts = pickContext(['前一段'], ['后一段'], '中间')
  assert.equal(parts.prevText, '前一段')
  assert.equal(parts.nextText, '后一段')
  assert.equal(parts.contextText, '前一段中间后一段')
  assert.equal(parts.truncated, false)
})

test('前文超预算时保留紧贴选区的那一头', () => {
  // limit=20 → 每侧 10 字节；文档顺序是 aaaa → bbbb → cccc，所以要留下靠后的块。
  const parts = pickContext(['aaaa', 'bbbb', 'cccc'], [], 'X', 20)
  assert.ok(parts.prevText.endsWith('cccc'), parts.prevText)
  assert.ok(byteLength(parts.prevText) <= 10, `${byteLength(parts.prevText)} > 10`)
  assert.equal(parts.truncated, true)
})

test('后文超预算时同样从远端砍', () => {
  const parts = pickContext([], ['aaaa', 'bbbb', 'cccc'], 'X', 20)
  assert.ok(parts.nextText.startsWith('aaaa'), parts.nextText)
  assert.ok(byteLength(parts.nextText) <= 10, `${byteLength(parts.nextText)} > 10`)
  assert.equal(parts.truncated, true)
})

test('默认预算就是 800 字节，前后各 400', () => {
  const long = 'x'.repeat(1000)
  const parts = pickContext([long], [long], 'sel')
  assert.equal(byteLength(parts.prevText), 400)
  assert.equal(byteLength(parts.nextText), 400)
  assert.equal(parts.truncated, true)
  assert.equal(CONTEXT_BUDGET_BYTES, 800)
})

test('空块与空数组不影响结果', () => {
  const parts = pickContext(['', '甲', ''], ['', '乙', ''], '丙', 100)
  assert.equal(parts.contextText, '甲丙乙')
  assert.equal(parts.truncated, false)
})

test('预算为 0 时只留选中内容', () => {
  const parts = pickContext(['前'], ['后'], '中', 0)
  assert.equal(parts.contextText, '中')
  assert.equal(parts.truncated, true)
})
