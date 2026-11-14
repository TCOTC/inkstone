import assert from 'node:assert/strict'
import test from 'node:test'
import {approxAlign, contextScore, FUZZY_MODE, mapToSpans, rawIndexAt, relocateHighlight, type RelocateItem} from './relocate'
import {fakeIndex} from './indexFixture'
import {stripWs} from './whitespace'

function item(patch: Partial<RelocateItem>): RelocateItem {
  return {text: '', prev: '', next: '', ...patch}
}

test('rawIndexAt：去空白偏移 → 原始偏移', () => {
  assert.equal(rawIndexAt('a b', 0), 0)
  assert.equal(rawIndexAt('a b', 1), 2)
  assert.equal(rawIndexAt('a b', 2), 3)
  assert.equal(rawIndexAt('a b', 9), 3)
})

test('mapToSpans：跨节点区间切成多段', () => {
  const spans = mapToSpans(['abc', 'def'], [3, 3], [0, 3, 6], 1, 4)
  assert.deepEqual(spans, [
    {nodeIndex: 0, start: 1, end: 3},
    {nodeIndex: 1, start: 0, end: 2}
  ])
})

test('降级顺序：prev+core+next 命中', () => {
  const index = fakeIndex(['这是前文', '核心文字', '后文'])
  const result = relocateHighlight(item({text: '核心文字', prev: '这是前文', next: '后文'}), index)
  assert.equal(result.errCode, 0)
  assert.equal(result.mode, 0)
  assert.deepEqual(result.spans, [{nodeIndex: 1, start: 0, end: 4}])
})

test('降级顺序：上下文对不上时退到只有 core', () => {
  const index = fakeIndex(['前缀', '核心', '后缀'])
  const result = relocateHighlight(item({text: '核心', prev: '不存在的文字'}), index)
  assert.equal(result.errCode, 0)
  assert.equal(result.mode, 2)
  assert.deepEqual(result.spans, [{nodeIndex: 1, start: 0, end: 2}])
})

test('prev 为空时 core+next 与完整针是同一串，落在 mode 0', () => {
  // mode 3 分支实际不可达：prev 剥离后为空时，`prev+core+next` 与 `core+next`
  // 是同一个字符串，第一支就会命中。这里把这条既有怪点固定下来，避免「优化」成两套行为。
  const index = fakeIndex(['头', '核心', '尾巴'])
  const result = relocateHighlight(item({text: '核心', next: '尾巴'}), index)
  assert.equal(result.errCode, 0)
  assert.equal(result.mode, 0)
  assert.deepEqual(result.spans, [{nodeIndex: 1, start: 0, end: 2}])
})

test('跨节点划线产生多段', () => {
  const index = fakeIndex(['abc', 'def'])
  const result = relocateHighlight(item({text: 'bcde'}), index)
  assert.equal(result.errCode, 0)
  assert.deepEqual(result.spans, [
    {nodeIndex: 0, start: 1, end: 3},
    {nodeIndex: 1, start: 0, end: 2}
  ])
})

test('正文里找不到原文 → 10004', () => {
  const index = fakeIndex(['完全不相关'])
  const result = relocateHighlight(item({text: '核心', prev: 'x'}), index)
  assert.equal(result.errCode, 10004)
  assert.equal(result.spans.length, 0)
})

test('空划线 → 10001；正文为空 → 10005', () => {
  assert.equal(relocateHighlight(item({text: ' '}), fakeIndex(['abc'])).errCode, 10001)
  assert.equal(relocateHighlight(item({text: '核心'}), fakeIndex([])).errCode, 10005)
})

test('空白差异不影响命中（去掉全部空白后比对）', () => {
  const index = fakeIndex(['核心\u00a0\n文字'])
  const result = relocateHighlight(item({text: '核心 文字'}), index)
  assert.equal(result.errCode, 0)
  assert.deepEqual(result.spans, [{nodeIndex: 0, start: 0, end: 6}])
})

test('单字符划线照常定位（阈值与创建侧共用 MIN_TEXT_LEN）', () => {
  const index = fakeIndex(['前文', '核', '后文'])
  const result = relocateHighlight(item({text: '核', prev: '前文', next: '后文'}), index)
  assert.equal(result.errCode, 0)
  assert.equal(result.mode, 0)
  assert.deepEqual(result.spans, [{nodeIndex: 1, start: 0, end: 1}])
})

