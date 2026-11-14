/**
 * 回放重定位：把一条划线落回页面。
 *
 * 输入一条划线的三元组（正文 + 前后文），输出它落在哪几个文本节点的哪一段（原始偏移）。
 * 这里**不改写**任何输入字段，也不做「更聪明」的模糊匹配：与已存数据的一致性
 * 全靠下面的降级顺序。降级顺序改一处，就会有一批线落到别处。
 */
import {isTooShort, isWsCode, nbspToSpace, stripWs} from './whitespace'
import {nodeIndexForOffset, type IndexLike, type TextIndexData} from './textIndex'

/**
 * 定位错误码。编号固定：会写进未定位记录并在管理页展示，不要改数字。
 *
 * 只留**真的会被产出**的那几个：某个码一旦不再产生，就不该继续挂在表里——
 * 它会让「这个码是什么意思」的搜索指向一段已经不存在的分支。
 */
export const ERR = {
  EMPTY: 10001,
  NOT_FOUND: 10004,
  EMPTY_INDEX: 10005,
  MISMATCH: 10028
} as const

export type ErrCode = (typeof ERR)[keyof typeof ERR] | 0

/**
 * 近似命中的 `mode`。正文被改过一两个字时（错字修正、文案微调）走这一档，
 * 界面按「近似」标注，不与精确命中混为一谈。
 * 为什么不给新错误码：它**是成功的定位**，进未定位清单会让用户以为丢了数据。
 */
export const FUZZY_MODE = 4

export interface RelocateItem {
  text: string
  prev: string
  next: string
}

export interface Span {
  /** 相对于 `PageTextIndex.indexData().nodes` 的下标 */
  nodeIndex: number
  /** 节点内原始起始偏移 */
  start: number
  /** 节点内原始结束偏移（不含） */
  end: number
}

export interface RelocateResult {
  errCode: ErrCode
  /** 0=prev+core+next 1=prev+core 3=core+next 2=core 4=近似（见 `FUZZY_MODE`） */
  mode: number
  spans: Span[]
}

const FAIL = (errCode: ErrCode): RelocateResult => ({errCode, mode: -1, spans: []})

/**
 * 节点内：去空白偏移 → 原始偏移。
 * `target` 是「第几个非空白字符」（0 起）；越界时返回字符串长度。
 */
export function rawIndexAt(raw: string, target: number): number {
  if (target <= 0) return 0
  let seen = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (isWsCode(raw.charCodeAt(i))) continue
    if (seen === target) return i
    seen += 1
  }
  return raw.length
}

/**
 * 把「文本节点数组内的去空白区间」换算成每个节点内的原始区间。
 *
 * 跨节点划线会产生**多个**区间；渲染层把它们放进同一个 `Highlight` 的多条 `Range`。
 * 起点用 `starts` 二分定位，节点内按要吃掉的长度切开，所以不会出现被截短的区间。
 */
export function mapToSpans(
  texts: readonly string[],
  lengths: readonly number[],
  starts: readonly number[],
  start: number,
  length: number
): Span[] {
  if (length <= 0) return []

  let index = nodeIndexForOffset(starts, start)
  if (index < 0) return []

  const spans: Span[] = []
  let remaining = length
  let offsetInNode = start - (starts[index] ?? 0)

  while (remaining > 0 && index < texts.length) {
    const raw = texts[index] ?? ''
    const available = (lengths[index] ?? 0) - offsetInNode
    const take = Math.min(remaining, available)

    if (take > 0) {
      const from = rawIndexAt(raw, offsetInNode)
      const to = rawIndexAt(raw, offsetInNode + take - 1) + 1
      spans.push({nodeIndex: index, start: from, end: to})
      remaining -= take
    }

    index += 1
    offsetInNode = 0
  }

  return spans
}

/** 挑候选时最多看多少处重复。只为选「最像的一处」，不必穷举长页面里的一百次出现。 */
const MAX_CANDIDATES = 32

