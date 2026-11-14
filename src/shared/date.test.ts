import assert from 'node:assert/strict'
import test from 'node:test'
import {formatDate} from './date'

/** 原实现就是 `new Date(s * 1000).toLocaleDateString()`——这里把它当基准。 */
function legacy(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toLocaleDateString() : ''
}

test('formatDate：与 toLocaleDateString() 的结果逐个一致', () => {
  // 复用 `Intl.DateTimeFormat` 实例的前提是输出完全相同；跨年、跨闰日、夏令时切换
  // 那几天最容易暴露差异，所以把这几个边界都打一遍。
  const stamps = [
    1,
    946684800, // 2000-01-01
    951782400, // 2000-02-29
    1078012800, // 2004-02-29
    1704067200, // 2024-01-01
    1719792000, // 2024-07-01
    1735689599, // 2024-12-31 23:59:59
    1767225600 // 2026-01-01
  ]
  for (const seconds of stamps) {
    assert.equal(formatDate(seconds), legacy(seconds), `时间戳 ${seconds}`)
  }
})

test('formatDate：0 / 负数 / 非法值返回空串', () => {
  assert.equal(formatDate(0), '')
  assert.equal(formatDate(-1), '')
  assert.equal(formatDate(Number.NaN), '')
  assert.equal(formatDate(Number.POSITIVE_INFINITY), '')
  assert.equal(formatDate(Number.NEGATIVE_INFINITY), '')
})

test('formatDate：小数秒按毫秒截断，与 Date 的取整口径一致', () => {
  assert.equal(formatDate(946684800.9), legacy(946684800.9))
})
