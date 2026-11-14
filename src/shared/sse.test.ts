/**
 * SSE 解析的边界用例。每条对上一个具体的坑，不是覆盖率凑数。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {createSseDecoder, createSseParser} from './sse'

test('一条 data + 空行派发一条', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: {"a":1}\n\n'), ['{"a":1}'])
})

test('跨块被切开的半行留到下一块再拼', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: {"a"'), [])
  assert.deepEqual(parser.feed(':1}\n\n'), ['{"a":1}'])
})

test('跨块被切开的多字节字符不会变成 U+FFFD', () => {
  const decoder = createSseDecoder()
  const parser = createSseParser()
  const bytes = new TextEncoder().encode('data: 你好\n\n')
  const out: string[] = []
  // 逐字节喂：每个中文字符都会被切开两次。
  for (const byte of bytes) out.push(...parser.feed(decoder.push(new Uint8Array([byte]))))
  out.push(...parser.feed(decoder.flush()))

  assert.deepEqual(out, ['你好'])
})

test('多行 data 用换行拼成一条事件，而不是并列多条', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: a\ndata: b\n\n'), ['a\nb'])
})

test('CRLF 与裸 CR 都是合法行尾', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: a\r\n\r\n'), ['a'])
  // 裸 CR：末尾那个 CR 当场就是终止符，不能留到下一块（否则流到这里结束会丢事件）。
  assert.deepEqual(parser.feed('data: b\r\r'), ['b'])
})

test('块末尾的 \\r 是终止符，下一块开头的 \\n 属于同一个换行', () => {
  const parser = createSseParser()
  // 切在 \r\n 之间：`\n` 必须被吞掉，否则会被误认成空行，凭空派发一条事件。
  assert.deepEqual(parser.feed('data: a\r'), [])
  assert.deepEqual(parser.feed('\n'), [])
  assert.deepEqual(parser.feed('\n'), ['a'])
  assert.deepEqual(parser.feed('data: b\n\n'), ['b'])
})

test('注释行（心跳）不影响事件累积', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed(': ping\n\ndata: x\n\n'), ['x'])
  assert.deepEqual(parser.feed('data: a\n: keep-alive\ndata: b\n\n'), ['a\nb'])
})

test('一块里有多条事件时全部返回', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: 1\n\ndata: 2\n\ndata: 3\n\n'), ['1', '2', '3'])
})

test('没有 data 的空行不派发', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('\n\n\n'), [])
})

test('data 空值派发空串（不是不派发）', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data:\n\n'), [''])
  assert.deepEqual(parser.feed('data\n\n'), [''])
})

test('冒号后只吃一个前导空格', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data:  x\n\n'), [' x'])
  assert.deepEqual(parser.feed('data:x\n\n'), ['x'])
})

test('event / id / retry / 未知字段一律忽略', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('event: message\nid: 7\nretry: 100\nfoo: bar\n\ndata: x\n\n'), ['x'])
})

test('[DONE] 原样返回，交给调用方判断（不是 JSON）', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: [DONE]\n\n'), ['[DONE]'])
})

test('结尾没有空行的事件不派发', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: x\n'), [])
  assert.deepEqual(parser.feed(''), [])
})

test('流开头的 BOM 被剥掉', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('\uFEFFdata: x\n\n'), ['x'])
})

test('reset 丢弃半行和未派发的 data', () => {
  const parser = createSseParser()
  parser.feed('data: a\n')
  parser.reset()
  assert.deepEqual(parser.feed('\n'), [])
  assert.deepEqual(parser.feed('data: b\n\n'), ['b'])
})

test('单条事件超限被丢弃，下一个空行后恢复', () => {
  const parser = createSseParser({maxBufferSize: 16})
  assert.deepEqual(parser.feed(`data: ${'x'.repeat(32)}\n\n`), [])
  // 丢弃态持续到空行结束，紧接着的正常事件照常派发。
  assert.deepEqual(parser.feed('data: ok\n\n'), ['ok'])
})

test('没有终止符的超长半行被丢弃，之后的流仍能解析', () => {
  const parser = createSseParser({maxBufferSize: 16})
  assert.deepEqual(parser.feed('data: ' + 'x'.repeat(40)), [])
  // 半行已被丢弃，剩下的尾巴凑成一条非法行 → 忽略；空行结束丢弃态。
  assert.deepEqual(parser.feed('tail\n\ndata: ok\n\n'), ['ok'])
})
