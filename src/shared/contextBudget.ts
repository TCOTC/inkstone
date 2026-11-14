/**
 * 选区上下文的**字节预算**规则。
 *
 * 「带上下文」这件事的算法只在这里定：前后各取多少、按什么单位量、截断时从哪一头砍。
 * DOM 遍历在 `content/selectionContext.ts`——那一层只负责把相邻文本块收集成数组，
 * 所有「留多少」的决定都在这个纯函数里，所以能用 `node:test` 覆盖。
 *
 * 三条口径（照主流划词工具的做法，别自己发明）：
 *
 * 1. **按 UTF-8 字节量，不按字符数**。中英混排时字符数没有可比性：800 字符的中文是
 *    2.4 KB，800 字符的英文只有 800 B。按字节算，两边的 token 成本才稳定。
 * 2. **前后各占一半**。选中内容一般很短，均分是最省心的近似；不按选区长度动态分配，
 *    因为那会让「选一句」和「选一段」的上下文长度不可预测。
 * 3. **从远端砍**。保留紧贴选区的部分，截断发生在离选区最远的那一头——紧邻的文字
 *    才是消歧与语气判断真正需要的。
 */

const encoder = new TextEncoder()

/** 默认预算：前后合计 800 字节（约 260 个汉字，或 800 个英文字符）。 */
export const CONTEXT_BUDGET_BYTES = 800

/** 一个字符串的 UTF-8 字节数。 */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * 取**结尾**不超过 `maxBytes` 的一段。
 *
 * 按码点推进（`Array.from`）而不是按 UTF-16 下标切片：后者会把 emoji 之类的代理对
 * 劈成半个字符，发出去就是 U+FFFD。
 */
export function tailWithin(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  let end = chars.length
  while (start > 0) {
    const size = byteLength(chars[start - 1] ?? '')
    if (bytes + size > maxBytes) {
      // 只有紧贴边界的那个码点可以被整个丢掉（4 字节 emoji 塞不进剩余预算）；
      // 一旦已经取到内容就停下——否则会跳着取字，拼出来的文本不连续。
      if (start < end) break
      start--
      end = start
      continue
    }
    bytes += size
    start--
  }
  return chars.slice(start, end).join('')
}

/** 取**开头**不超过 `maxBytes` 的一段（同上，按码点切）。 */
export function headWithin(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const chars = Array.from(text)
  let bytes = 0
  let start = 0
  let end = 0
  while (end < chars.length) {
    const size = byteLength(chars[end] ?? '')
    if (bytes + size > maxBytes) {
      if (end > start) break
      end++
      start = end
      continue
    }
    bytes += size
    end++
  }
  return chars.slice(start, end).join('')
}

export interface ContextParts {
  /** `prevText + selected + nextText`，直接拼进 prompt 的那一份。 */
  contextText: string
  prevText: string
  nextText: string
  /** 是否因为预算而丢掉了部分上下文（界面上可以提示「上下文已截断」）。 */
  truncated: boolean
}

/**
 * 在预算内拼出上下文。
 *
 * `prevBlocks` / `nextBlocks` 是**文档顺序**的相邻文本块（可以理解为相邻的段落/行）；
 * 因为要用紧贴选区的那一头，`prevBlocks` 从数组**尾部**开始取。
 */
export function pickContext(
  prevBlocks: readonly string[],
  nextBlocks: readonly string[],
  selected: string,
  limit: number = CONTEXT_BUDGET_BYTES
): ContextParts {
  const half = Math.max(0, Math.floor(limit / 2))
  let truncated = false

  let prevText = ''
  let prevBytes = 0
  for (let i = prevBlocks.length - 1; i >= 0; i--) {
    const block = prevBlocks[i] ?? ''
    if (!block) continue
    // 块之间补一个换行，避免「上一段结尾」和「下一段开头」粘成一个词。
    const piece = prevText ? `${block}\n` : block
    const size = byteLength(piece)
    if (prevBytes + size <= half) {
      prevText = piece + prevText
      prevBytes += size
      continue
    }
    const room = half - prevBytes - (prevText ? 1 : 0)
    const keep = room > 0 ? tailWithin(piece, room) : ''
    if (keep.length < piece.length) truncated = true
    prevText = keep ? `${keep}${prevText ? '\n' : ''}${prevText}` : prevText
    break
  }

  let nextText = ''
  let nextBytes = 0
  for (let i = 0; i < nextBlocks.length; i++) {
    const block = nextBlocks[i] ?? ''
    if (!block) continue
    const piece = nextText ? `\n${block}` : block
    const size = byteLength(piece)
    if (nextBytes + size <= half) {
      nextText += piece
      nextBytes += size
      continue
    }
    const room = half - nextBytes - (nextText ? 1 : 0)
    const keep = room > 0 ? headWithin(piece, room) : ''
    if (keep.length < piece.length) truncated = true
    nextText = keep ? `${nextText}${nextText ? '\n' : ''}${keep}` : nextText
    break
  }

  return {contextText: prevText + selected + nextText, prevText, nextText, truncated}
}
