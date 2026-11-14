/**
 * 请求层的用例：帧解析的边界（`[DONE]`、空 delta、错误帧、坏 JSON）与请求体形状。
 * 不测网络——`readStream` 需要 `Response`，留给手动验证。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_MODEL,
  AI_TIMEOUT_MS,
  CHAT_ENDPOINT,
  buildRequestBody,
  buildRequestInit,
  parseChunk
} from './ai'

test('[DONE] 先于 JSON 解析被识别', () => {
  assert.deepEqual(parseChunk('[DONE]'), {text: '', done: true})
})

test('普通增量帧取出 delta.content', () => {
  const chunk = parseChunk('{"choices":[{"delta":{"content":"你好"}}]}')
  assert.equal(chunk.text, '你好')
  assert.equal(chunk.done, false)
})

test('最后一帧只有 finish_reason：没有正文但要算结束', () => {
  const chunk = parseChunk('{"choices":[{"delta":{},"finish_reason":"stop"}]}')
  assert.equal(chunk.text, '')
  assert.equal(chunk.done, true)
})

test('usage 骑在 content 帧上也能取到（DeepSeek 不发独立 usage 帧）', () => {
  const chunk = parseChunk(
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":34}}'
  )
  // 没联网时 `server_tool_use` 整个字段不存在，计数按 0 算。
  assert.deepEqual(chunk.usage, {prompt: 12, completion: 34, searches: 0, fetches: 0})
})

test('usage.server_tool_use 的计费次数被读出来（这是「到底搜没搜」的唯一信号）', () => {
  const chunk = parseChunk(
    JSON.stringify({
      choices: [{delta: {}, finish_reason: 'stop'}],
      usage: {
        prompt_tokens: 9000,
        completion_tokens: 700,
        server_tool_use: {tool_search: 3, tool_fetch: 2, tool_image_search: 0}
      }
    })
  )
  assert.deepEqual(chunk.usage, {prompt: 9000, completion: 700, searches: 3, fetches: 2})
  // 搜了但没拿到引用：有计数、没有 sources——界面必须能把这两种情况分开。
  assert.equal('sources' in chunk, false)
})

test('server_tool_use 里的脏值不污染用量（负数、字符串都算 0）', () => {
  const chunk = parseChunk(
    JSON.stringify({
      choices: [{delta: {}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 1, completion_tokens: 2, server_tool_use: {tool_search: -1, tool_fetch: '2'}}
    })
  )
  assert.deepEqual(chunk.usage, {prompt: 1, completion: 2, searches: 0, fetches: 0})
})

test('choices 为空时既不崩也不当成结束', () => {
  const chunk = parseChunk('{"choices":[]}')
  assert.equal(chunk.text, '')
  assert.equal(chunk.done, false)
})

test('错误帧取出 error.message', () => {
  const chunk = parseChunk('{"error":{"message":"Insufficient Balance"}}')
  assert.equal(chunk.error, 'Insufficient Balance')
})

test('坏 JSON 与空帧都退回「这一帧没有正文」', () => {
  for (const raw of ['', '{', 'null', '[]', '{"choices":"x"}']) {
    const chunk = parseChunk(raw)
    assert.deepEqual(chunk, {text: '', done: false})
  }
})

test('endpoint 写死为 DeepSeek 官方接口', () => {
  assert.equal(CHAT_ENDPOINT, 'https://api.deepseek.com/chat/completions')
})

test('请求体：流式 + 关思考 + 要用量 + 声明联网搜索', () => {
  const body = buildRequestBody([{role: 'user', content: 'hi'}])
  assert.equal(body['stream'], true)
  assert.deepEqual(body['thinking'], {type: 'disabled'})
  assert.deepEqual(body['stream_options'], {include_usage: true})
  assert.equal(body['model'], 'deepseek-flash')
  // Chat Completions 的服务端工具**只有 type**（带 name 是 Messages API 的写法）。
  assert.deepEqual(body['tools'], [{type: 'deepseek_web_search'}])
})

test('模型固定在 deepseek-flash：联网工具只认它', () => {
  assert.equal(AI_MODEL, 'deepseek-flash')
  assert.equal(buildRequestBody([])['model'], AI_MODEL)
})

test('开启思考时不传 thinking 字段（让服务端按默认走）', () => {
  const body = buildRequestBody([{role: 'user', content: 'hi'}], true)
  // 关键是「不出现这个字段」，而不是「设成 enabled」——后者不是所有兼容网关都认。
  assert.equal('thinking' in body, false, JSON.stringify(body))
})

test('思考开关进不了请求体以外的地方，且默认是关', () => {
  const off = buildRequestBody([], false)
  const on = buildRequestBody([], true)
  assert.deepEqual(off['thinking'], {type: 'disabled'})
  assert.equal('thinking' in on, false)
})

test('引用来源从 delta.annotations 里取，重复 URL 只留一次', () => {
  const chunk = parseChunk(
    JSON.stringify({
      choices: [
        {
          delta: {
            annotations: [
              {
                type: 'url_citation',
                url_citation: {url: 'https://a.test/x', title: 'A', start_index: 0, end_index: 3}
              },
              {type: 'url_citation', url_citation: {url: 'https://a.test/x', title: '再来一次'}},
              {type: 'url_citation', url_citation: {url: 'https://b.test/y', title: null}}
            ]
          },
          finish_reason: 'stop'
        }
      ],
      usage: {prompt_tokens: 1, completion_tokens: 2}
    })
  )
  assert.equal(chunk.done, true)
  assert.deepEqual(chunk.sources, [
    {url: 'https://a.test/x', title: 'A'},
    // title 允许为 null，统一收成空串，由展示层退回主机名。
    {url: 'https://b.test/y', title: ''}
  ])
})

test('没有引用时不出现 sources 字段（不要让空数组混进 JSON）', () => {
  const chunk = parseChunk('{"choices":[{"delta":{"content":"x"}}]}')
  assert.equal('sources' in chunk, false)
})

test('请求头带 Bearer，方法固定 POST', () => {
  const init = buildRequestInit({
    apiKey: 'sk-test',
    messages: [{role: 'user', content: 'hi'}]
  })
  assert.equal(init.method, 'POST')
  const headers = init.headers as Record<string, string>
  assert.equal(headers['authorization'], 'Bearer sk-test')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(typeof init.body, 'string')
})

test('超时上限不超过服务端 5 分钟硬上限', () => {
  assert.ok(AI_TIMEOUT_MS > 30_000 && AI_TIMEOUT_MS < 300_000, String(AI_TIMEOUT_MS))
})
