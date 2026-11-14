/**
 * 图标。
 *
 * 用 lucide 的图标数据（`[tag, attrs][]` 数组）就地建成 `<svg>`，不引任何运行时框架：
 * content script 是全站注入的单文件入口，能纯 DOM 就不引别的。
 *
 * **只具名导入用到的图标**。lucide 的 barrel 把每个图标 re-export 成独立模块
 * （`dist/esm/icons/*.mjs`，一图标一文件、无副作用、`sideEffects: false`），
 * 打包器可以只留下这几个；`createIcons()` 那类扫描全文档的 API 会让整个库进产物，
 * 这里**不要**用。
 *
 * 三处调用点都在 Shadow DOM 里：`:host { all: initial }` 会把 `color` 重置成黑色，
 * 所以 `stroke="currentColor"` 跟的是**按钮自己设的 color**，不是页面文字的。
 * 换色改 CSS 即可，不要往这里传色值。
 */
import {
  createElement,
  Check,
  CircleHelp,
  Copy,
  Highlighter,
  Languages,
  Pin,
  PinOff,
  RotateCw,
  Trash,
  X
} from 'lucide'

/**
 * lucide 的图标数据形状。
 *
 * 包没导出这个类型（`dist/lucide.d.ts` 里 `IconNode` 只有声明、不在 export 列表里），
 * 所以这里照抄一份最小的；字段对不上时 `createElement` 的参数类型会报错。
 */
type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][]

/**
 * 把一个图标建成 `<svg>`。
 *
 * `size` 是边长（px）；lucide 默认 24，界面上一般用 14~16，跟正文/按钮字号相称。
 */
function svg(node: IconNode, size: number): SVGElement {
  return createElement(node, {width: size, height: size})
}

/** 高亮（划词工具条上新建划线的那个按钮）。 */
export function highlighterIcon(size = 16): SVGElement {
  return svg(Highlighter, size)
}

/** 删除划线用的垃圾桶。（lucide 的 `Trash2` 是 `Trash` 的别名，路径完全相同，不用重复引入。） */
export function trashIcon(size = 14): SVGElement {
  return svg(Trash, size)
}

/** 关闭 / 复制失败用的叉。 */
export function closeIcon(size = 14): SVGElement {
  return svg(X, size)
}

/** 刷新（扩展已更新、本页需要重载时把工具条的按钮换成它）。 */
export function reloadIcon(size = 16): SVGElement {
  return svg(RotateCw, size)
}

/** 复制（划词工具条上复制选中文字的纯文本）。 */
export function copyIcon(size = 14): SVGElement {
  return svg(Copy, size)
}

/** 复制成功后的对勾（就地替换复制图标，1 秒后换回来）。 */
export function checkIcon(size = 14): SVGElement {
  return svg(Check, size)
}

/** 翻译（划词工具条）。 */
export function languagesIcon(size = 14): SVGElement {
  return svg(Languages, size)
}

/** 解释（划词工具条）。 */
export function helpIcon(size = 14): SVGElement {
  return svg(CircleHelp, size)
}

/** 钉住（AI 卡片右上角）：点一下就固定住，之后点卡片外面不会关掉。 */
export function pinIcon(size = 13): SVGElement {
  return svg(Pin, size)
}

/** 取消钉住（已固定的卡片上换成它）。`PinOff` 是另一套路径，不是 `Pin` 的别名。 */
export function unpinIcon(size = 13): SVGElement {
  return svg(PinOff, size)
}
