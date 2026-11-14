import assert from 'node:assert/strict'
import test from 'node:test'
import {nodeIndexForOffset} from './textIndex'

/** `starts` 是前缀和：`[0, 3, 7, 12]` 对应长度 `[3, 4, 5]` 的三个节点。 */
const STARTS = [0, 3, 7, 12]

test('nodeIndexForOffset：偏移落在哪个文本节点', () => {
  assert.equal(nodeIndexForOffset(STARTS, 0), 0)
  assert.equal(nodeIndexForOffset(STARTS, 2), 0)
  assert.equal(nodeIndexForOffset(STARTS, 3), 1)
  assert.equal(nodeIndexForOffset(STARTS, 6), 1)
  assert.equal(nodeIndexForOffset(STARTS, 7), 2)
  assert.equal(nodeIndexForOffset(STARTS, 11), 2)
})

test('nodeIndexForOffset：越过末尾钳到最后一个节点，负偏移与空索引返回 -1', () => {
  assert.equal(nodeIndexForOffset(STARTS, 99), 2)
  assert.equal(nodeIndexForOffset(STARTS, -1), -1)
  assert.equal(nodeIndexForOffset([0], 0), -1)
})
