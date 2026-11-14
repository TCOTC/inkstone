/**
 * Server-Sent Events 的两级解析：字节 → 文本 → `data` 载荷。
 *
 * 只服务「一轮文本流式」这一种用法，所以只保留 `data` 字段；`event` / `id` / `retry`
 * 按规范**忽略**（不缓存、不回调）。依据是 WHATWG 事件流解析规则：
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * 三件容易踩的事在这里一次处理掉：
 *
 * 1. **解码必须以流的方式贯穿**。每块各 `decode(chunk)`（不带 `{stream:true}`）会把落在
 *    块边界上的多字节字符变成 U+FFFD —— 中文最先中招。用 `createSseDecoder()` 拿一个
 *    贯穿全程的解码器。
 * 2. **网络切块与行边界无关**。半行必须留到下一块再拼，不能假设「一块至少一行」。
 * 3. **`\r` 落在块末尾时仍是终止符，但要记住吞掉下一块开头的 `\n`**。
 *    两种错法都见过：把它当半行缓存下去，流在裸 CR 行尾处结束时会丢掉最后一条事件；
 *    直接当终止符又不做标记，则 `\r\n` 被切开时那个 `\n` 会变成空行，凭空派发一条事件。
 *
 * 只做解析，不做重试、不做 `Last-Event-ID` 续传 —— 当前场景（单轮翻译/解释）用不上，
 * 服务端也不会发这些字段。
 */

const LF = 10
const CR = 13
const SPACE = 32
const COLON = 58
const BOM = 0xfeff

/** 单条事件的缓冲上限（字符）。畸形流不该能把内存吃光，正常事件远小于这个数。 */
const DEFAULT_MAX_BUFFER = 1 << 20

export interface SseDecoder {
  /** 喂一段字节，返回已能拼出的文本（块边界切在多字节字符中间时返回空串）。 */
  push(bytes: Uint8Array): string
  /** 流正常结束：吐出解码器里残留的字符。正常流应为空串。 */
  flush(): string
}

/**
 * 贯穿整条流的字节解码器。
 *
 * `TextDecoder` 在 `{stream:true}` 下会把「不完整的 UTF-8 序列」暂存到下一次，
 * 这是唯一正确的用法；`new TextDecoder()` 放进循环里是最常见的错法。
 */
export function createSseDecoder(): SseDecoder {
  const decoder = new TextDecoder()
  return {
    push: (bytes) => decoder.decode(bytes, {stream: true}),
    flush: () => decoder.decode()
  }
}

export interface SseParserOptions {
  /** 单条事件的缓冲上限（字符）。超过就丢弃这条事件，直到下一个空行。默认 1 MiB。 */
  maxBufferSize?: number
}

export interface SseParser {
  /**
   * 喂一段**已解码的文本**，返回本次新派发的 `data` 载荷（可能是 0 条或多条）。
   *
   * 只有空行才会派发；结尾没有空行的事件会被留在缓冲里（规范要求丢弃，
   * 而我们无法区分「流还没结束」与「流已结束」，所以只是不派发）。
   */
  feed(chunk: string): string[]
  /** 丢弃全部缓冲。换流 / 重连前调用。 */
  reset(): void
}

/**
 * `data` 载荷解析器。纯字符串进出，不碰任何全局对象，可直接在 `node:test` 里测。
 */
export function createSseParser(options: SseParserOptions = {}): SseParser {
  const maxBuffer = options.maxBufferSize ?? DEFAULT_MAX_BUFFER

  /** 上一块末尾没能成行的半行。 */
  let pending = ''
  /** 当前事件累积的 `data`；`null` 表示这一条还没有 `data` 行。空串是合法值。 */
  let data: string | null = null
  /** BOM 只在流的最开头处理一次（`TextDecoder` 通常已经剥掉，这里是兜底）。 */
  let bomChecked = false
  /** 缓冲超限后进入丢弃态：只等空行，其余整行忽略。 */
  let dropping = false
  /**
   * 上一块以 `\r` 收尾时置位：下一块开头的 `\n` 属于同一个换行，必须吞掉。
   *
   * `\r` 本身**当场就是终止符**，不能留到下一块再判 —— 那样流在这里结束时
   * 会连最后一条事件一起丢掉（裸 CR 行尾的服务端就会踩到）。
   */
  let skipNextLf = false

  function dispatch(out: string[]) {
    if (data !== null) out.push(data)
    data = null
  }

  /** 丢弃态的唯一出口是空行 —— 空行才是事件边界。 */
  function endEvent() {
    data = null
    dropping = false
  }

  function handleLine(line: string, out: string[]) {
    if (dropping) {
      if (line === '') endEvent()
      return
    }

    // 空行 = 事件边界。
    if (line === '') {
      dispatch(out)
      return
    }

    // `:` 开头是注释（心跳常见形态）：整行忽略，**不能**当空行处理。
    if (line.charCodeAt(0) === COLON) return

    const colon = line.indexOf(':')
    // 没有冒号时整行是字段名、值为空串：`data` 单独成行也算一条空数据。
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') return // event / id / retry / 未知字段：忽略

    // 冒号后**只吃一个**前导空格（两个空格时第二个属于值）。
    let start = colon === -1 ? line.length : colon + 1
    if (line.charCodeAt(start) === SPACE) start++
    const value = line.slice(start)

    // 多行 `data:` 用 `\n` 拼成**一条**事件，不是并列多条。
    data = data === null ? value : `${data}\n${value}`

    if (data.length > maxBuffer) {
      // 一条事件大到不正常：丢掉它，从下一个空行起继续。
      data = null
      dropping = true
    }
  }

  function feed(chunk: string): string[] {
    if (!bomChecked && chunk.length > 0) {
      bomChecked = true
      if (chunk.charCodeAt(0) === BOM) chunk = chunk.slice(1)
    }
    // 上一块以 `\r` 收尾：这一块开头的 `\n` 是同一个换行（`\r\n` 被切开）。
    if (skipNextLf && chunk.length > 0) {
      skipNextLf = false
      if (chunk.charCodeAt(0) === LF) chunk = chunk.slice(1)
    }

    const out: string[] = []
    const text = pending + chunk
    pending = ''
    let i = 0

    while (i < text.length) {
      let end = -1
      let after = 0
      for (let j = i; j < text.length; j++) {
        const code = text.charCodeAt(j)
        if (code === LF) {
          end = j
          after = j + 1
          break
        }
        if (code === CR) {
          end = j
          if (j + 1 >= text.length) {
            // 末尾的 `\r` 已经是确定的终止符；只需记住吞掉下一块开头的 `\n`。
            after = j + 1
            skipNextLf = true
          } else {
            after = text.charCodeAt(j + 1) === LF ? j + 2 : j + 1
          }
          break
        }
      }
      if (end === -1) break
      handleLine(text.slice(i, end), out)
      i = after
    }

    pending = text.slice(i)
    if (pending.length > maxBuffer) {
      // 半行本身就超限了（没有终止符的畸形流）：丢掉，等空行恢复。
      pending = ''
      data = null
      dropping = true
    }
    return out
  }

  function reset() {
    pending = ''
    data = null
    dropping = false
    bomChecked = false
    skipNextLf = false
  }

  return {feed, reset}
}
