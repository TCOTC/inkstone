import assert from 'node:assert/strict'
import test from 'node:test'
import {badgeText} from './badge'

test('badgeText：0 与非法值不显示角标', () => {
  assert.equal(badgeText(0), '')
  assert.equal(badgeText(-1), '')
  assert.equal(badgeText(Number.NaN), '')
  assert.equal(badgeText(Number.POSITIVE_INFINITY), '')
})

test('badgeText：正数原样写出来', () => {
  assert.equal(badgeText(1), '1')
  assert.equal(badgeText(12), '12')
  assert.equal(badgeText(999), '999')
})

test('badgeText：超过 999 收成 999+（角标最多 4 个字符）', () => {
  assert.equal(badgeText(1000), '999+')
  assert.equal(badgeText(123456), '999+')
})

test('badgeText：小数先取整（条数不会是小数，但别把 1.5 写成 1.5）', () => {
  assert.equal(badgeText(1.5), '1')
})
