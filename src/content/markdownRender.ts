/**
 * 中性节点树 → DOM。
 *
 * **只用 `createElement` + `textContent`，一处 `innerHTML` 都没有**：
 * 模型的输出是外部输入，字符串 HTML 进 DOM 就是给了它执行机会（Shadow DOM 不挡
 * `onerror` 这类内联事件）。解析与安全判定在 `shared/markdown.ts`（纯函数、有单测），
 * 这里只做执行。
 *
 * 长列表/代码块用 `DocumentFragment` 一次性拼好再替换：`replaceChildren` 一次插入，
 * 比逐个 `appendChild` 少若干次样式计算。
 */
import {parseMarkdown, type MdBlock, type MdInline} from '../shared/markdown'

/** 行内元素的标签映射。`strong` 用 `<strong>` 而不是 `<b>`：语义化，读屏友好。 */
const INLINE_TAG = {
  strong: 'strong',
  em: 'em',
  del: 'del'
} as const

/** 能装子节点的容器：`DocumentFragment` 与任何 `Element` 都行。 */
type Container = DocumentFragment | HTMLElement

function buildInline(nodes: readonly MdInline[], into: Container): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        into.append(document.createTextNode(node.text))
        break
      case 'br':
        into.append(document.createElement('br'))
        break
      case 'code': {
        const code = document.createElement('code')
        code.textContent = node.text
        into.append(code)
        break
      }
      case 'link': {
        const link = document.createElement('a')
        link.href = node.href
        link.textContent = '' // 先建空节点，再填内容
        // 外链一律新标签打开并切断 opener，避免目标页拿到 window.opener。
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        buildInline(node.children, link)
        into.append(link)
        break
      }
      default: {
        const element = document.createElement(INLINE_TAG[node.type])
        buildInline(node.children, element)
        into.append(element)
        break
      }
    }
  }
}

function buildBlock(block: MdBlock, into: Container): void {
  switch (block.type) {
    case 'paragraph': {
      const p = document.createElement('p')
      buildInline(block.children, p)
      into.append(p)
      break
    }
    case 'heading': {
      const heading = document.createElement(`h${block.depth}`)
      buildInline(block.children, heading)
      into.append(heading)
      break
    }
    case 'code': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      // 语言只作为 `data-lang` 展示，不引高亮器（那是另一个 15 KB 级别的依赖）。
      if (block.lang) code.dataset['lang'] = block.lang
      code.textContent = block.text
      pre.append(code)
      into.append(pre)
      break
    }
    case 'hr':
      into.append(document.createElement('hr'))
      break
    case 'blockquote': {
      const quote = document.createElement('blockquote')
      for (const child of block.children) buildBlock(child, quote)
      into.append(quote)
      break
    }
    case 'list': {
      const list: HTMLOListElement | HTMLUListElement = block.ordered
        ? document.createElement('ol')
        : document.createElement('ul')
      if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start
      for (const item of block.items) {
        const li = document.createElement('li')
        for (const child of item) {
          // 列表项里的段落不包 `<p>`：视觉上多一层空隙，且难与列表符号对齐。
          if (child.type === 'paragraph') buildInline(child.children, li)
          else buildBlock(child, li)
        }
        list.append(li)
      }
      into.append(list)
      break
    }
    case 'table': {
      // 包一层 div 让窄屏能横向滚动，而不是把卡片撑破。
      const wrap = document.createElement('div')
      wrap.className = 'table'
      const table = document.createElement('table')
      const thead = document.createElement('thead')
      const headRow = document.createElement('tr')
      for (const cell of block.header) {
        const th = document.createElement('th')
        buildInline(cell, th)
        headRow.append(th)
      }
      thead.append(headRow)
      table.append(thead)
      if (block.rows.length > 0) {
        const tbody = document.createElement('tbody')
        for (const row of block.rows) {
          const tr = document.createElement('tr')
          for (const cell of row) {
            const td = document.createElement('td')
            buildInline(cell, td)
            tr.append(td)
          }
          tbody.append(tr)
        }
        table.append(tbody)
      }
      wrap.append(table)
      into.append(wrap)
      break
    }
  }
}

/** 节点树 → `DocumentFragment`。调用方一次 `replaceChildren(fragment)` 即可。 */
export function renderMarkdown(blocks: readonly MdBlock[]): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const block of blocks) buildBlock(block, fragment)
  return fragment
}

export interface MarkdownRender {
  /** 解析后的块。 */
  blocks: MdBlock[]
  /** 已渲染的 DOM 片段。 */
  fragment: DocumentFragment
}

/**
 * 一步到位：文本 → 块 → DOM。
 *
 * 空文本返回空 fragment（调用方据此显示占位）。
 */
export function prepareMarkdown(text: string): MarkdownRender {
  const blocks = parseMarkdown(text)
  return {blocks, fragment: renderMarkdown(blocks)}
}
