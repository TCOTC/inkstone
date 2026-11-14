import assert from 'node:assert/strict'
import test from 'node:test'
import {foldSpaces, isTooShort, isWsCode, nbspToSpace, stripWs} from './whitespace'
import {stripAlpha, withAlpha} from './colors'

test('stripWs 删掉全部空白，包括 nbsp 与全角空格', () => {
  assert.equal(stripWs(' a\u00a0b\u3000c\n\t'), 'abc')
})

test('nbspToSpace 只把 nbsp 换成普通空格', () => {
  assert.equal(nbspToSpace('a\u00a0b\u3000c'), 'a b\u3000c')
})

test('foldSpaces 把连续空白折成一个空格，并把 img 占位串视为空', () => {
  assert.equal(foldSpaces('a \n\t b'), 'a b')
  assert.equal(foldSpaces('<img src="x.png">'), '')
})

test('isTooShort：去掉全部空白后不足 MIN_TEXT_LEN 算太短', () => {
  assert.equal(isTooShort('    '), true)
  assert.equal(isTooShort(''), true)
  // 中间只有空白的串在去空白坐标系里是空的，不能因为首尾 trim 后还有字符就放行。
  assert.equal(isTooShort('  \u00a0\n  '), true)
  assert.equal(isTooShort('  字  '), false)
  assert.equal(isTooShort('两个字'), false)
})

test('isWsCode 覆盖那套空白码点', () => {
  for (const code of [32, 9, 10, 13, 160, 0x3000, 0x2002, 0x2003]) {
    assert.equal(isWsCode(code), true, `code ${code}`)
  }
  assert.equal(isWsCode('a'.charCodeAt(0)), false)
})

test('stripAlpha 去掉 alpha 后缀，六位色原样返回', () => {
  assert.equal(stripAlpha('#FFFF83B2'), '#FFFF83')
  assert.equal(stripAlpha('#cc9933'), '#cc9933')
  assert.equal(withAlpha('#cc9933', '33'), '#cc993333')
})
