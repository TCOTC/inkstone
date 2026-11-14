/**
 * AI 请求的协议层：请求体、单帧解析、流式读取。
 *
 * 只走 DeepSeek 官方接口（地址与模型写死，理由见 `docs/design.md` §9.3），不引 SDK。
 * 四处与文档对不上、必须显式处理的地方：`[DONE]` 不是 JSON；空 delta 帧是正常的；
 * 思考模式默认开启（默认关掉）；引用在最后一帧的 `delta.annotations` 里、正文没有角标。
 */
import {createSseDecoder, createSseParser} from './sse'
import type {ChatMessage} from './prompt'

/** DeepSeek 官方接口。**不可配**：联网工具是它的服务端能力。 */
const AI_ORIGIN = 'https://api.deepseek.com'

/** 联网工具只认这个模型。 */
export const AI_MODEL = 'deepseek-flash'

/** 服务端 5 分钟上限之前先自己收尾。 */
export const AI_TIMEOUT_MS = 120_000

/**
 * 服务端工具。形状只有 `{type}`（带 `name` 是 Messages API 的写法）。
 * **搜不搜由模型判断**：`tool_choice` 指定它直接 400，要关只能不声明。
 */
const WEB_TOOLS = [{type: 'deepseek_web_search'}] as const

/** 一条引用来源。`start_index` / `end_index` 用不上：正文里不插角标。 */
export interface AiSource {
  url: string
  /** 网页标题，可能为空串（服务端 `title` 允许为 null）。 */
  title: string
}

/**
 * `searches` / `fetches` 来自 `usage.server_tool_use`，是唯一可靠的「联没联网」信号：
 * 没搜时字段不存在；搜了没结果时字段在、但没有引用。
 */
export interface AiUsage {
  prompt: number
  completion: number
  /** 计费的联网搜索次数（不含图片搜索）。 */
  searches: number
  /** 计费的网页抓取次数（深度思考搜索里打开网页）。 */
  fetches: number
}

export interface AiRequestOptions {
  apiKey: string
  messages: ChatMessage[]
  /** 是否让模型先思考。默认 **false**：首 token 延迟会撞上 SW 的 30 秒空闲判定。 */
  thinking?: boolean
  signal?: AbortSignal
}

/** 唯一的 endpoint。 */
export const CHAT_ENDPOINT = `${AI_ORIGIN}/chat/completions`

/**
 * `thinking` 默认**开启**，划词场景下那是纯亏：首 token 从一两秒变成十几秒，
 * 正好压在 service worker 的 30 秒空闲判定上。
 */
export function buildRequestBody(messages: ChatMessage[], thinking = false): Record<string, unknown> {
  return {
    model: AI_MODEL,
    messages,
    stream: true,
    // 翻译与解释都按需联网：模型觉得需要才搜，搜过的回答会带引用。
    tools: WEB_TOOLS.map((tool) => ({...tool})),
    // 不要温度这类可调项：翻译/解释要的是稳定输出，默认值就够。
    ...(thinking ? {} : {thinking: {type: 'disabled'}}),
    stream_options: {include_usage: true}
  }
}

export function buildRequestInit(options: AiRequestOptions): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify(buildRequestBody(options.messages, options.thinking)),
    signal: options.signal
  }
}

/** 一帧 SSE `data` 解析出来的内容。 */
export interface ChunkResult {
  /** 新增正文（可能为空串） */
  text: string
  /** 流结束标记，见 `[DONE]` */
  done: boolean
  /** 服务端在帧里塞的错误（限流、鉴权失败等） */
  error?: string
  /** 最后一帧携带的用量 */
  usage?: AiUsage
  /** 联网搜索的引用来源。只在最后一帧、且模型确实搜过时出现。 */
  sources?: AiSource[]
}

/**
 * 从 `delta.annotations` 里挑出引用来源。
 *
 * 形状是 `[{type: 'url_citation', url_citation: {url, title, start_index, end_index}}]`。
 * 只认 `url` / `title`：正文里不插引用角标，所以那两个下标没有用处。
 * 同一 URL 只留第一次出现的（同一个块内同一 URL 最多出现一次，这里再兜一层）。
 */
function readSources(value: unknown): AiSource[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const sources: AiSource[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const citation = (item as Record<string, unknown>)['url_citation']
    if (!citation || typeof citation !== 'object') continue
    const record = citation as Record<string, unknown>
    const url = record['url']
    if (typeof url !== 'string' || url === '' || seen.has(url)) continue
    seen.add(url)
    const title = record['title']
    sources.push({url, title: typeof title === 'string' ? title : ''})
  }
  return sources
}

