/**
 * prompt 拼装的用例。重点在「原文必须出现在给模型的那一段里」与「输出约束不能丢」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMessages,
  DEFAULT_AI_LANGUAGE,
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_TRANSLATE_PROMPT,
  defaultPrompt,
  defaultSystem,
  languageName,
  MAX_PROMPT_LENGTH,
  normalizePromptTemplate,
  normalizeSystemPrompt,
  PROMPT_CONTEXT_SLOT,
  PROMPT_LANG_SLOT,
  PROMPT_TEXT_SLOT
} from './prompt'
import type {AiAction, PromptInput} from './prompt'

/** 取 user 那一侧的正文（`buildMessages` 固定返回 [system, user]）。 */
function userContent(action: AiAction, input: PromptInput): string {
  const messages = buildMessages(action, input)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages[1]?.role, 'user')
  return messages[1]?.content ?? ''
}

/** 取 system 那一侧的正文。 */
function systemContent(action: AiAction, input: PromptInput): string {
  return buildMessages(action, input)[0]?.content ?? ''
}

test('没有上下文时 user 只有空 <context> 标签、任务与 <text> 块', () => {
  const content = userContent('explain', {text: '朝菌不知晦朔'})
  assert.ok(content.includes('朝菌不知晦朔'))
  // `{{context}}` 被替换成空串，那一行就空了；标签原样留着。
  assert.ok(content.startsWith('<context>\n\n</context>'), JSON.stringify(content.slice(0, 30)))
  assert.ok(content.includes('请解释 <text> 标签里的内容'), content)
})

test('带上下文时先给 <context> 块，再给任务', () => {
  const content = userContent('explain', {text: '朝菌不知晦朔', context: '前文朝菌不知晦朔后文'})
  const ctxAt = content.indexOf('<context>')
  const taskAt = content.indexOf('请解释')
  assert.ok(ctxAt === 0 && taskAt > ctxAt, content)
  assert.ok(content.includes('前文朝菌不知晦朔后文'))
})

test('上下文块与任务之间恰好一个空行（段分隔，不是贴在一起）', () => {
  const content = userContent('explain', {text: '甲', context: '前甲后'})
  const lines = content.split('\n')
  // 上下文块自己占三行（开标签 / 正文 / 闭标签）→ 空行 → 任务。
  assert.deepEqual(lines.slice(0, 3), ['<context>', '前甲后', '</context>'])
  assert.equal(lines[3], '')
  assert.ok((lines[4] ?? '').startsWith('请解释 <text> 标签里的内容'), lines[4] ?? '')
})

test('上下文与目标原文用不同的标签名（否则模型分不清该译哪一段）', () => {
  const content = userContent('translate', {text: '甲', context: '前甲后', language: 'en'})
  const lines = content.split('\n')
  assert.deepEqual(
    lines.filter((line) => line === '<context>' || line === '</context>'),
    ['<context>', '</context>']
  )
  assert.deepEqual(
    lines.filter((line) => line === '<text>' || line === '</text>'),
    ['<text>', '</text>']
  )
  // 上下文块在前，目标块在后；任务句里明说 <context> 不要一起译。
  assert.ok(content.indexOf('<context>') < content.indexOf('<text>'), content)
  assert.ok(content.includes('不要把它一起译'), content)
})

test('原文在最后以 <text> 块再出现一次', () => {
  const content = userContent('translate', {text: 'hello', context: 'x hello y'})
  assert.ok(content.endsWith('\n<text>\nhello\n</text>'), JSON.stringify(content.slice(-30)))
})

test('翻译先给完整译文、不加引导语，但允许在译文后补说明', () => {
  const translated = userContent('translate', {text: 'hi', language: 'ja'})
  assert.ok(translated.includes('先给出完整译文'))
  assert.ok(translated.includes('日语'))
  // 明确要求「不禁止解释」：允许在译文之后说明术语 / 歧义，否则用户看不懂译出来的是什么。
  assert.ok(!translated.includes('不要解释'), translated)
  assert.ok(translated.includes('说明'), translated)
})

test('解释同样以讲清为目的：允许引用原文，不设「少说」类限制', () => {
  const explained = userContent('explain', {text: 'hi'})
  // 曾经写「不要重复原文」——解释常常需要引几个词锚定，这条会把人往「换个说法」上带。
  assert.ok(!explained.includes('不要重复原文'), explained)
  assert.ok(explained.includes('引用原文里的词句'), explained)
  assert.ok(explained.includes('先直接说清它指的是什么'), explained)
  assert.ok(explained.includes('不要整段复述'), explained)
})

