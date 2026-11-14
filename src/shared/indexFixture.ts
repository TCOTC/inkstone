/**
 * 测试替身：不用造 DOM 就能验证定位算法的 `IndexLike` 实现。
 *
 * **只给 `*.test.ts` 用**，不参与构建（入口里没有它的引用）。放成独立文件是因为
 * anchor / relocate 两个用例都需要同一份替身，复制两份就会漂移。
 */
import {stripWs} from './whitespace'
import type {IndexLike, TextIndexData} from './textIndex'

/** 把若干段文本当成一批文本节点，拼出与 `buildTextIndex` 同形的数据。 */
export function fakeIndex(parts: readonly string[], blocks?: readonly number[]): IndexLike {
  const texts = [...parts]
  const lengths = texts.map((text) => stripWs(text).length)
  const joined = texts.map(stripWs).join('')
  const starts = [0]
  for (const length of lengths) starts.push((starts[starts.length - 1] ?? 0) + length)

  const data: TextIndexData = {
    nodes: texts.map((value) => ({textContent: value}) as unknown as Text),
    texts,
    lengths,
    starts,
    blocks: blocks ? [...blocks] : texts.map(() => 0),
    text: joined
  }

  return {
    indexData: () => data,
    hasText: () => texts.length > 0,
    indexOf: (needle, from = 0) => (needle ? joined.indexOf(needle, from) : -1),
    freshIndexOf: (needle) => (needle ? joined.indexOf(needle) : -1),
    countCappedAt2: (needle) => {
      const first = joined.indexOf(needle)
      if (first < 0) return {count: 0, startOffset: -1}
      return {count: joined.indexOf(needle, first + 1) < 0 ? 1 : 2, startOffset: first}
    },
    rebuild: () => {}
  }
}
