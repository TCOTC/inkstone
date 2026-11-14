/** 展示用的格式化。纯函数，不碰 DOM 与存储。 */

/**
 * 复用的格式化器。
 *
 * 构造一个 `Intl.DateTimeFormat` 比调用一次 `format()` 贵一个数量级，而管理页
 * 一次渲染会给**每一行**调它。`toLocaleDateString()` 不带参数时用的就是这套
 * 默认选项（date-only、year/month/day 均为 numeric），所以结果与原来完全一致。
 * 语言取运行环境的默认值，不能在模块加载时固定成某个 locale。
 */
let formatter: Intl.DateTimeFormat | null = null

/** 秒级时间戳 → 本地日期；0 / 负数 / 非有限值返回空串。 */
export function formatDate(seconds: number): string {
  // 非有限值要挡在 `format()` 之前：`Intl.DateTimeFormat.format(Invalid Date)` 会抛
  // `RangeError`，而原来的 `toLocaleDateString()` 只是吐出 "Invalid Date"。
  // 两者都不该上屏，所以这里统一成空串（比原实现更严，是刻意的）。
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  formatter ??= new Intl.DateTimeFormat()
  return formatter.format(new Date(seconds * 1000))
}