/** 近似定位所需的最小正文长度：比这更短的一段里错一个字就已经是别的话了。 */
const MIN_FUZZY_LEN = 6

/** 近似候选窗口在两侧留的余量（容纳插入 / 删除）。 */
const FUZZY_SLACK = 4

/**
 * 一条划线的完整重定位。
 *
 * 三处不能「顺手修正」的地方：
 * 1. 降级顺序固定：`prev+core+next` → `prev+core` → `core+next` → `core`。
 * 2. `core` 在正文里完全找不到时，先试一次**近似**匹配（`FUZZY_MODE`），仍不行才 10004。
 * 3. 只有落到 10028（偏移对不上）才 `rebuild()` 重试一次——索引落后于 DOM 时（后加载的正文）
 *    重建能救回来，而 `NOT_FOUND` 重建也不会有新结果。
 */
export function relocateHighlight(item: RelocateItem, index: IndexLike): RelocateResult {
  const core = nbspToSpace(item.text ?? '')
  // 与创建侧共用 `isTooShort`（`shared/whitespace.ts`）——**只有这一道门槛**。
  // 以前这里还有一层 `stripWs(core).length < MIN_TEXT_LEN` 的检查，与它重复：
  // 两层口径不同时（门槛抬高后），多出来的那层会让划线静默消失。
  if (isTooShort(core)) return FAIL(ERR.EMPTY)

  const prev = nbspToSpace(item.prev ?? '')
  const next = nbspToSpace(item.next ?? '')
  const corePlain = stripWs(core)

  const first = locate(corePlain, prev, next, index)
  if (first.errCode !== ERR.MISMATCH) return first
  index.rebuild()
  return locate(corePlain, prev, next, index)
}

function locate(corePlain: string, prev: string, next: string, index: IndexLike): RelocateResult {
  if (!index.hasText()) return FAIL(ERR.EMPTY_INDEX)

  const data = index.indexData()
  const prevPlain = stripWs(prev)
  const nextPlain = stripWs(next)

  const coreAt = index.indexOf(corePlain)
  if (coreAt < 0) return approximate(corePlain, prevPlain, nextPlain, data) ?? FAIL(ERR.NOT_FOUND)

  // ── 选针：优先最长上下文，逐步降级 ──
  // 注意 `else if` 的顺序：`prev` 非空但 `prev+core` 没命中时不会再试 `core+next`。
  // 这是既有行为（历史数据就是按这个顺序落的），改它会让一批线换位置。
  let mode = 2
  let probeAt = coreAt
  let hit = index.indexOf(prevPlain + corePlain + nextPlain)
  if (hit >= 0) {
    mode = 0
    probeAt = hit
  } else if (prevPlain) {
    hit = index.indexOf(prevPlain + corePlain)
    if (hit >= 0) {
      mode = 1
      probeAt = hit
    }
  } else if (nextPlain) {
    hit = index.indexOf(corePlain + nextPlain)
    if (hit >= 0) {
      mode = 3
      probeAt = hit
    }
  }
  if (mode === 2) probeAt = pickCandidate(data, corePlain, coreAt, prevPlain, nextPlain)

  const coreStart = probeAt + (mode === 0 || mode === 1 ? prevPlain.length : 0)
  const spans = mapToSpans(data.texts, data.lengths, data.starts, coreStart, corePlain.length)
  if (spans.length === 0) return FAIL(ERR.MISMATCH)
  return {errCode: 0, mode, spans}
}

/**
 * 同一段正文在页面里出现多次、而上下文针又没命中时，挑**上下文最像**的那一处，
 * 而不是无条件取第一次出现（那是已知的静默错位）。
 *
 * 只在 `mode 2` 且两侧至少有一侧上下文时启用；完全同分时仍取第一次出现。
 */