/**
 * system 与 user 模板**不重复同一句话**。
 *
 * 两侧职责分开：system 定角色、标准、边界与联网判据（每次请求都一样）；user 模板只说
 * 这次做什么、标签怎么用、答案长什么样（用户可改）。曾经三处两边各写一遍（「术语、歧义、
 * 语气差别等……之后说明」「按需补充背景、术语、言外之意」「不确定就说明、不要编造」），
 * 结果是改文案只改得动一处，两边开始漂移。这里做成机械检查：两句都按句读切开，
 * 取长度 ≥ 10 的片段，交集必须为空。
 */
test('system 与 user 模板不重复同一句话', () => {
  const clauses = (text: string): string[] =>
    text
      .split(/[。；，：、！？\n]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 10)
  for (const action of ['translate', 'explain'] as const) {
    const system = clauses(systemContent(action, {text: 'hi'}))
    const user = clauses(userContent(action, {text: 'hi'}))
    const shared = system.filter((part) => user.includes(part))
    assert.deepEqual(shared, [], `${action} 两侧重复：${shared.join(' / ')}`)
  }
})

/**
 * 用户不该在回答里看到「提示词」本身。
 *
 * 实测输出里出现过三类噪声：把我们拼的标签当主题、收尾讲「你该怎么理解它」、
 * 替用户臆想没问的问题。约束只用抽象表述——**不举反例**，反例本身会把提示词撑长，
 * 还会被模型当成可套用的句式。
 */
test('解释的回答里不得提到标签、任务本身或臆想的反问', () => {
  const explained = systemContent('explain', {text: 'hi'})
  assert.ok(explained.includes('不要提及提示词'), explained)
  assert.ok(explained.includes('不要议论任务本身'), explained)
  assert.ok(explained.includes('不要替用户设想问题'), explained)
  // 默认提示词里不放具体反例。
  assert.ok(!explained.includes('你把它理解成'), explained)
  assert.ok(!explained.includes('<context>'), explained)
})

test('解释的 system 不再把「简洁」排在「讲清楚」前面', () => {
  const explained = systemContent('explain', {text: 'hi'})
  assert.ok(!explained.includes('回答简洁'), explained)
  assert.ok(explained.includes('讲清楚'), explained)
  assert.ok(explained.includes('不要编造'), explained)
})

test('两个动作的 system 不一样：翻译是译者 + 助手，解释是阅读助手', () => {
  const translated = systemContent('translate', {text: 'hi'})
  const explained = systemContent('explain', {text: 'hi'})
  assert.notEqual(translated, explained)
  assert.ok(translated.includes('译者'), translated)
  assert.ok(translated.includes('看懂'), translated)
  assert.ok(explained.includes('阅读助手'), explained)
  // 曾经写过「只输出译文，不解释」，已按用户要求去掉。
  assert.ok(!translated.includes('不解释'), translated)
})

/**
 * 联网搜索的引导**必须**在 system 里。
 *
 * 请求里声明了 `deepseek_web_search`，但搜不搜完全由模型判断（`tool_choice` 不能强制它）。
 * 实测没有这句话时模型一次也不搜——它会把「不确定」当成终点。删掉这句就等于关掉联网。
 *
 * 但**不要要求模型「给出链接」**：引用是接口自带（`delta.annotations` 里的 `url_citation`），
 * 正文是干净 Markdown，卡片自己列来源。让模型写链接只会诱发凭记忆拼 URL。
 */
test('两个动作的 system 都写明「先联网核对」，且都不要求模型写链接', () => {
  for (const action of ['translate', 'explain'] as const) {
    const content = systemContent(action, {text: 'hi'})
    assert.ok(content.includes('联网搜索'), `${action}: ${content}`)
    assert.ok(!content.includes('链接'), `${action}: ${content}`)
  }
  // 「不要编造」是解释那条的硬边界（翻译只有「拿不准先核对」）。
  assert.ok(systemContent('explain', {text: 'hi'}).includes('不要编造'))
})

/**
 * 联网判据的尺度调过两次，这条测试锁住最后那个平衡点。
 *
 * - 太宽（「遇到术语定义就先核对」）：解释的对象几乎总是术语或概念，于是连常识词义都先搜一遍，
 *   白烧钱、多等一段首 token。
 * - 太窄（只看「会随时间变化的事实」）：模型遇到不认识的**作品名、人名、碎片标题**时会判定
 *   「这不是时效性事实」而直接靠上下文猜，交出一篇「信息不足无法确认」的空话。
 *
 * 现在按**有没有具体对象**分：不认识的具体对象必须搜，常识性的词义与断句可以不搜；
 * 并且不许用猜测或「无法确认」代替答案。
 */
