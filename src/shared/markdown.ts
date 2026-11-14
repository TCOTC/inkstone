/**
 * Markdown → **中性节点树**。解析交给 `marked`，渲染留给 `content/markdownRender.ts`。
 *
 * ## 为什么只取 `lexer()`，不用 `parse()`
 *
 * `marked.parse()` 输出 HTML 字符串，而模型的输出是**外部输入**。实测：
 * 把 `<img src=x onerror=alert(1)>` 写进 Markdown，`parse()` 会原样保留——
 * Shadow DOM **不阻止** `onerror` 这类内联事件，所以 `innerHTML = parse(...)` 就是 XSS。
 * 而 `DOMPurify` 又重度依赖 `document`（31 KB min / 11.8 KB gzip，29 处 `document` 引用），
 * 在 `node:test` 里根本跑不了。
 *
 * `marked.lexer()` 给的是纯 token 树，原始 HTML 有独立类型 `html`。只要**不把它交给
 * 任何 HTML 解析器**、用 `createElement` / `textContent` 自己建节点，DOM 里就永远不会
 * 出现字符串 HTML，也就不需要 sanitizer。
 *
 * ## 三条硬规则
 *
 * 1. **`html` token 降级为纯文本**（不是丢弃，也不是放行）。丢弃会静默吞掉模型写的内容；
 *    显示成字面量既安全又能让用户看出「这里它写了个标签」。
 * 2. **链接只认 http / https / mailto**。`javascript:` 之类一律降级成纯文本，
 *    连 `<a>` 都不建。
 * 3. **不认识的结构一律退化成它的原文**（`raw`）。宁可丑，不可丢。
 *
 * 纯函数，不碰 DOM 与全局，可直接进 `node:test`。
 */
import {marked, type Token, type Tokens} from 'marked'

/** 行内节点。 */
export type MdInline =
  | {type: 'text'; text: string}
  /** `soft` = 段落内的普通换行（源文本里的换行），渲染成空格或 `<br>` 视需要而定。 */
  | {type: 'br'}
  | {type: 'code'; text: string}
  | {type: 'strong'; children: MdInline[]}
  | {type: 'em'; children: MdInline[]}
  | {type: 'del'; children: MdInline[]}
  | {type: 'link'; href: string; children: MdInline[]}

/** 块级节点。 */
export type MdBlock =
  | {type: 'paragraph'; children: MdInline[]}
  | {type: 'heading'; depth: number; children: MdInline[]}
  | {type: 'code'; lang: string; text: string}
  | {type: 'list'; ordered: boolean; start: number; items: MdBlock[][]}
  | {type: 'blockquote'; children: MdBlock[]}
  | {type: 'hr'}
  | {type: 'table'; header: MdInline[][]; rows: MdInline[][][]}

/** 允许的链接协议。**白名单**，不写黑名单——黑名单永远漏。 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * 归一化链接地址。
 *
 * 相对地址（`/a/b`、`#x`）是安全的，返回原样（渲染层会拒绝点击跳转之外的用法）。
 * 解析失败的、协议不在白名单的一律返回 `null`，由调用方降级成纯文本。
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // 用 document 之外的 `URL` 做解析：它在 Node 与浏览器里都有。
  let url: URL
  try {
    url = new URL(trimmed, 'https://placeholder.invalid/')
  } catch {
    return null
  }
  if (SAFE_PROTOCOLS.has(url.protocol)) return trimmed
  // 相对地址：解析后落到 placeholder 上，视为安全。
  if (url.origin === 'https://placeholder.invalid') return trimmed
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 取 token 的原始文本（`raw`）。用于「不认识就退化成原文」。 */
function rawOf(token: unknown): string {
  return isRecord(token) && typeof token['raw'] === 'string' ? token['raw'] : ''
}

function textOf(token: unknown): string {
  return isRecord(token) && typeof token['text'] === 'string' ? token['text'] : ''
}

/** 行内 token → `MdInline[]`。`tokens` 缺省时退回 `text`。 */
function inlineOf(token: unknown): MdInline[] {
  if (!isRecord(token)) return []
  const children = token['tokens']
  if (Array.isArray(children)) return toInline(children as Token[])
  const text = textOf(token)
  return text ? [{type: 'text', text}] : []
}

