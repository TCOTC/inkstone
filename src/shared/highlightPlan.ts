/**
 * 高亮分组的**纯决策**：哪些组要注册、每组给哪套样式、hover 落在哪一组。
 *
 * 抽出来的理由：`content/highlighter.ts` 的 `draw()` 同时干三件事——决定分组、
 * 维护 Range 缓存、跟 `CSS.highlights` 注册表做差分。前一件是纯逻辑（颜色与名字的规则），
 * 后两件才有 DOM。混在一起时「近似命中该用哪个组」这类规则只能靠肉眼在真实页面上验；
 * 分开之后规则有单测，DOM 那部分退化成照单执行。
 *
 * 组名的规则在 `shared/styles.ts`，这里不重复定义。
 */
import {HIGHLIGHT_COLOR, HOVER_COLOR} from './colors'
import {
  declarationsToCss,
  highlightDeclarations,
  highlightName,
  hoverHighlightName,
  looseHighlightName,
  looseHoverName,
  type PenStyle
} from './styles'

export interface PlanEntry<T> {
  id: number
  /** 近似命中（正文被改过）：单独分组，用更淡的样式 */
  approximate: boolean
  ranges: readonly T[]
}

export interface PlanOptions {
  dark: boolean
}

export interface GroupPlan<T> {
  /** 底色组：组名 → 该组负责的 ranges（保持传入顺序） */
  base: Map<string, T[]>
  /** 组名 → `::highlight()` 的声明串。四组（精确/近似 × 常态/hover）一次性给全 */
  declarations: Map<string, string>
  /** 当前 hover 的组；没有 hover（或 id 不在本页）时为 null */
  hover: {name: string; ranges: T[]} | null
}

/**
 * 算出这次渲染该有哪些组。
 *
 * 声明表总是给全四组：hover 切换只改注册表、不改样式表，所以规则必须提前写好。
 */
export function planGroups<T>(
  entries: ReadonlyArray<PlanEntry<T>>,
  penStyle: PenStyle,
  options: PlanOptions,
  hoverId: number | null
): GroupPlan<T> {
  const base = new Map<string, T[]>()
  for (const entry of entries) {
    const name = baseName(penStyle, entry.approximate)
    const bucket = base.get(name)
    if (bucket) bucket.push(...entry.ranges)
    else base.set(name, [...entry.ranges])
  }

  const declarations = new Map<string, string>()
  const addRule = (name: string, loose: boolean, hover: boolean): void => {
    if (declarations.has(name)) return
    declarations.set(
      name,
      declarationsToCss(
        highlightDeclarations(penStyle, hover ? HOVER_COLOR : HIGHLIGHT_COLOR, {
          dark: options.dark,
          hover,
          loose
        })
      )
    )
  }
  addRule(highlightName(penStyle), false, false)
  addRule(hoverHighlightName(penStyle), false, true)
  addRule(looseHighlightName(penStyle), true, false)
  addRule(looseHoverName(penStyle), true, true)

  let hover: GroupPlan<T>['hover'] = null
  if (hoverId !== null) {
    const entry = entries.find((item) => item.id === hoverId)
    if (entry) {
      hover = {
        name: entry.approximate ? looseHoverName(penStyle) : hoverHighlightName(penStyle),
        ranges: [...entry.ranges]
      }
    }
  }

  return {base, declarations, hover}
}

/** 底色组名：近似命中走 `-loose` 那一套。 */
export function baseName(penStyle: PenStyle, approximate: boolean): string {
  return approximate ? looseHighlightName(penStyle) : highlightName(penStyle)
}
