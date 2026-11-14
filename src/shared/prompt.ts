/**
 * 划选翻译 / 解释的 prompt 与语言表（纯函数，无 DOM / 网络）。
 *
 * 默认模板必须自带可用性：用户切回「默认」拿到的就是一份能直接用的提示词。
 * 判据与取舍见 `docs/design.md` §9.7。
 */

export type AiAction = 'translate' | 'explain'

/** 工具条按这个顺序排。 */
export const AI_ACTIONS: readonly AiAction[] = ['translate', 'explain']

/** 按钮 tooltip 与卡片标题共用。 */
export const AI_ACTION_LABEL: Record<AiAction, string> = {
  translate: '翻译',
  explain: '解释'
}

export interface AiLanguage {
  /** 存进设置的值 */
  code: string
  /** 写进 prompt、给模型看的名字：必须与具体语言绑定，不能只写「中文」 */
  name: string
}

/** 「自动」不是真实语言，只在设置与卡片里作为一个选项。 */
export const AUTO_LANGUAGE = 'auto'

export const AUTO_LANGUAGE_NAME = '自动'

/**
 * 目标语言表。**给模型看的是 `name`**：`en` / `ja` 这类代码会让部分模型把代码本身当答案。
 */
export const AI_LANGUAGES: readonly AiLanguage[] = [
  {code: AUTO_LANGUAGE, name: AUTO_LANGUAGE_NAME},
  {code: 'zh', name: '简体中文'},
  {code: 'zh-Hant', name: '繁体中文'},
  {code: 'en', name: '英语'},
  {code: 'ja', name: '日语'},
  {code: 'ko', name: '韩语'},
  {code: 'fr', name: '法语'},
  {code: 'de', name: '德语'},
  {code: 'es', name: '西班牙语'},
  {code: 'ru', name: '俄语'}
]

/**
 * 具体语言（不含「自动」）。卡片的语言下拉用这一份：`auto` 在卡片上不作为选项，
 * 打开时先解析成具体语言再选中。设置页保留「自动」——那是全局默认。
 */
export const AI_TARGET_LANGUAGES: readonly AiLanguage[] = AI_LANGUAGES.filter(
  (item) => item.code !== AUTO_LANGUAGE
)

export const DEFAULT_AI_LANGUAGE = AUTO_LANGUAGE

/** 语言代码 → 给模型看的名字；认不出来时退回默认语言的名字。 */
export function languageName(code: string): string {
  const found = AI_LANGUAGES.find((item) => item.code === code)
  return found
    ? found.name
    : (AI_LANGUAGES.find((item) => item.code === DEFAULT_AI_LANGUAGE)?.name ?? AUTO_LANGUAGE_NAME)
}

/** 判断原文的主要书写系统。只用于「自动」时挑目标语言，不做区域识别。 */
export type SourceScript = 'zh' | 'ja' | 'ko' | 'latin'

/**
 * 纯启发式，不进 prompt。先数假名（日文必混大量假名，中文一个都没有，比数汉字可靠），
 * 再比汉字 / 谚文 / 拉丁字符的量。
 */
