/**
 * Markdown 解析的用例。
 *
 * 三类最要紧的事：
 * 1. **HTML 不能以任何形式变成可执行节点**（一律降级为纯文本）；
 * 2. **不安全链接不留可点入口**；
 * 3. **不认识的结构不能丢内容**（退化成原文）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {parseMarkdown, safeHref, type MdBlock, type MdInline} from './markdown'

/** 把节点树压成一行便于断言。 */
function flat(blocks: readonly MdBlock[]): string {
  return JSON.stringify(blocks)
}

function inlines(blocks: readonly MdBlock[]): MdInline[] {
  const first = blocks[0]
  return first && first.type === 'paragraph' ? first.children : []
}

test('段落、粗体、斜体、行内代码、删除线', () => {
  const blocks = parseMarkdown('一段**粗**、*斜*、`c`、~~删~~')
  assert.deepEqual(inlines(blocks), [
    {type: 'text', text: '一段'},
    {type: 'strong', children: [{type: 'text', text: '粗'}]},
    {type: 'text', text: '、'},
    {type: 'em', children: [{type: 'text', text: '斜'}]},
    {type: 'text', text: '、'},
    {type: 'code', text: 'c'},
    {type: 'text', text: '、'},
    {type: 'del', children: [{type: 'text', text: '删'}]}
  ])
})

test('标题深度被收进 1..6', () => {
  const blocks = parseMarkdown('### 小标题')
  assert.equal(blocks[0]?.type, 'heading')
  if (blocks[0]?.type === 'heading') {
    assert.equal(blocks[0].depth, 3)
    assert.deepEqual(blocks[0].children, [{type: 'text', text: '小标题'}])
  }
})

test('代码围栏保留语言与原文（含尖括号）', () => {
  const blocks = parseMarkdown('```js\nconst a = 1 < 2 && "</script>"\n```')
  assert.deepEqual(blocks, [{type: 'code', lang: 'js', text: 'const a = 1 < 2 && "</script>"'}])
})

test('有序列表保留起始序号，无序列表不带序号', () => {
  const ordered = parseMarkdown('3. three\n4. four')
  assert.equal(ordered[0]?.type, 'list')
  if (ordered[0]?.type === 'list') {
    assert.equal(ordered[0].ordered, true)
    assert.equal(ordered[0].start, 3)
    assert.equal(ordered[0].items.length, 2)
  }
  const bullet = parseMarkdown('- a\n- b')
  if (bullet[0]?.type === 'list') assert.equal(bullet[0].ordered, false)
})

test('嵌套列表保留层级，不把子项拍平', () => {
  const blocks = parseMarkdown('- a\n  - b\n- c')
  const list = blocks[0]
  assert.equal(list?.type, 'list')
  if (list?.type !== 'list') return
  assert.equal(list.items.length, 2)
  // 第一项里除了文字还有一层 list
  const firstItem = list.items[0] ?? []
  assert.ok(firstItem.some((b) => b.type === 'list'), flat(firstItem))
})

test('引用块里的内容是块级节点', () => {
  const blocks = parseMarkdown('> 第一行\n> 第二行')
  assert.equal(blocks[0]?.type, 'blockquote')
  if (blocks[0]?.type === 'blockquote') {
    assert.equal(blocks[0].children[0]?.type, 'paragraph')
  }
})

test('表格给出 header 与 rows', () => {
  const blocks = parseMarkdown('| a | b |\n| --- | :-: |\n| 1 | 2 |')
  const table = blocks[0]
  assert.equal(table?.type, 'table')
  if (table?.type !== 'table') return
  assert.equal(table.header.length, 2)
  assert.equal(table.rows.length, 1)
  assert.deepEqual(table.header[0], [{type: 'text', text: 'a'}])
})

test('硬换行变成 br，转义字符还原成字面量', () => {
  assert.deepEqual(inlines(parseMarkdown('a  \nb')), [
    {type: 'text', text: 'a'},
    {type: 'br'},
    {type: 'text', text: 'b'}
  ])
  assert.deepEqual(inlines(parseMarkdown('a \\*not em\\*')), [{type: 'text', text: 'a *not em*'}])
})