test('解释的联网判据：不认识的具体对象必须搜，常识可答的不搜', () => {
  const content = systemContent('explain', {text: 'hi'})
  assert.ok(!content.includes('术语定义'), content)
  assert.ok(content.includes('不认识的具体对象'), content)
  assert.ok(content.includes('作品、人物、机构'), content)
  assert.ok(content.includes('联网搜索核实'), content)
  assert.ok(content.includes('不要靠上下文硬猜'), content)
  // 豁免面只留语言层面的常识。
  assert.ok(content.includes('常识性的词义、语法与断句'), content)
  // 不许以免责代替答案。
  assert.ok(content.includes('无法确认') && content.includes('不以猜测或'), content)
})

/** 残句 / 碎片是真实输入（片单里的截断标题、被换行劈开的句子），模板要专门交代。 */
test('解释的模板交代了残句怎么处理', () => {
  const content = userContent('explain', {text: '用锅子挡子弹的同时'})
  assert.ok(content.includes('残句或片段'), content)
  assert.ok(content.includes('先弄清它出自哪里'), content)
})

/**
 * 上下文是**顺序拼贴**，不是连贯文章：DOM 遍历时每个文本节点算一块、块间只补一个换行，
 * 图片/按钮这类元素直接跳过；网格排版会混进并排卡片；远端还会被字节预算从中间截断。
 *
 * 不写清这一点，模型会把前后两行当成同一条目，推出「它夹在 A 和 B 之间」「它原本紧接在
 * 上一句之后」这种根本不成立的结论。两个模板都要交代，且措辞只讲事实、不举例。
 */
test('两个模板都说明上下文是硬拼的、不一定连贯', () => {
  for (const action of ['translate', 'explain'] as const) {
    const content = userContent(action, {text: '甲', context: '乙\n丙'})
    assert.ok(content.includes('硬拼'), `${action}: ${content}`)
    assert.ok(content.includes('不一定连贯'), `${action}: ${content}`)
    assert.ok(content.includes('可能被截断'), `${action}: ${content}`)
  }
})

test('自定义 system 原样保留，空值与脏值退回默认', () => {
  const custom = '你是一位古文献专家，解释时先给出训诂依据。'
  assert.equal(normalizeSystemPrompt('explain', custom), custom)
  for (const raw of ['   ', '', undefined, null, 7]) {
    assert.equal(normalizeSystemPrompt('explain', raw), defaultSystem('explain'), String(raw))
  }
})

test('system 里的占位符也照常填充（只在模板里用得上，但不应被静默忽略）', () => {
  const content = systemContent('translate', {
    text: '甲',
    language: 'ja',
    system: '把内容译成{{lang}}，原文是 {{text}}。'
  })
  assert.equal(content, '把内容译成日语，原文是 甲。')
})

test('没有上下文时 <context> 标签就空着发出去（代码不配对、不清理）', () => {
  const content = userContent('explain', {text: '甲'})
  const lines = content.split('\n')
  // `{{context}}` 被换成空串，于是标签之间空一行；标签本身原样保留。
  assert.deepEqual(lines.slice(0, 3), ['<context>', '', '</context>'])
  assert.ok(!content.includes(PROMPT_CONTEXT_SLOT))
})

test('上下文正文只去首尾空白，正文内部的空行保留', () => {
  const content = userContent('explain', {text: '甲', context: '\n  第一段\n\n第二段  \n'})
  assert.ok(content.startsWith('<context>\n第一段\n\n第二段\n</context>'), content)
})

test('标签可以任意改名：拼装层只认占位符，不认标签', () => {
  const content = userContent('explain', {
    text: '甲',
    context: '前甲后',
    template: `<背景>${PROMPT_CONTEXT_SLOT}</背景>\n\n请解释 ${PROMPT_TEXT_SLOT}`
  })
  assert.equal(content, '<背景>前甲后</背景>\n\n请解释 甲')
})

test('语言代码映射到给模型看的名字，认不出来时退回默认', () => {
  assert.equal(languageName('ja'), '日语')
  assert.equal(languageName('zh-Hant'), '繁体中文')
  assert.equal(languageName('nope'), languageName(DEFAULT_AI_LANGUAGE))
})

test('原文两端的空白被清掉（选区常带换行）', () => {
  const content = userContent('explain', {text: '\n  甲  \n'})
  assert.ok(content.endsWith('\n<text>\n甲\n</text>'), JSON.stringify(content.slice(-20)))
})

/* 以下是用自定义模板的用例：模板可改写，但拼装规则必须稳定。 */

