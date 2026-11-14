/**
 * 把选区周围的正文收集成「文本块数组」，交给 `shared/contextBudget.ts` 决定留多少。
 *
 * 这一层只做 DOM 遍历，**所有预算与截断的决定都在纯函数里**（那边有单测）。
 * 遍历本身依赖 DOM，所以只做人工验证。
 *
 * 三个刻意的取舍：
 *
 * 1. **不建全页索引**。`PageTextIndex` 是给定位划线用的，建一次要遍历整页并去空白
 *    （实测 4.4µs/文本节点）。划一次词用不着那个坐标系。
 * 2. **不把整页文字拼成一个字符串再截**。大页面上 `range.toString()` 会分配上百 KB。
 *    这里只在文本节点之间移动，凑够块数就停。
 * 3. **跳过无意义元素**。脚本、样式、表单控件、图注容器里的文字进了 prompt 只会干扰模型；
 *    用父元素标签名判定，不解样式（算样式要触发重排，太贵）。
 */
import {pickContext, type ContextParts} from '../shared/contextBudget'

/** 这些元素里的文字不进上下文。 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'NOSCRIPT',
  'TEMPLATE',
  'IMG',
  'VIDEO',
  'AUDIO',
  'FIGURE',
  'SVG',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'BUTTON'
])

/** 每侧最多收集多少个文本块，避免在超长页面上一直走。 */
const MAX_BLOCKS = 60

type Phase = 'before' | 'inside' | 'after'

/**
 * 某个文本节点相对选区的位置。
 *
 * `Range.comparePoint` 在节点不在同一个根时（Shadow DOM、跨文档 iframe）会抛错，
 * 那种情况当作「无关」跳过。
 */
function classify(range: Range, node: Text): Phase | 'skip' {
  try {
    if (range.comparePoint(node, node.length) === -1) return 'before'
    if (range.comparePoint(node, 0) === 1) return 'after'
    return 'inside'
  } catch {
    return 'skip'
  }
}

function acceptNode(node: Node): number {
  const parent = (node as Text).parentElement
  if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT
  if (!(node.textContent ?? '').trim()) return NodeFilter.FILTER_REJECT
  return NodeFilter.FILTER_ACCEPT
}

/**
 * 收集选区前后文，返回已经按预算截好的 `contextText`。
 *
 * 一次线性走文本节点：`before` 段累进前文、`inside` 段整体丢掉（原文另传）、
 * `after` 段累进后文。**换父元素就算换块**——`pickContext` 会在块之间补换行，
 * 比把 `<b>甲</b><i>乙</i>` 粘成「甲乙」更接近原文断句。
 */
export function collectSelectionContext(
  range: Range,
  selected: string,
  limit?: number
): ContextParts {
  const root = document.body ?? document.documentElement
  if (!root) return pickContext([], [], selected, limit)

  const prevBlocks: string[] = []
  const nextBlocks: string[] = []
  let phase: Phase = 'before'
  let parent: Element | null = null
  let buffer = ''

  const pushPrev = (text: string): void => {
    prevBlocks.push(text)
    // 前文只用得着紧贴选区的那几块；远处的块连字节预算都进不去，留着白占内存。
    if (prevBlocks.length > MAX_BLOCKS) prevBlocks.shift()
  }

  const flush = (): void => {
    const text = buffer.trim()
    buffer = ''
    if (!text) return
    if (phase === 'before') pushPrev(text)
    else if (phase === 'after') nextBlocks.push(text)
  }

  /** 切相位时先把当前缓冲落到**旧**相位上，否则段首的文字会落到错误的一侧。 */
  const setPhase = (next: Phase): void => {
    if (phase === next) return
    flush()
    phase = next
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode})
  let node = walker.nextNode() as Text | null

  while (node) {
    const position = classify(range, node)
    if (position === 'skip') {
      node = walker.nextNode() as Text | null
      continue
    }

    const text = node.textContent ?? ''
    const isStart = node === range.startContainer
    const isEnd = node === range.endContainer

    if (position === 'before') {
      if (parent !== node.parentElement) {
        flush()
        parent = node.parentElement
      }
      buffer += text
    } else if (position === 'inside') {
      // 起点在同一节点：选区之前的那半截算前文。
      if (isStart) {
        if (parent !== node.parentElement) {
          flush()
          parent = node.parentElement
        }
        buffer += text.slice(0, range.startOffset)
      }
      // 选区内侧的文字整体不要——它由 `selected` 单独传给 prompt。
      setPhase('inside')

      if (isEnd) {
        setPhase('after')
        const tail = text.slice(range.endOffset).trim()
        if (tail) nextBlocks.push(tail)
        // 注意：这里**不能**因为「起止同节点」就结束遍历。选区落在单个文本节点里是
        // 最常见的情形，提前 break 会让后面的段落全部进不了上下文（实测就是这样）。
      }
    } else {
      if (parent !== node.parentElement) {
        flush()
        parent = node.parentElement
      }
      buffer += isEnd ? text.slice(range.endOffset) : text
      if (nextBlocks.length >= MAX_BLOCKS) break
    }

    node = walker.nextNode() as Text | null
  }

  flush()
  return pickContext(prevBlocks, nextBlocks, selected.trim(), limit)
}
