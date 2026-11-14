/**
 * 高亮分组的纯规则。`content/highlighter.ts` 只负责把这些决定落到 `CSS.highlights` 上。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {baseName, planGroups} from './highlightPlan'
import {highlightName, hoverHighlightName, looseHighlightName, looseHoverName} from './styles'

function entry(id: number, approximate: boolean, ranges: string[]) {
  return {id, approximate, ranges}
}

test('精确命中与近似命中落到不同的底色组', () => {
  const plan = planGroups([entry(1, false, ['a']), entry(2, true, ['b', 'c'])], 1, {dark: false}, null)

  assert.equal(plan.base.size, 2)
  assert.deepEqual(plan.base.get(highlightName(1)), ['a'])
  assert.deepEqual(plan.base.get(looseHighlightName(1)), ['b', 'c'])
})

test('同组的多条划线合并成一个组（注册表里每组只有一个 Highlight）', () => {
  const plan = planGroups([entry(1, false, ['a']), entry(2, false, ['b'])], 2, {dark: false}, null)

  assert.equal(plan.base.size, 1)
  assert.deepEqual(plan.base.get(highlightName(2)), ['a', 'b'])
})

test('声明表总是给全四组：hover 切换不改样式表', () => {
  const plan = planGroups([], 3, {dark: true}, null)
  for (const name of [
    highlightName(3),
    hoverHighlightName(3),
    looseHighlightName(3),
    looseHoverName(3)
  ]) {
    assert.ok(plan.declarations.has(name), name)
  }
})

test('hover 组跟着被 hover 的那一条是不是近似命中', () => {
  const entries = [entry(1, false, ['a']), entry(2, true, ['b'])]
  assert.equal(planGroups(entries, 1, {dark: false}, 1).hover?.name, hoverHighlightName(1))
  assert.equal(planGroups(entries, 1, {dark: false}, 2).hover?.name, looseHoverName(1))
})

test('hover 一个不在本页的 id 时没有 hover 组', () => {
  assert.equal(planGroups([entry(1, false, ['a'])], 1, {dark: false}, 99).hover, null)
  assert.equal(planGroups([entry(1, false, ['a'])], 1, {dark: false}, null).hover, null)
})

test('baseName 与两个名字函数一致', () => {
  assert.equal(baseName(4, false), highlightName(4))
  assert.equal(baseName(4, true), looseHighlightName(4))
})
