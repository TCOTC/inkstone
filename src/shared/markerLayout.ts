/**
 * 右侧标记点条的位置换算（纯函数，无 DOM）。
 *
 * 尺寸约定：每个点是 **14×3** 的圆角色条，放在 `right: 12px` 的 20×20 命中区里。
 *
 * 关键点：`rt` 不是「元素在页面里的位置」，而是**在滚动容器内容里的位置**。
 * 页面里存在 `overflow-y: auto|scroll` 的祖先时按那个容器算，否则按 body 算。
 */

/** 夹到 0~100，非法值当 0。 */
export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

/** 最近的滚动容器测量值（`scrollerOf()` 找到的那个）。 */
export interface ScrollerBox {
  /** 容器自身的 `getBoundingClientRect().top`（视口坐标） */
  top: number
  /** 容器的 `scrollTop` */
  scrollTop: number
  /** 容器的 `scrollHeight` */
  scrollHeight: number
}

export interface MarkerMeasure {
  /** 划线在**视口**坐标里的上边界（`getBoundingClientRect().top`） */
  rectTop: number
  /** 划线的包围盒高度 */
  rectHeight: number
  /** `window.scrollY` */
  scrollY: number
  /** `document.body.scrollHeight || clientHeight` */
  bodyHeight: number
  /** 存在滚动容器祖先时的测量值；没有则是 `null` */
  scroller: ScrollerBox | null
}

/**
 * 划线在「页面/滚动容器」里的垂直位置，百分比。
 *
 * 两条分支必须各自保持原样：
 * - **有滚动容器**：`(rect.top - 容器.top + 容器.scrollTop + rect.height / 2) / 容器.scrollHeight * 100`
 * - **没有**：`((rect.top + rect.bottom) / 2 + scrollY) / bodyHeight * 100`
 *
 * 前者用「相对容器内容顶部的中心」，后者用「相对文档的中心」。注意第二条用的是
 * `(top + bottom) / 2`，与第一条的 `top + height / 2` 数学等价，只是写法不同。
 */
export function markerPercent(measure: MarkerMeasure): number {
  const {rectTop, rectHeight, scrollY, bodyHeight, scroller} = measure
  if (scroller) {
    const raw = ((rectTop - scroller.top + scroller.scrollTop + rectHeight / 2) / (scroller.scrollHeight || 1)) * 100
    return clampPercent(raw)
  }
  const center = rectTop + rectHeight / 2
  return clampPercent(((center + scrollY) / (bodyHeight || 1)) * 100)
}

/**
 * 标记点容器的行内 `top` = `calc(rt% - 5px)`。
 *
 * 减 5px 是因为容器是 20×20：`rt%` 指向视口里的位置，减 5 让 3px 高的点大致落在
 * 那个位置的中间。**这是一个近似**，不是精确居中（精确值应是 `-10px`）。
 * 保持原值——改了标记点会整体偏移 5px。
 */
export function markerItemTop(percent: number): string {
  return `calc(${percent}% - 5px)`
}

/**
 * 展开列表的 `top`：先夹到 `[12, innerHeight - 12 - 列表可见高度]`。
 *
 * `listHeight` 是列表**可见**高度：`min(scrollHeight || 320, min(320, innerHeight - 24))`。
 */
export function markerListTop(itemTop: number, scrollHeight: number, innerHeight: number): number {
  const listHeight = Math.min(scrollHeight || 320, Math.min(320, innerHeight - 24))
  return Math.min(Math.max(itemTop, 12), innerHeight - 12 - listHeight)
}

/** 去掉**相邻**重复的 id（中间隔开的同 id 不算重复）。 */
export function dedupeAdjacent<T extends {id: number}>(items: readonly T[]): T[] {
  const out: T[] = []
  for (const item of items) {
    if (out.length > 0 && out[out.length - 1]?.id === item.id) continue
    out.push(item)
  }
  return out
}

/** 文档顺序的最小键：正文索引里的 `(节点下标, 节点内偏移)`。 */
export interface DocOrderKey {
  nodeIndex: number
  start: number
}

/**
 * 按**文档顺序**比较两条划线。
 *
 * 列表要按页面上的先后顺序排，而不是数据里的存储顺序。我们的 `page.highlights`
 * 是导入时的原始顺序（同一页里新划的线追加在末尾），直接拿来列表会「跳来跳去」。
 *
 * 排序键用 `relocateHighlight` 给出的首个 span：`nodeIndex` 是正文索引里的文本节点下标，
 * 与文档顺序一致；同一节点内再比 `start`。
 */
export function compareDocOrder(a: DocOrderKey, b: DocOrderKey): number {
  return a.nodeIndex - b.nodeIndex || a.start - b.start
}
