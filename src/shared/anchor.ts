/**
 * 创建划线锚定：把一段选区扩张成 `{core, prev, next}` 三元组。
 *
 * 产出 `{core, prev, next}` 三个字段，正是回放（`shared/relocate.ts`）消费的全部输入。
 * 两侧字段表**必须对称**：锚定多算一个只有写入方知道的字段，就是在堆无人消费的存储。
 *
 * `prev` / `next` 保留原始空白，与回放侧同一坐标系。
 *
 * 扩张策略：先取 8 个原始字符作为上下文窗口，命中不唯一就逐轮 +1，最多 10 轮。
 *
 * **与已存数据的差异（唯一性门槛）**：历史数据是「扩张到上限就收手，多处命中照样落库」，
 * 回放会静默画到第一处。这里要求最终窗口**唯一命中**，否则拒绝创建——一条会被画到
 * 别处的划线，比没画更坏，而且用户无从发现。
 */
import {foldSpaces, isTooShort, stripWs} from './whitespace'
import {type IndexLike} from './textIndex'

export interface Anchor {
  /** 划线原文，含原始空白 */
  core: string
  /** 前文，含原始空白 */
  prev: string
  /** 后文，含原始空白 */
  next: string
}

/** 创建失败的原因。文案由界面层决定（`content/index.ts`）。 */
export type AnchorFailure = 'TOO_SHORT' | 'NOT_FOUND' | 'AMBIGUOUS'

export type AnchorResult = {ok: true; anchor: Anchor} | {ok: false; reason: AnchorFailure}

export interface Context {
  prev: string
  next: string
}

/** 每侧上下文窗口的初始原始字符数。 */
const INITIAL_WINDOW = 8

/** 上下文最多扩张的轮数。 */
const MAX_ATTEMPTS = 10

/** 「上下文够长」的阈值，剥离空白后计。 */
const ENOUGH = 13

function trimStartWs(text: string): string {
  return text.replace(/^\s+/, '')
}

function trimEndWs(text: string): string {
  return text.replace(/\s+$/, '')
}

/**
 * 选区文本（按索引同一套节点拼出）：用带过滤的 TreeWalker 拼接，
 * 失败（例如区间跨了被排除的节点）时回落 `range.toString()`。
 */
export function selectionText(range: Range): string {
  const root = range.commonAncestorContainer
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  })

  const parts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const raw = text.textContent ?? ''
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : raw.length
    parts.push(raw.substring(start, end))
  }

  const joined = parts.join('')
  return joined.length > 0 ? joined : range.toString()
}

/** 节点在索引节点表里的下标；不在表里返回 -1。 */
function nodeIndexOf(nodes: readonly Text[], node: Node): number {
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i] === node) return i
  }
  return -1
}
/**
 * 前文：从 `(nodeIndex, offsetInNode)` 起向前拼接，每步对整串折叠空白，
 * 直到剥离后长度 ≥ `chars`。
 * 最后 `trimStart`，再**按原始长度**截取末 `chars` 个字符（与既有数据保持同构）。
 */
export function contextBefore(nodes: readonly Text[], nodeIndex: number, offsetInNode: number, chars: number): string {
  let buffer = ''
  let index = nodeIndex
  let offset = offsetInNode

  for (;;) {
    const raw = nodes[index]?.data ?? ''
    buffer = foldSpaces(raw.substring(0, offset) + buffer)
    if (stripWs(buffer).length >= chars) break
    index -= 1
    if (index < 0) break
    offset = nodes[index]?.data.length ?? 0
  }

  const trimmed = trimStartWs(buffer)
  return trimmed.length > chars ? trimmed.substring(trimmed.length - chars) : trimmed
}

/** 后文，与 `contextBefore` 对称。 */
export function contextAfter(nodes: readonly Text[], nodeIndex: number, offsetInNode: number, chars: number): string {
  let buffer = ''
  let index = nodeIndex
  let offset = offsetInNode

  for (;;) {
    const raw = nodes[index]?.data ?? ''
    buffer = foldSpaces(buffer + raw.substring(offset))
    if (stripWs(buffer).length >= chars) break
    index += 1
    if (index >= nodes.length) break
    offset = 0
  }

  const trimmed = trimEndWs(buffer)
  return trimmed.length > chars ? trimmed.substring(0, chars) : trimmed
}

/**
 * 扩张循环本体。
 * `contextAt(chars)` 由调用方决定「以 Range 为界」还是「以节点为界」，
 * 并且**在闭包里预先算好节点下标**——这里每轮都会调用它，不能每轮都扫一遍节点表。
 *
 * 退出条件有三条（唯一命中 / 上下文不再增长 / 轮数用完），三条都要在循环外再验一次：
 * 轮数用尽那一轮没有验过唯一性，不能信任循环里的判断。
 */
export function buildAnchor(core: string, index: IndexLike, contextAt: (chars: number) => Context): AnchorResult {
  if (isTooShort(core)) return {ok: false, reason: 'TOO_SHORT'}

  const corePlain = stripWs(core)
  // 正文里没有这段文字（选区跨了被排除的节点）：落库也没法回放，直接拒绝。
  if (index.freshIndexOf(corePlain) < 0) return {ok: false, reason: 'NOT_FOUND'}

  let prev = ''
  let next = ''
  let lastContext = ''
  let chars = INITIAL_WINDOW
  let round = 0

  for (;;) {
    const context = contextAt(chars)
    prev = context.prev
    next = context.next

    if (round >= MAX_ATTEMPTS) break
    round += 1
    if (lastContext.length > 0 && prev + next === lastContext) break

    // 只关心唯一性：加上这两侧上下文后能唯一命中就停止扩张。
    if (index.countCappedAt2(stripWs(prev) + corePlain + stripWs(next)).count <= 1) break

    // 还没唯一，或者两侧都还没达到 ENOUGH → 再扩一个字符。
    lastContext = prev + next
    chars += 1
    if (stripWs(prev).length >= ENOUGH && stripWs(next).length >= ENOUGH && round >= MAX_ATTEMPTS) break
  }

  // 退出路径有三条（唯一命中 / 上下文不再增长 / 轮数用完），统一在这里验一次：
  // 轮数用尽那一轮没有验过唯一性，所以不能信任循环里的判断。
  const {count} = index.countCappedAt2(stripWs(prev) + corePlain + stripWs(next))
  if (count === 0) return {ok: false, reason: 'NOT_FOUND'}
  if (count > 1) return {ok: false, reason: 'AMBIGUOUS'}
  return {ok: true, anchor: {core, prev, next}}
}

/** 以 Range 创建锚定。节点下标只算一次（每轮都会用）。 */
export function createAnchorFromRange(range: Range, index: IndexLike): AnchorResult {
  const core = selectionText(range) || ''
  const nodes = index.indexData().nodes
  const startIndex = nodeIndexOf(nodes, range.startContainer)
  const endIndex = nodeIndexOf(nodes, range.endContainer)
  const startOffset = range.startOffset
  const endOffset = range.endOffset

  return buildAnchor(core, index, (chars) => {
    // 边界不在索引节点里（多数是元素节点做边界）：上下文留空，
    // 定位会退到「只按 core 全文匹配」，与「上下文不再增长」那条退出路径结果一致。
    if (startIndex < 0 || endIndex < 0) return {prev: '', next: ''}
    return {
      prev: contextBefore(nodes, startIndex, startOffset, chars),
      next: contextAfter(nodes, endIndex, endOffset, chars)
    }
  })
}
