/**
 * 目标语言的「自动」逻辑。
 *
 * 这是纯函数，不靠模型猜——所以既能测，也能在卡片副标题上直接告诉用户
 * 「这一次到底会译成什么」。检测只分书写系统，不做区域识别。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_LANGUAGES,
  AI_TARGET_LANGUAGES,
  AUTO_LANGUAGE,
  AUTO_LANGUAGE_NAME,
  autoTarget,
  DEFAULT_AI_LANGUAGE,
  detectScript,
  languageName,
  resolveTarget,
  targetName
} from './prompt'

test('「自动」是默认目标语言，且排在语言表第一位', () => {
  assert.equal(DEFAULT_AI_LANGUAGE, AUTO_LANGUAGE)
  assert.equal(AI_LANGUAGES[0]?.code, AUTO_LANGUAGE)
  assert.equal(languageName(AUTO_LANGUAGE), AUTO_LANGUAGE_NAME)
})

test('具体语言表不含「自动」', () => {
  assert.ok(AI_TARGET_LANGUAGES.length > 0)
  assert.equal(
    AI_TARGET_LANGUAGES.some((item) => item.code === AUTO_LANGUAGE),
    false
  )
})

test('detectScript：中文 / 日文 / 韩文 / 拉丁', () => {
  assert.equal(detectScript('朝菌不知晦朔，蟪蛄不知春秋'), 'zh')
  assert.equal(detectScript('吾輩は猫である。名前はまだ無い'), 'ja')
  assert.equal(detectScript('안녕하세요 반갑습니다'), 'ko')
  assert.equal(detectScript('The quick brown fox'), 'latin')
})

test('日文优先判假名：汉字多也仍是日文', () => {
  // 汉字段落里夹少量假名——纯数汉字会误判成中文，所以先看假名。
  assert.equal(detectScript('日本語の文章です 漢字多め'), 'ja')
})

test('中文里一个大写字母都不影响结论', () => {
  assert.equal(detectScript('这段话包含 HTML 和 CSS 两个词'), 'zh')
})

test('纯数字 / 标点 / 空串归为拉丁（不猜）', () => {
  for (const text of ['', '12345', '!!!???', '🙂🙂']) {
    assert.equal(detectScript(text), 'latin', JSON.stringify(text))
  }
})

test('autoTarget：中文译成英语，其它译成简体中文', () => {
  assert.equal(autoTarget('朝菌不知晦朔'), 'en')
  assert.equal(autoTarget('吾輩は猫である'), 'zh')
  assert.equal(autoTarget('안녕하세요'), 'zh')
  assert.equal(autoTarget('hello world'), 'zh')
})

test('resolveTarget：显式语言原样返回，auto 才解析', () => {
  assert.equal(resolveTarget('ja', '随便什么文字'), 'ja')
  assert.equal(resolveTarget(AUTO_LANGUAGE, '中文原文'), 'en')
  assert.equal(resolveTarget(AUTO_LANGUAGE, 'english text'), 'zh')
})

test('targetName 给的是模型能看懂的语言名，不是代码', () => {
  assert.equal(targetName('ja', 'x'), '日语')
  assert.equal(targetName(AUTO_LANGUAGE, '中文'), '英语')
  assert.equal(targetName(AUTO_LANGUAGE, 'hello'), '简体中文')
  // prompt 里绝不能出现「自动」这三个字——那对模型没有意义。
  assert.notEqual(targetName(AUTO_LANGUAGE, '中文'), AUTO_LANGUAGE_NAME)
})
