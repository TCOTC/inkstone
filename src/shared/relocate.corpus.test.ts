/**
 * 真实数据形态的 characterization 测试。
 *
 * 用例是历史划线里**原样**的三元组，包含它们各自的怪处：中文词中间有空格、
 * `prev` / `next` 首尾带空白、`next` 里又出现一次 `core`、`core` 里带换行。
 * 这些字面量是定位算法的输入契约——降级顺序、空白处理、偏移换算一改，这里先红。
 *
 * 断言方式：把 `prev + core + next` 当成**一个**文本节点交给定位，要求
 * `mode 0` + 落点覆盖的那段文字（去空白后）恰好等于 `core`（去空白后）。
 * 这正是「原页面一字未改时应当精确复原」的最小可验证形式。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {relocateHighlight} from './relocate'
import {fakeIndex} from './indexFixture'
import {stripWs} from './whitespace'

/** 历史导出里的真实三元组（节选，保留原始空白与换行）。 */
const CORPUS: ReadonlyArray<{text: string; prev: string; next: string}> = [
  {text: 'JavaScript 简介', prev: 't 编 程语言简介', next: '手册与规范代码编'},
  {text: '交互：alert、prompt 和 confirm', prev: 't"变量数据类型', next: '类型转换基础 运算'},
  {text: '函数', prev: 'itch" 语 句', next: '函数表达式箭头函'},
  {text: '测不准的阿波连 同学 第2期', prev: ' (全12话) ', next: ' 阿波連さんはは'},
  {text: '04\n认识HTML的标签', prev: '始说起05:45', next: '｜ tag ｜H'},
  {text: '108\nGrid网格划分2 fr单位的用法', prev: '本设置11:17', next: '06:51109'},
  {text: '我推的孩子 第2期', prev: ' 8月网 络配信 ', next: ' 【推しの子】 '},
  {text: '小市民系列', prev: ' (全20话) ', next: ' 小市民シリーズ'},
  {text: '无职转生第3期', prev: '说改2026春 ', next: ' 备战2026 '},
  {text: ' 僵尸搜寻中', prev: ' 漫改2026 ', next: ' 漫改2026 '},
  {text: '幼女战记第2期', prev: '小说改2026 ', next: ' 游戏改2026'},
  {text: 't 回到顶部 top', prev: '看搜索结果 ] ', next: ' g n 跳转到'},
  {text: '青春猪头少年\n不会梦到红书包女孩', prev: '2月----- ', next: ' 剧场先行202'}
]

/** 把落点还原成（去空白后的）原文。 */
function coveredText(index: ReturnType<typeof fakeIndex>, spans: ReadonlyArray<{nodeIndex: number; start: number; end: number}>): string {
  const {texts} = index.indexData()
  return stripWs(spans.map((span) => (texts[span.nodeIndex] ?? '').substring(span.start, span.end)).join(''))
}

test('历史数据：上下文完整时精确复原（mode 0）', () => {
  for (const item of CORPUS) {
    const index = fakeIndex([item.prev + item.text + item.next])
    const result = relocateHighlight(item, index)
    const label = JSON.stringify(item.text)

    assert.equal(result.errCode, 0, `${label} 应当定位成功`)
    assert.equal(result.mode, 0, `${label} 应当走 prev+core+next`)
    assert.equal(result.spans.length, 1, `${label} 应当只有一个落点`)
    assert.equal(coveredText(index, result.spans), stripWs(item.text), `${label} 落点应当覆盖原文`)
  }
})

test('历史数据：上下文被删掉后仍能靠 core 命中（mode 2）', () => {
  for (const item of CORPUS) {
    const index = fakeIndex([item.prev + item.text + item.next])
    const result = relocateHighlight({text: item.text, prev: '', next: ''}, index)

    assert.equal(result.errCode, 0, `${JSON.stringify(item.text)} 应当定位成功`)
    assert.equal(coveredText(index, result.spans), stripWs(item.text))
  }
})