function pickCandidate(data: TextIndexData, corePlain: string, first: number, prevPlain: string, nextPlain: string): number {
  if (!prevPlain && !nextPlain) return first
  const hits = occurrences(data.text, corePlain, MAX_CANDIDATES)
  if (hits.length <= 1) return first

  let bestAt = first
  let bestScore = Number.NEGATIVE_INFINITY
  for (const at of hits) {
    const score =
      contextScore(data.text, at, corePlain.length, prevPlain, nextPlain) -
      crossesBlock(data, at, corePlain.length)
    if (score > bestScore) {
      bestScore = score
      bestAt = at
    }
  }
  return bestAt
}

/**
 * 前后文与命中位置两侧文字的重合度，0~1。两侧都没有上下文时返回 0（没有可用信号）。
 * `prev` 比后缀、`next` 比前缀——与锚定时截取的方向一致。
 */
export function contextScore(
  text: string,
  start: number,
  length: number,
  prevPlain: string,
  nextPlain: string
): number {
  let total = 0
  let sides = 0
  if (prevPlain) {
    total += suffixOverlap(text.substring(Math.max(0, start - prevPlain.length), start), prevPlain)
    sides += 1
  }
  if (nextPlain) {
    total += prefixOverlap(text.substring(start + length, start + length + nextPlain.length), nextPlain)
    sides += 1
  }
  return sides === 0 ? 0 : total / sides
}

/** 相同后缀长度 / `wanted` 长度。 */
function suffixOverlap(actual: string, wanted: string): number {
  const limit = Math.min(actual.length, wanted.length)
  let n = 0
  while (n < limit && actual.charCodeAt(actual.length - 1 - n) === wanted.charCodeAt(wanted.length - 1 - n)) {
    n += 1
  }
  return n / wanted.length
}

/** 相同前缀长度 / `wanted` 长度。 */
function prefixOverlap(actual: string, wanted: string): number {
  const limit = Math.min(actual.length, wanted.length)
  let n = 0
  while (n < limit && actual.charCodeAt(n) === wanted.charCodeAt(n)) n += 1
  return n / wanted.length
}

/** 这段区间是否跨了块级容器；跨了给 0.5 的扣分（假命中通常是把两段话缝在一起）。 */
function crossesBlock(data: TextIndexData, start: number, length: number): number {
  const first = nodeIndexForOffset(data.starts, start)
  const last = nodeIndexForOffset(data.starts, start + Math.max(0, length - 1))
  if (first < 0 || last < 0) return 0
  return (data.blocks[first] ?? 0) === (data.blocks[last] ?? 0) ? 0 : 0.5
}

/** `needle` 在 `text` 里出现的位置（最多 `cap` 个）。 */
function occurrences(text: string, needle: string, cap: number): number[] {
  const hits: number[] = []
  if (!needle) return hits
  let from = 0
  while (hits.length < cap) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    hits.push(at)
    from = at + 1
  }
  return hits
}

/** 正文长度决定允许几个字符的差异：短句错一个字就已经是别的话了。 */
function maxErrorsFor(length: number): number {
  return length >= 16 ? 2 : 1
}

/**
 * 精确匹配失败后的兜底：在正文里找与 `corePlain` 最接近的一段。
 *
 * 只在 `core` 完全找不到时才走这里，所以对**精确命中**的划线零影响。
 *
 * 做法：拿 `core` 的首 / 中 / 尾三段切片当锚点找候选窗口，再在窗口上跑带自由起点的
 * 编辑距离。所以整页扫描是「出现次数 × 窗口长度」，不是「整页 × 正文长度」。
 */