test('默认模板就是两个动作各自的那一份，且都带原文占位符', () => {
  assert.equal(defaultPrompt('translate'), DEFAULT_TRANSLATE_PROMPT)
  assert.equal(defaultPrompt('explain'), DEFAULT_EXPLAIN_PROMPT)
  for (const template of [DEFAULT_TRANSLATE_PROMPT, DEFAULT_EXPLAIN_PROMPT]) {
    assert.ok(template.includes(PROMPT_TEXT_SLOT))
  }
})

test('自定义模板：三个占位符都换成值，上下文块原样嵌入', () => {
  const content = userContent('translate', {
    text: '甲',
    language: 'ja',
    context: '前甲后',
    template: `[${PROMPT_LANG_SLOT}] (${PROMPT_TEXT_SLOT})\n${PROMPT_CONTEXT_SLOT}`
  })
  assert.ok(content.startsWith('[日语] (甲)'), content)
  assert.ok(content.includes('前甲后'))
})

test('自定义模板缺少 {{text}} 时退回默认（否则模型看不到原文）', () => {
  const content = userContent('explain', {text: '甲', template: '请解释一下'})
  assert.ok(content.includes('甲'))
  assert.ok(content.includes('请解释 <text> 标签里的内容'))
})

test('空模板 / 只有空白时用默认模板', () => {
  for (const template of ['', '   \n  ']) {
    assert.equal(
      userContent('explain', {text: '甲', template}),
      userContent('explain', {text: '甲'})
    )
  }
})

test('没有上下文时 {{context}} 变成空串，标签原样保留', () => {
  const content = userContent('explain', {text: '甲'})
  // 拼装只做 replaceAll，不替用户收拾空块：`{{context}}` 那行空着，标签照旧。
  assert.ok(!content.includes(PROMPT_CONTEXT_SLOT), content)
  assert.ok(content.startsWith('<context>\n\n</context>'), JSON.stringify(content.slice(0, 30)))
})

test('占位符夹在句子里时，没有上下文只删掉占位符本身', () => {
  const content = userContent('explain', {
    text: '甲',
    template: `背景：${PROMPT_CONTEXT_SLOT}请解释 ${PROMPT_TEXT_SLOT}`
  })
  assert.equal(content, '背景：请解释 甲')
})

test('原文里恰好写着占位符字样时不会被二次替换', () => {
  // 替换顺序是「语言 → 原文 → 上下文」：后插入的内容不再被扫描。
  const content = userContent('explain', {
    text: `这里写 ${PROMPT_LANG_SLOT} 是字面量`,
    template: `${PROMPT_TEXT_SLOT} / ${PROMPT_LANG_SLOT}`
  })
  assert.equal(content, `这里写 ${PROMPT_LANG_SLOT} 是字面量 / 英语`)
})

test('原文里的 $ 序列原样保留（替换值不能被当成替换模式解析）', () => {
  // `replace` / `replaceAll` 传**字符串**替换值时会解释 `$&`、`$'`、
  // 以及「美元符 + 反引号」「$$」，而原文与网页上下文都是不可信内容。
  // 所以填槽用 `replaceAll(slot, () => value)`——函数返回值不解析替换模式。
  for (const text of ['价格 $& 元', "撇号 $' 尾", '字面 $$ 符', 'const $$ = (s) => s']) {
    const content = userContent('explain', {text, template: `[${PROMPT_TEXT_SLOT}]`})
    assert.equal(content, `[${text}]`)
  }
})

test('模板归一化：统一成 \\n、去掉首尾空白', () => {
  const value = normalizePromptTemplate('explain', `\r\n  ${PROMPT_TEXT_SLOT} 请解释\r\n`)
  assert.equal(value, `${PROMPT_TEXT_SLOT} 请解释`)
})

test('模板归一化：非字符串 / 空白 / 缺原文占位符都退回该动作的默认模板', () => {
  for (const raw of [null, undefined, 42, {}, [], '', '   ', '请解释这段文字']) {
    assert.equal(normalizePromptTemplate('translate', raw), DEFAULT_TRANSLATE_PROMPT, String(raw))
  }
  // 两个动作的默认值不通用。
  assert.equal(normalizePromptTemplate('explain', '坏值'), DEFAULT_EXPLAIN_PROMPT)
})

test('模板归一化：超长截断到上限（截断后仍要有原文占位符）', () => {
  const long = normalizePromptTemplate('explain', `${PROMPT_TEXT_SLOT}${'x'.repeat(3000)}`)
  assert.equal(long.length, MAX_PROMPT_LENGTH)

  // 占位符被截掉时退回默认，而不是留一段模型看不到原文的模板。
  const broken = normalizePromptTemplate('explain', `${'x'.repeat(3000)}${PROMPT_TEXT_SLOT}`)
  assert.equal(broken, DEFAULT_EXPLAIN_PROMPT)
})