test('分隔线', () => {
  assert.deepEqual(parseMarkdown('---'), [{type: 'hr'}])
})

// —— 安全边界 ——

test('块级 HTML 降级为纯文本，不产生任何 HTML 节点', () => {
  const blocks = parseMarkdown('<script>alert(1)</script>')
  const serialized = flat(blocks)
  // 内容还在（能看到它写了什么），但只以 text 形式存在
  assert.ok(serialized.includes('script'), serialized)
  assert.equal(serialized.includes('"type":"html"'), false)
  assert.equal(serialized.includes('<script>'), true, '原文应当作为文字保留')
})

test('行内 HTML 同样只当文字', () => {
  const blocks = parseMarkdown('前<span onclick="x">中</span>后')
  assert.deepEqual(inlines(blocks), [
    {type: 'text', text: '前<span onclick="x">中</span>后'}
  ])
})

test('onerror 之类的载荷不会变成节点属性（产物里只有 text）', () => {
  const blocks = parseMarkdown('<img src=x onerror=alert(1)>')
  const serialized = flat(blocks)
  assert.equal(/"(href|src|onerror)":/.test(serialized), false, serialized)
  assert.ok(serialized.includes('onerror'), '载荷应当作为文字保留')
})

test('javascript: 链接降级成纯文本，不留 href', () => {
  const blocks = parseMarkdown('[点我](javascript:alert(1))')
  const serialized = flat(blocks)
  assert.equal(serialized.includes('javascript:alert'), false, serialized)
  assert.deepEqual(inlines(blocks), [{type: 'text', text: '点我'}])
})

test('data: / vbscript: / file: 链接同样拒绝', () => {
  for (const href of ['data:text/html,<script>x</script>', 'vbscript:msgbox', 'file:///etc/passwd']) {
    assert.equal(safeHref(href), null, href)
  }
})

test('http / https / mailto / 相对地址放行', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeHref('http://example.com'), 'http://example.com')
  assert.equal(safeHref('mailto:a@b.test'), 'mailto:a@b.test')
  assert.equal(safeHref('/relative/path'), '/relative/path')
  assert.equal(safeHref('#anchor'), '#anchor')
  assert.equal(safeHref('   '), null)
})

test('安全链接保留结构', () => {
  const blocks = parseMarkdown('[文](https://example.com)')
  assert.deepEqual(inlines(blocks), [
    {type: 'link', href: 'https://example.com', children: [{type: 'text', text: '文'}]}
  ])
})

test('图片降级为 alt 文本（不在卡片里加载远程图片）', () => {
  const blocks = parseMarkdown('![示意](https://x.test/a.png)')
  const serialized = flat(blocks)
  assert.equal(serialized.includes('"link"'), false)
  assert.equal(serialized.includes('a.png'), false)
  assert.deepEqual(inlines(blocks), [{type: 'text', text: '示意'}])
})

// —— 流式与健壮性 ——

test('未闭合的强调符退化成纯文本，不产生半截结构', () => {
  const blocks = parseMarkdown('这是**加粗')
  assert.deepEqual(inlines(blocks), [{type: 'text', text: '这是**加粗'}])
})

test('未闭合的代码围栏仍能渲染（只是还在增长）', () => {
  const blocks = parseMarkdown('```js\nconst a = 1')
  assert.equal(blocks[0]?.type, 'code')
  if (blocks[0]?.type === 'code') assert.equal(blocks[0].lang, 'js')
})

test('空输入与纯空白返回空数组', () => {
  for (const text of ['', '   ', '\n\n']) assert.deepEqual(parseMarkdown(text), [], JSON.stringify(text))
})

test('畸形输入不抛错（失败也只是一段纯文本）', () => {
  for (const text of ['[', '][]', '```', '|', '<', '***', '1.', '>']) {
    assert.doesNotThrow(() => parseMarkdown(text), JSON.stringify(text))
  }
})