function approximate(
  corePlain: string,
  prevPlain: string,
  nextPlain: string,
  data: TextIndexData
): RelocateResult | null {
  const length = corePlain.length
  if (length < MIN_FUZZY_LEN) return null

  const text = data.text
  const maxErrors = maxErrorsFor(length)
  const chunkLength = Math.min(8, length)
  const offsets =
    length <= chunkLength ? [0] : [...new Set([0, Math.floor((length - chunkLength) / 2), length - chunkLength])]

  let best: {start: number; length: number; score: number} | null = null
  const tried = new Set<number>()

  for (const offset of offsets) {
    const chunk = corePlain.substring(offset, offset + chunkLength)
    for (const at of occurrences(text, chunk, MAX_CANDIDATES)) {
      const center = at - offset
      const from = Math.max(0, center - FUZZY_SLACK)
      const to = Math.min(text.length, center + length + FUZZY_SLACK)
      if (to - from < length || tried.has(from)) continue
      tried.add(from)

      const aligned = approxAlign(text.substring(from, to), corePlain, maxErrors)
      if (!aligned) continue

      const start = from + aligned.start
      const span = aligned.end - aligned.start
      const score =
        (1 - aligned.distance / length) * 2 +
        contextScore(text, start, span, prevPlain, nextPlain) -
        crossesBlock(data, start, span)
      if (!best || score > best.score) best = {start, length: span, score}
    }
  }

  if (!best) return null
  const spans = mapToSpans(data.texts, data.lengths, data.starts, best.start, best.length)
  if (spans.length === 0) return null
  return {errCode: 0, mode: FUZZY_MODE, spans}
}

export interface ApproxMatch {
  /** 在 `region` 里的起点 */
  start: number
  /** 在 `region` 里的终点（不含） */
  end: number
  /** 编辑距离 */
  distance: number
}

/**
 * 在 `region` 里找与 `needle` 最接近的一段（编辑距离 ≤ `maxErrors`，**起点自由**）。
 *
 * 起点自由是必需的：我们只关心「正文里哪一段像这句话」，不关心它对齐到第几个字符。
 * 实现是两行滚动 DP（O(needle × region) 时间、O(region) 空间），并顺带记下每格
 * 对齐的起点，所以不需要回溯整张表。
 */
export function approxAlign(region: string, needle: string, maxErrors: number): ApproxMatch | null {
  const n = needle.length
  const m = region.length
  if (n === 0 || m === 0) return null

  // 第一行全 0：空 needle 可以「从任意位置开始」，这就是自由起点。
  let prevCost = new Array<number>(m + 1).fill(0)
  let prevOrigin = Array.from({length: m + 1}, (_, index) => index)
  let curCost = new Array<number>(m + 1).fill(0)
  let curOrigin = new Array<number>(m + 1).fill(0)

  for (let i = 1; i <= n; i += 1) {
    curCost[0] = i
    curOrigin[0] = 0
    const code = needle.charCodeAt(i - 1)
    for (let j = 1; j <= m; j += 1) {
      const diag = (prevCost[j - 1] ?? 0) + (code === region.charCodeAt(j - 1) ? 0 : 1)
      const up = (prevCost[j] ?? 0) + 1
      const left = (curCost[j - 1] ?? 0) + 1
      if (diag <= up && diag <= left) {
        curCost[j] = diag
        curOrigin[j] = prevOrigin[j - 1] ?? 0
      } else if (up <= left) {
        curCost[j] = up
        curOrigin[j] = prevOrigin[j] ?? 0
      } else {
        curCost[j] = left
        curOrigin[j] = curOrigin[j - 1] ?? 0
      }
    }
    ;[prevCost, curCost] = [curCost, prevCost]
    ;[prevOrigin, curOrigin] = [curOrigin, prevOrigin]
  }

  let bestEnd = -1
  let bestCost = maxErrors + 1
  for (let j = 1; j <= m; j += 1) {
    const cost = prevCost[j] ?? Number.POSITIVE_INFINITY
    // 同分取**更靠后**的终点：插入 / 删除让「少匹配一个字符」也常常是最优解，
    // 取靠前那个会把落点截短（例如把 `JavaScript入门` 落成 `JavaScript入`）。
    if (cost <= bestCost) {
      bestCost = cost
      bestEnd = j
    }
  }
  if (bestEnd < 0 || bestCost > maxErrors) return null
  return {start: prevOrigin[bestEnd] ?? 0, end: bestEnd, distance: bestCost}
}