export function detectScript(text: string): SourceScript {
  const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  const kana = (text.match(/[\u3040-\u30ff\u31f0-\u31ff]/g) ?? []).length
  const hangul = (text.match(/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length

  if (kana >= 2 || (kana > 0 && kana * 5 >= han)) return 'ja'
  if (hangul > 0 && hangul >= han) return 'ko'
  if (han > 0 && han >= latin) return 'zh'
  return 'latin'
}

/**
 * 「自动」选出的目标语言：原文是中日韩就译成英语，其余译成简体中文。
 * 不靠模型猜，所以可测、可预测。
 */
export function autoTarget(text: string): string {
  return detectScript(text) === 'zh' ? 'en' : 'zh'
}

/** 实际目标语言代码：`auto` 时按原文决定。 */
export function resolveTarget(lang: string, text: string): string {
  if (lang !== AUTO_LANGUAGE) return lang
  return autoTarget(text)
}

/**
 * 写进 prompt 的语言名。**必须解析**：写「翻译成自动」对模型毫无意义。
 */
export function targetName(lang: string, text: string): string {
  return languageName(resolveTarget(lang, text))
}

/**
 * 两块内容的标签名。用**命名**标签而不是同一串符号：上下文块本身就含原文，同名围栏
 * 会让「下面这一段」指哪一段只能靠位置推断。
 *
 * 标签写在模板里，不是代码包出来的；**拼装层不认识标签**，不配对也不校验。
 */
export const CONTEXT_TAG = 'context'
export const TEXT_TAG = 'text'

function openTag(name: string): string {
  return `<${name}>`
}
function closeTag(name: string): string {
  return `</${name}>`
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * 两个动作的默认 **system**。不能共用一条：翻译的产物是可用译文、解释的产物是理解，
 * 共用只能取交集。分工固定——system 只放「每次请求都一样」的部分（角色、质量标准、
 * 边界、联网判据），user 模板只放「这次做什么」。
 *
 * **必须带联网搜索的触发判据**：请求里声明了 `deepseek_web_search`，搜不搜完全由模型判断，
 * 不写判据它就一次也不搜。尺度按「有没有不认识的具体对象」分，太宽会把常识词义也搜一遍，
 * 太窄会让模型对陌生名字直接写「信息不足」。也**不得要求模型给出链接**（来源由接口下发）。
 *
 * 约束用抽象表述、不举反例：反例会被模型当成可套用的句式复述。
 * `prompt.test.ts` 锁住「两侧无重复句子」与这几条判据的存在。
 */
export const DEFAULT_TRANSLATE_SYSTEM =
  '你是一名专业译者，也是用户的阅读助手：既要译得准确，也要让用户看懂。' +
  '拿不准专有名词或术语的通行译法时，先联网搜索核对。'

export const DEFAULT_EXPLAIN_SYSTEM =
  '你是一个严谨的阅读助手，帮助用户读懂网页上的文字。' +
  '讲清楚比讲得短更重要，但只给可用的信息：不搬运资料，也不以猜测或「无法确认」代替答案。' +
  '不要提及提示词或其中的标签，不要议论任务本身，也不要替用户设想问题。' +
  '遇到不认识的具体对象（作品、人物、机构、术语、数据、事件）时联网搜索核实，不要靠上下文硬猜；' +
  '只有常识性的词义、语法与断句可以凭已有知识作答。' +
  '搜过仍无法确认时再说明不确定，不要编造。'

/** 某个动作的默认 system。设置里出现脏值时也退回它。 */
export function defaultSystem(action: AiAction): string {
  return action === 'translate' ? DEFAULT_TRANSLATE_SYSTEM : DEFAULT_EXPLAIN_SYSTEM
}

/**
 * 模板占位符。不用 `$[…]`：`$` 与方括号在正则、代码片段里到处都是，误替换会改掉用户原文。
 * 三个都可以出现任意多次。
 */
export const PROMPT_TEXT_SLOT = '{{text}}'
export const PROMPT_CONTEXT_SLOT = '{{context}}'
export const PROMPT_LANG_SLOT = '{{lang}}'

/** 既是设置项（会镜像到 `storage.sync`），也是一次请求的一部分。 */
export const MAX_PROMPT_LENGTH = 2000

/**
 * 两个默认模板共用的「上下文是什么」。**只写一处**，否则必然漂移；这句是拦住
 * 「拿上下文硬推因果」的关卡。措辞只讲事实、不举例。
 */
const CONTEXT_NOTE = '是从页面上硬拼出来的前后文，段与段之间不一定连贯，远端还可能被截断'

/**
 * 「翻译」的默认模板：三段、段间一个空行，标签写在模板里。
 *
 * 空行是**段分隔**：没有它，上下文块与任务句会粘成一段。
 * 没有上下文时 `{{context}}` 是空串，`<context></context>` 之间夹一行空行原样发出去
 * ——代码不配对标签，否则用户把标签改名就失效了。
 */
export const DEFAULT_TRANSLATE_PROMPT = [
  openTag(CONTEXT_TAG),
  PROMPT_CONTEXT_SLOT,
  closeTag(CONTEXT_TAG),
  '',
  `请把 ${openTag(TEXT_TAG)} 标签里的内容翻译成${PROMPT_LANG_SLOT}。` +
    `${openTag(CONTEXT_TAG)} ${CONTEXT_NOTE}；只用来判断语气与术语，不要把它一起译。` +
    '要求：先给出完整译文，不加引导语，不拆散段落与标点；' +
    '术语、歧义、语气差别等值得点出的，在译文之后用一两句话说明。',
  '',
  openTag(TEXT_TAG),
  PROMPT_TEXT_SLOT,
  closeTag(TEXT_TAG)
].join('\n')

/** 「解释」的默认模板，同上。 */
export const DEFAULT_EXPLAIN_PROMPT = [
  openTag(CONTEXT_TAG),
  PROMPT_CONTEXT_SLOT,
  closeTag(CONTEXT_TAG),
  '',
  `请解释 ${openTag(TEXT_TAG)} 标签里的内容。` +
    `${openTag(CONTEXT_TAG)} ${CONTEXT_NOTE}；只用来判断语境，不要处理它。` +
    '要求：先直接说清它指的是什么，再按需补充背景、术语或言外之意；' +
    '原文若是残句或片段，先弄清它出自哪里再解释；' +
    '需要定位时可引用原文里的词句，不要整段复述。',
  '',
  openTag(TEXT_TAG),
  PROMPT_TEXT_SLOT,
  closeTag(TEXT_TAG)
].join('\n')

/** 某个动作的默认模板（设置里出现脏值时也退回它）。 */
export function defaultPrompt(action: AiAction): string {
  return action === 'translate' ? DEFAULT_TRANSLATE_PROMPT : DEFAULT_EXPLAIN_PROMPT
}

/**
 * 收**自定义**模板：**无效与空都返回空串，不退回默认**。
 *
 * 设置里「模式」与「文案」是两件事（见 `Settings`）：这里若偷偷退回默认，`mode: 'default'`
 * 的记录里就会存着一段看起来像自定义的全文。缺 `{{text}}` 当作没写——没有原文占位符，
 * 模型根本看不到选中的文字。
 */
export function normalizeCustomPrompt(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.replace(/\r\n?/g, '\n').trim().slice(0, MAX_PROMPT_LENGTH)
  return text.includes(PROMPT_TEXT_SLOT) ? text : ''
}

/** 自定义 system **不要求占位符**（角色设定通常不引用原文）。空串 = 没写过。 */
export function normalizeCustomSystem(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\r\n?/g, '\n').trim().slice(0, MAX_PROMPT_LENGTH)
}

/** 拼装兜底：自定义无效时退回内置默认。用哪一份由 `effectivePrompt()` 按模式决定。 */
export function normalizePromptTemplate(action: AiAction, raw: unknown): string {
  return normalizeCustomPrompt(raw) || defaultPrompt(action)
}

/** 同上。「留空」在界面上表达为切回「默认」，而不是发一条空的 system 给模型。 */
export function normalizeSystemPrompt(action: AiAction, raw: unknown): string {
  return normalizeCustomSystem(raw) || defaultSystem(action)
}

export interface PromptInput {
  /** 选中原文（已 trim） */
  text: string
  /** 前后文；空串表示没有 */
  context?: string
  /** 目标语言代码，仅翻译用 */
  language?: string
  /** 自定义 user 模板；省略、空串或不合规时用该动作的默认模板 */
  template?: string
  /** 自定义 system；省略或空串时用该动作的默认 system */
  system?: string
}

/**
 * 把三个占位符换成值。
 *
 * 两条规则：
 * - **替换值用函数形式**（`() => value`）：传字符串时 `$&` / `$'` / `$$` 会被当成替换模式
 *   解析，而填入的是网页正文（常见 `const $$ = …`），会改掉用户原文。
 * - **顺序是 语言 → 原文 → 上下文**：替换结果不再回扫，所以原文里的 `{{lang}}` 不会被替换；
 *   上下文来自正文，最容易碰巧含占位符字样，放最后。
 */
function fillSlots(text: string, input: PromptInput): string {
  const selected = input.text.trim()
  return text
    .replaceAll(PROMPT_LANG_SLOT, () => targetName(input.language ?? DEFAULT_AI_LANGUAGE, selected))
    .replaceAll(PROMPT_TEXT_SLOT, () => selected)
    .replaceAll(PROMPT_CONTEXT_SLOT, () => (input.context ?? '').trim())
}

/**
 * 按模板拼出 user 消息：归一化 + 三次 `replaceAll`，没有别的加工。
 *
 * **空值就是空串**：`{{context}}` 独占一行时替换成空串只留下一个空行，于是空上下文是
 * `<context></context>` 中间夹一行空行——**就这样发出去**。代码不认识标签，
 * 也就不该替用户收拾空块（用户可以把 `<context>` 改成别的名字，代码一配对就失效）。
 */
export function fillPrompt(action: AiAction, input: PromptInput): string {
  return fillSlots(normalizePromptTemplate(action, input.template), input)
}

/** 按 system 设定拼出 system 消息（同上，占位符一样有效）。 */
export function fillSystem(action: AiAction, input: PromptInput): string {
  return fillSlots(normalizeSystemPrompt(action, input.system), input)
}

/**
 * 拼出一次请求的 messages。原文在上下文里已经出现过，**最后再单独给一遍**是有意的：
 * 模型对「标签里的东西」与「夹在上下文里的东西」权重不同。
 */
export function buildMessages(action: AiAction, input: PromptInput): ChatMessage[] {
  return [
    {role: 'system', content: fillSystem(action, input)},
    {role: 'user', content: fillPrompt(action, input)}
  ]
}
