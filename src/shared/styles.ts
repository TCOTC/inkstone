/**
 * 画笔样式 → `::highlight()` 声明。
 *
 * 只有一套输出：`highlightDeclarations()`。渲染方式是 CSS Custom Highlight（唯一），
 * 所以这里只保留 `::highlight()` 支持的属性，下划线用 `text-decoration` 近似
 * 传统做法里的 `border-bottom`。
 */
import {stripAlpha, withAlpha} from './colors'

/**
 * 画笔样式。1=荧光笔 2=实线下划线 3=虚线下划线 4=半透明底+下划线
 *
 * 放在样式模块而不是颜色模块：它决定的是 `::highlight()` 怎么写，颜色只是它的一个参数。
 * 默认用 1（荧光笔）；导出数据里的历史划线也全部按 1 渲染。
 */
export type PenStyle = 1 | 2 | 3 | 4

export const DEFAULT_PEN_STYLE: PenStyle = 1

/** 校验外部来源（存储 / 备份文件）里的画笔值。 */
export function isPenStyle(value: unknown): value is PenStyle {
  return value === 1 || value === 2 || value === 3 || value === 4
}

export interface StyleOptions {
  /** 暗色主题：画笔 4 的文字色不同 */
  dark?: boolean
  /** hover 态：画笔 4 的底色更浓（`"52"`，常态是 `"33"`） */
  hover?: boolean
  /** 近似定位（正文被改过）：底色更淡 / 下划线改虚线，与精确命中区分 */
  loose?: boolean
}

const MINE_TEXT_COLOR = '#000'
const MINE_TEXT_COLOR_DARK = '#E0E1E2'

/**
 * CSS Custom Highlight 模式：返回 `::highlight()` 里能用的声明。
 *
 * `::highlight()` 只接受继承类的文本属性（`color` / `background-color` /
 * `text-decoration-*` / `text-shadow`），没有 `border-bottom`，所以下划线用
 * `text-decoration` 近似；位置比 `border-bottom` 略高约 1px，这是已接受的差异。
 */
export function highlightDeclarations(
  penStyle: PenStyle,
  highlightColor: string,
  options: StyleOptions = {}
): Record<string, string> {
  const color = stripAlpha(highlightColor)
  const {dark = false, hover = false, loose = false} = options
  const underline: Record<string, string> = {
    'text-decoration-line': 'underline',
    'text-decoration-color': color,
    'text-decoration-thickness': '2px',
    'text-underline-offset': '2px',
    'text-decoration-style': loose ? 'dashed' : 'solid'
  }

  switch (penStyle) {
    case 1:
      return {
        'color': MINE_TEXT_COLOR,
        'background-color': loose ? withAlpha(color, '66') : highlightColor
      }
    case 3:
      return {...underline, 'text-decoration-style': loose ? 'dashed' : 'dotted'}
    case 4:
      return {
        'color': dark ? MINE_TEXT_COLOR_DARK : MINE_TEXT_COLOR,
        'background-color': withAlpha(color, hover ? '52' : '33'),
        ...underline
      }
    case 2:
    default:
      return underline
  }
}

/** 把声明表拼成一条 CSS 声明串。 */
export function declarationsToCss(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .map(([property, value]) => `${property}:${value}`)
    .join(';')
}

/** CSS Highlight 的注册名。一个画笔一份。 */
export function highlightName(penStyle: PenStyle): string {
  return `ink-${penStyle}`
}

/**
 * hover 组的注册名。与底色组分开，才能只重设这一个组。
 * 名字里带画笔，规则就能在渲染时一次性写进 `<style>`，hover 时不再重写样式表。
 */
export function hoverHighlightName(penStyle: PenStyle): string {
  return `ink-hover-${penStyle}`
}

/** 近似命中的底色组名。与精确命中的组分开，才能给它更淡的样式。 */
export function looseHighlightName(penStyle: PenStyle): string {
  return `ink-${penStyle}-loose`
}

/** 近似命中的 hover 组名。 */
export function looseHoverName(penStyle: PenStyle): string {
  return `ink-hover-${penStyle}-loose`
}