function toInline(tokens: readonly Token[]): MdInline[] {
  const out: MdInline[] = []
  // 合并相邻文本：渲染时少建一堆节点，也让「未知 token 退化」不产生碎片。
  const pushText = (text: string): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') last.text += text
    else out.push({type: 'text', text})
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        // 注意：块级的 `text` token 自己还带一层 `tokens`（列表项里就是这样）。
        if (Array.isArray(token.tokens) && token.tokens.length > 0) {
          for (const child of toInline(token.tokens)) {
            if (child.type === 'text') pushText(child.text)
            else out.push(child)
          }
        } else {
          pushText(token.text)
        }
        break
      case 'escape':
        pushText(token.text)
        break
      case 'br':
        out.push({type: 'br'})
        break
      case 'codespan':
        out.push({type: 'code', text: token.text})
        break
      case 'strong':
        out.push({type: 'strong', children: inlineOf(token)})
        break
      case 'em':
        out.push({type: 'em', children: inlineOf(token)})
        break
      case 'del':
        out.push({type: 'del', children: inlineOf(token)})
        break
      case 'link': {
        const href = safeHref(typeof token.href === 'string' ? token.href : '')
        const children = inlineOf(token)
        if (href) out.push({type: 'link', href, children})
        // 不安全 / 解析不了：只留文字，绝不留可点入口。
        else for (const child of children) pushText(child.type === 'text' ? child.text : '')
        break
      }
      case 'image': {
        // 图片一律降级成它的 alt 文本（或 URL）：卡片里加载远程图片既慢又泄隐私。
        const label = typeof token.text === 'string' && token.text ? token.text : ''
        const href = typeof token.href === 'string' ? token.href : ''
        pushText(label || href)
        break
      }
      case 'html':
        // 见文件头规则 1：显示成字面量。
        pushText(typeof token.text === 'string' ? token.text : '')
        break
      default:
        pushText(rawOf(token) || textOf(token))
        break
    }
  }
  return out
}

/** 把列表项里那些「只有一个 text 块」的结构压平成纯行内，避免多余的 `<p>`。 */
function listItemBlocks(token: unknown): MdBlock[] {
  const children = isRecord(token) && Array.isArray(token['tokens']) ? (token['tokens'] as Token[]) : []
  const blocks: MdBlock[] = []
  for (const child of children) {
    if (child.type === 'text') {
      // 列表项的第一层 `text` 只有行内内容：直接并进上一段或新起一段。
      const inline = toInline(Array.isArray(child.tokens) ? child.tokens : [])
      const prev = blocks[blocks.length - 1]
      if (prev && prev.type === 'paragraph') prev.children.push(...inline)
      else blocks.push({type: 'paragraph', children: inline})
      continue
    }
    blocks.push(...toBlock(child))
  }
  return blocks
}

function toBlock(token: Token): MdBlock[] {
  switch (token.type) {
    case 'space':
      return []
    case 'heading':
      return [
        {
          type: 'heading',
          // `depth` 不在 marked 的公开类型里也要防越界：样式层只认 1..6。
          depth: Math.min(6, Math.max(1, Number(token.depth) || 1)),
          children: inlineOf(token)
        }
      ]
    case 'paragraph':
      return [{type: 'paragraph', children: inlineOf(token)}]
    case 'text':
      // 块级 text：列表项里常见。当段落处理。
      return [{type: 'paragraph', children: toInline(Array.isArray(token.tokens) ? token.tokens : [])}]
    case 'code':
      return [
        {
          type: 'code',
          lang: typeof token.lang === 'string' ? token.lang.trim().split(/\s+/)[0] ?? '' : '',
          text: typeof token.text === 'string' ? token.text : ''
        }
      ]
    case 'hr':
      return [{type: 'hr'}]
    case 'blockquote':
      return [
        {
          type: 'blockquote',
          children: Array.isArray(token.tokens) ? token.tokens.flatMap(toBlock) : []
        }
      ]
    case 'list': {
      const items = Array.isArray(token.items) ? token.items : []
      return [
        {
          type: 'list',
          ordered: token.ordered === true,
          start: typeof token.start === 'number' && token.start > 0 ? token.start : 1,
          items: items.map(listItemBlocks)
        }
      ]
    }
    case 'table': {
      const header = Array.isArray(token.header)
        ? token.header.map((cell: Tokens.TableCell) => inlineOf(cell))
        : []
      const rows = Array.isArray(token.rows)
        ? token.rows.map((row: Tokens.TableCell[]) => row.map((cell: Tokens.TableCell) => inlineOf(cell)))
        : []
      return [{type: 'table', header, rows}]
    }
    case 'html':
      // 块级 HTML（`<div>...</div>`、`<script>`）：同样降级成纯文本。
      return [
        {
          type: 'paragraph',
          children: [{type: 'text', text: typeof token.text === 'string' ? token.text : rawOf(token)}]
        }
      ]
    default:
      return fallbackBlock(token)
  }
}

/** 不认识的结构：有原文就显示原文，什么都没有就返回空。 */
function fallbackBlock(token: Token): MdBlock[] {
  const raw = rawOf(token).trim()
  if (!raw) return []
  return [{type: 'paragraph', children: [{type: 'text', text: raw}]}]
}

/**
 * 解析 Markdown 文本。
 *
 * **每次都整体重解析**：实测 1.4 KB 的 lexer 中位耗时 0.28 ms，而卡片是 30 ms 合并渲染，
 * 增量解析省下的那点时间远不如「永远拿到完整上下文」重要（未闭合的强调符只有整段才知道怎么闭合）。
 */
export function parseMarkdown(text: string): MdBlock[] {
  if (!text || !text.trim()) return []
  try {
    return marked.lexer(text).flatMap(toBlock)
  } catch {
    // 解析器内部异常（极端畸形输入）：整体退化成一段纯文本，绝不让界面白屏。
    return [{type: 'paragraph', children: [{type: 'text', text}]}]
  }
}