test('core 重复出现且上下文对不上时落在第一次出现处（已知的静默错位）', () => {
  // 这个用例固定的是**风险**而不是期望行为：`prev`/`next` 是唯一能消歧的东西，
  // 上下文一起失效时回放只能取第一次出现。要避免它，锚定时必须给出足够的上下文。
  const index = fakeIndex(['核心', '中间', '核心'])
  const result = relocateHighlight(item({text: '核心', prev: '不存在的上下文'}), index)
  assert.equal(result.errCode, 0)
  assert.deepEqual(result.spans, [{nodeIndex: 0, start: 0, end: 2}])
})

/** 把落点还原成（去空白后的）原文。 */
function covered(index: ReturnType<typeof fakeIndex>, spans: ReadonlyArray<{nodeIndex: number; start: number; end: number}>): string {
  const {texts} = index.indexData()
  return stripWs(spans.map((span) => (texts[span.nodeIndex] ?? '').substring(span.start, span.end)).join(''))
}

test('消歧：core 多次出现且只剩 next 可用时选上下文最像的那一处', () => {
  // `prev` 不是紧邻的（页面改过），`prev+core` 命中不了 → 落到 mode 2；
  // 这时靠 `next` 把落点挑到第二处，而不是无条件取第一次出现。
  const index = fakeIndex(['核心甲核心乙丙'])
  const result = relocateHighlight(item({text: '核心', prev: '不相关的字', next: '乙'}), index)
  assert.equal(result.errCode, 0)
  assert.equal(result.mode, 2)
  assert.deepEqual(result.spans, [{nodeIndex: 0, start: 3, end: 5}])
})

test('消歧：上下文同分时，跨块的候选被扣分', () => {
  // 两处都能命中，上下文（`Z`）与谁都不重合 → 同分；后一处不跨块，于是胜出。
  const index = fakeIndex(['核心', '甲核心', '甲'], [0, 1, 1])
  const result = relocateHighlight(item({text: '核心甲', prev: 'Z'}), index)
  assert.equal(result.errCode, 0)
  assert.equal(result.spans[0]?.nodeIndex, 1)
})

test('contextScore：前文比后缀、后文比前缀', () => {
  assert.equal(contextScore('甲乙核心丙丁', 2, 2, '甲乙', '丙丁'), 1)
  assert.equal(contextScore('甲乙核心丙丁', 2, 2, '', ''), 0)
  // 前文只比「紧靠 core 的那一段」，所以 `乙` 命中、`甲` 不命中。
  assert.equal(contextScore('甲乙核心丙丁', 2, 2, '乙', ''), 1)
  assert.equal(contextScore('甲乙核心丙丁', 2, 2, '甲', ''), 0)
})

test('approxAlign：起点自由；允许一个字符的差异', () => {
  const exact = approxAlign('xxabcdefyy', 'abcdef', 1)
  assert.deepEqual(exact, {start: 2, end: 8, distance: 0})

  const oneError = approxAlign('xxabcXefyy', 'abcdef', 1)
  assert.equal(oneError?.distance, 1)
  assert.equal(oneError?.start, 2)

  // 差异超过上限就不算命中。
  assert.equal(approxAlign('xxabcXXfyy', 'abcdef', 1), null)
})

test('近似回退：正文被改过一个字时按 FUZZY_MODE 落点', () => {
  const index = fakeIndex(['前言JavaScript入门后记'])
  const result = relocateHighlight(item({text: 'JavaScript入門', prev: '前言', next: '后记'}), index)

  assert.equal(result.errCode, 0)
  assert.equal(result.mode, FUZZY_MODE)
  assert.equal(covered(index, result.spans), 'JavaScript入门')
})

test('近似回退：太短的正文不做近似（错一个字就是别的话了）', () => {
  const index = fakeIndex(['前言入门后记'])
  const result = relocateHighlight(item({text: '入們'}), index)
  assert.equal(result.errCode, 10004)
})

test('近似回退不影响精确命中', () => {
  const index = fakeIndex(['前言JavaScript入门后记'])
  const result = relocateHighlight(item({text: 'JavaScript入门', prev: '前言'}), index)
  assert.equal(result.errCode, 0)
  assert.notEqual(result.mode, FUZZY_MODE)
  assert.equal(covered(index, result.spans), 'JavaScript入门')
})
