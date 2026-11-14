/**
 * 文本归一化。**注意两套空白集合不一样**：正则那套与码点表那套刻意分开，不要合并。
 */

/**
 * 一条划线正文的最少有效字符数（剥离空白后计）。
 *
 * **创建侧（`shared/anchor.ts`）与回放侧（`shared/relocate.ts`）必须读同一个值**：
 * 只放开一边，会得到「划得进去、刷新后画不出来、也不进未定位清单」的静默丢失。
 * 提示文案（`content/index.ts`）也引用它，改这里就够了。
 */
export const MIN_TEXT_LEN = 1

/**
 * 删掉**全部**空白字符（正则 `\s`，含 `\u00a0` 与 `\u3000`）。
 * 正文索引与 `offset` 都在这个坐标系里。
 */
export function stripWs(text: string): string {
  return text.replace(/\s/g, '')
}

/** 只把不换行空格换成普通空格。索引里它会被 `stripWs` 吞掉，但对 `text` 本身有影响。 */
export function nbspToSpace(text: string): string {
  return text.replace(/\u00a0/g, ' ')
}

/** 把连续空白折叠成一个空格；`<img src=...>` 这类占位串直接视为空。 */
export function foldSpaces(text: string): string {
  if (!text || text.length === 0) return ''
  if (text.length >= 9 && text.substring(0, 9) === '<img src=' && text.endsWith('>')) return ''
  return text.replace(/[\n\s\t]+/g, ' ')
}

/**
 * 一条划线正文是不是**短到不值得定位**。
 *
 * **创建侧（`shared/anchor.ts`）与回放侧（`shared/relocate.ts`）只能读这一个判断**：
 * 两边口径一旦不一致，就会出现「划得进去、刷新后画不出来、也不进未定位清单」的静默丢失。
 *
 * 口径是 `stripWs`：偏移本来就在「去掉全部空白」的坐标系里，换成「只去首尾空白」的
 * 口径去量长度会随着门槛抬高而偏宽（中间的空白让短句过关）。
 */
export function isTooShort(text: string): boolean {
  return stripWs(text).length < MIN_TEXT_LEN
}

/**
 * 把去空白偏移换算成原始偏移时用的空白判定集合。
 * **不是** `\s`：12288 全角空格、8232/8233 行段分隔、160 nbsp、
 * 8195/8194 三点/二点空格，以及 9/10/13/8/12/11/32 这些 C0 空白。
 * 这份表与 `stripWs` 的正则不是同一集合，故意不合并。
 */
const WS_CODES = new Set([12288, 8232, 8233, 160, 9, 10, 13, 8, 12, 11, 32, 8195, 8194])

export function isWsCode(code: number): boolean {
  return WS_CODES.has(code)
}
