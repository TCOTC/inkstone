/**
 * 本页划线的导航顺序。
 *
 * 列表与右侧标记点要按**正文里的先后**排，而不是数据里的存储顺序：`page.highlights`
 * 是导入时的原始顺序，同一页里新划的线追加在末尾，直接拿来列表会「跳来跳去」。
 *
 * 排序键是重定位给出的首个 span（`nodeIndex` 是正文索引里的文本节点下标，天然对应文档
 * 顺序；同一节点内再比 `start`）。这层是纯函数，`content/index.ts` 只负责提供输入。
 */
import {ACCENT_COLOR} from '../shared/colors'
import {compareDocOrder, type DocOrderKey} from '../shared/markerLayout'
import {FUZZY_MODE, type RelocateResult} from '../shared/relocate'
import type {HighlightRecord} from '../shared/types'
import type {MarkerEntry} from './markers'

/** 量出来的几何信息（来自 `Highlighter.measure()`）。 */
export interface MeasuredBox {
  rectTop: number
  rectHeight: number
  element: Element | null
}

export interface EntrySource {
  highlight: HighlightRecord
  result: RelocateResult
}

/**
 * 拼出导航条目并按文档顺序排好。
 *
 * 没有量到位置（`measured` 里没有这一条）就跳过——它画不出来，列在导航里点了也没反应。
 * 没有 span 的条目（理论上不该出现）排到最后，不影响别的顺序。
 */
export function buildMarkerEntries(
  items: readonly EntrySource[],
  measured: ReadonlyMap<number, MeasuredBox>
): MarkerEntry[] {
  const order: Array<{entry: MarkerEntry; key: DocOrderKey}> = []

  for (const {highlight, result} of items) {
    const box = measured.get(highlight.id)
    if (!box) continue
    const span = result.spans[0]
    order.push({
      entry: {
        id: highlight.id,
        text: highlight.text.trim(),
        color: ACCENT_COLOR,
        rectTop: box.rectTop,
        rectHeight: box.rectHeight,
        element: box.element,
        approximate: result.mode === FUZZY_MODE
      },
      key: span
        ? {nodeIndex: span.nodeIndex, start: span.start}
        : {nodeIndex: Number.MAX_SAFE_INTEGER, start: 0}
    })
  }

  order.sort((a, b) => compareDocOrder(a.key, b.key))
  return order.map((item) => item.entry)
}