/** 计费的搜索与抓取次数。没联网时整个字段不存在，按 0 算。 */
function readServerTools(value: unknown): {searches: number; fetches: number} {
  if (!value || typeof value !== 'object') return {searches: 0, fetches: 0}
  const record = value as Record<string, unknown>
  const count = (key: string): number => {
    const raw = record[key]
    return typeof raw === 'number' && raw > 0 ? raw : 0
  }
  // `tool_search` 已排除图片搜索；`tool_image_search` 与本场景无关（没有图片输入）。
  return {searches: count('tool_search'), fetches: count('tool_fetch')}
}

const EMPTY_CHUNK: ChunkResult = {text: '', done: false}

/**
 * 解析一帧。**任何解析失败都只当作「这帧没有正文」**，不让整条流崩掉——
 * 网关插进来的错误帧、被截断的 JSON 都真实存在，为此丢掉已收到的内容不值。
 */
export function parseChunk(data: string): ChunkResult {
  if (data === '[DONE]') return {text: '', done: true}
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return EMPTY_CHUNK
  }
  if (!payload || typeof payload !== 'object') return EMPTY_CHUNK
  const record = payload as Record<string, unknown>

  const error = record['error']
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message']
    return {text: '', done: false, error: typeof message === 'string' ? message : 'AI 服务返回错误'}
  }

  const choices = record['choices']
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined
  const delta = first?.['delta'] as Record<string, unknown> | undefined
  const content = delta?.['content']
  const usage = record['usage'] as Record<string, unknown> | undefined
  // 流式时引用随最后一个 chunk 的 `delta` 下发；非流式则在 `message` 上。两种都认。
  const sources = readSources(delta?.['annotations'] ?? first?.['annotations'])

  const result: ChunkResult = {
    text: typeof content === 'string' ? content : '',
    // `finish_reason` 非空表示这一轮生成完了。**不要**用 `choices` 为空来判断：
    // DeepSeek 的 usage 骑在最后一个 content 帧上，不会单独发一个 `choices: []` 帧。
    done: typeof first?.['finish_reason'] === 'string' && first['finish_reason'] !== '',
    ...(usage
      ? {
          usage: {
            prompt: typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
            completion: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
            ...readServerTools(usage['server_tool_use'])
          }
        }
      : {}),
    ...(sources.length > 0 ? {sources} : {})
  }
  return result
}

export interface StreamHandlers {
  onDelta: (text: string) => void
  onUsage?: (usage: AiUsage) => void
  /** 引用来源，只在最后一帧触发一次。 */
  onSources?: (sources: AiSource[]) => void
}

/**
 * 把一条 SSE 响应读到底。
 *
 * 三件事都在这里做完：解码（贯穿全程的 `TextDecoder`）、切帧（`shared/sse.ts`）、
 * 分帧解析（`parseChunk`）。**调用方拿到的是增量文本、用量与引用**，不接触字节与行。
 *
 * 非 2xx 时尽量把服务端的错误说明读出来，而不是只报状态码。
 */
export async function readStream(response: Response, handlers: StreamHandlers): Promise<void> {
  if (!response.ok) {
    const detail = await readErrorBody(response)
    throw new Error(detail || `请求失败（HTTP ${response.status}）`)
  }
  const body = response.body
  if (!body) throw new Error('AI 服务没有返回内容')

  const reader = body.getReader()
  const decoder = createSseDecoder()
  const parser = createSseParser()

  const handle = (data: string): void => {
    const chunk = parseChunk(data)
    if (chunk.error) throw new Error(chunk.error)
    if (chunk.text) handlers.onDelta(chunk.text)
    if (chunk.usage) handlers.onUsage?.(chunk.usage)
    if (chunk.sources) handlers.onSources?.(chunk.sources)
  }

  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      for (const data of parser.feed(decoder.push(value))) handle(data)
    }
    // 流结束时冲掉解码器残留；最后半帧没有空行的按规范丢弃（`feed('')` 不派发）。
    const tail = decoder.flush()
    if (tail) for (const data of parser.feed(tail)) handle(data)
  } finally {
    reader.releaseLock()
  }
}

/** 把错误响应体收成一句人话。OpenAI 兼容的形态是 `{error:{message}}`。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const payload = JSON.parse(text) as Record<string, unknown>
      const error = payload['error']
      if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>)['message']
        if (typeof message === 'string' && message) return message
      }
      const message = payload['message']
      if (typeof message === 'string' && message) return message
    } catch {
      // 不是 JSON：直接回原文本（网关的 HTML 错误页也常这样）。
    }
    return text.slice(0, 300)
  } catch {
    return ''
  }
}
