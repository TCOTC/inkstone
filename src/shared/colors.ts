/**
 * 唯一的高亮色。
 *
 * 只保留一种颜色：所有划线都是槽位 1，多槽位 / 多主题的取色能力已经删掉。
 * 色值沿用既定配色，末两位是 alpha。
 */

/** 常态底色 */
export const HIGHLIGHT_COLOR = '#FFFF83B2'

/** hover 底色 */
export const HOVER_COLOR = '#FFFF00B2'

/**
 * UI 装饰色：右侧标记点、面板/列表左侧的色条、划词工具条高亮按钮的悬停色。
 *
 * 直接拿 `HIGHLIGHT_COLOR` 去掉 alpha 会得到 `#FFFF83`，在白底上几乎看不见，
 * 所以这里单独给一档更深的黄（同一个色相，明度压低）。
 */
export const ACCENT_COLOR = '#F0B90B'

/**
 * 浅底上的金色（工具条高亮按钮的悬停态）。
 *
 * `ACCENT_COLOR` 在白底上只有 1.8:1，图标级别的 2px 描边基本看不清；
 * 这个值同色相再压暗一档，白底 4.1:1、悬停底（`rgba(0,0,0,.06)` 叠白）3.6:1，
 * 都过了 WCAG 非文本对比度的 3:1。深底仍用 `ACCENT_COLOR`（1.8:1 反过来正好合适）。
 */
export const ACCENT_HOVER_COLOR = '#A77300'

/**
 * 工具栏图标角标的配色：与页面内 UI 装饰色同一个色相，纯黑字。
 *
 * 底色 `#F0B90B` 是亮黄，**只能配深色字**：白字在它上面只有 1.8:1（角标字号还不到
 * 10px，实际看就是一团白点）；纯黑是 9.4:1。之前用过项目正文色 `#1F2328`，
 * 在 10px 的角标上看不出跟纯黑的区别，不如直接用黑的。
 */
export const BADGE_BACKGROUND = ACCENT_COLOR

/** 角标文字色：纯黑，在金色底上 9.4:1。 */
export const BADGE_TEXT = '#000000'

/** 去掉 alpha 后缀（`#RRGGBBAA` → `#RRGGBB`）。 */
export function stripAlpha(color: string): string {
  return color.length <= 7 ? color : color.substring(0, 7)
}

/** 给六位色补上同一个 alpha，用于画笔 4 的半透明底。 */
export function withAlpha(color: string, alpha: string): string {
  return stripAlpha(color) + alpha
}
