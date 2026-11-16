/**
 * 设置的归一化与默认值。
 *
 * 关键约定：**地址与模型不进设置**。扩展只支持 DeepSeek 官方接口（翻译/解释要用它的
 * 服务端联网工具），这两项固定在 `shared/ai.ts` 里，用户改不了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_LANGUAGE,
  DEFAULT_AI_LANGUAGE,
  defaultPrompt,
  defaultSystem,
  PROMPT_TEXT_SLOT
} from './prompt'
import {effectivePrompt, effectiveSystem, normalizeSettings, sameSettings, withPromptMode} from './settings'
import {DEFAULT_SETTINGS, type Settings} from './types'

test('默认设置里没有地址与模型：它们固定在代码里', () => {
  assert.equal('aiBaseUrl' in DEFAULT_SETTINGS, false)
  assert.equal('aiModel' in DEFAULT_SETTINGS, false)
})

test('缺字段的设置补成默认值', () => {
  const value = normalizeSettings({})
  assert.equal(value.translateLang, DEFAULT_AI_LANGUAGE)
  assert.equal(value.aiThinking, false)
})

test('默认目标语言就是「自动」', () => {
  // 写死 'zh' 会与这里不一致——默认值只允许有 `DEFAULT_AI_LANGUAGE` 这一处定义。
  assert.equal(DEFAULT_SETTINGS.translateLang, AUTO_LANGUAGE)
  assert.equal(normalizeSettings({}).translateLang, AUTO_LANGUAGE)
  assert.equal(normalizeSettings({translateLang: 'ja'}).translateLang, 'ja')
})

test('认识不了的语言代码退回默认（自动），而不是某个具体语言', () => {
  for (const raw of ['', 'klingon', null, undefined, 7]) {
    assert.equal(normalizeSettings({translateLang: raw}).translateLang, AUTO_LANGUAGE, String(raw))
  }
})

test('自定义文案：合法值保留，缺原文占位符的存成空串（不退回默认）', () => {
  const custom = `自定义 ${PROMPT_TEXT_SLOT}`
  const value = normalizeSettings({aiPromptTranslate: custom, aiPromptExplain: '没有占位符'})
  assert.equal(value.aiPromptTranslate, custom)
  // 退回默认会让「模式」与「文案」两件事混在一起：默认态该由 `aiPromptMode` 表达。
  assert.equal(value.aiPromptExplain, '')
  // 缺字段同样存空串（= 没写过），而不是把内置文案刻进设置。
  assert.equal(normalizeSettings({}).aiPromptTranslate, '')
  assert.equal(DEFAULT_SETTINGS.aiPromptTranslate, '')
})

test('模式：认识的保留，缺字段与脏值一律「默认」', () => {
  const modes = {translate: {system: 'custom', user: 'default'}, explain: {system: 'bogus', user: null}}
  const value = normalizeSettings({aiPromptMode: modes})
  assert.equal(value.aiPromptMode.translate.system, 'custom')
  assert.equal(value.aiPromptMode.translate.user, 'default')
  assert.equal(value.aiPromptMode.explain.system, 'default')
  assert.equal(value.aiPromptMode.explain.user, 'default')
  assert.deepEqual(normalizeSettings({}).aiPromptMode, DEFAULT_SETTINGS.aiPromptMode)
})

/**
 * 只存了文案、没存模式时，文案**不丢**但也不自动生效。
 *
 * 刻意不用「文案是否等于默认」推断模式：内置默认一改，那个办法就把从没自定义过的人
 * 认成「自定义」，锁在旧文案上。模式显式存，文案原样保留，切到自定义就能看到。
 */
test('只存了文案没存模式：文案保留、模式按默认', () => {
  const partial = {aiSystemExplain: '手写的人设', aiPromptExplain: `手写模板 ${PROMPT_TEXT_SLOT}`}
  const value = normalizeSettings(partial)
  assert.equal(value.aiSystemExplain, '手写的人设')
  assert.equal(value.aiPromptExplain, `手写模板 ${PROMPT_TEXT_SLOT}`)
  assert.equal(value.aiPromptMode.explain.system, 'default')
  assert.equal(effectiveSystem(value, 'explain'), defaultSystem('explain'))
})

test('effective*：模式决定用内置默认还是自定义', () => {
  const customSystem = '自定义人设'
  const customPrompt = `自定义模板 ${PROMPT_TEXT_SLOT}`
  const custom = normalizeSettings({
    aiSystemExplain: customSystem,
    aiPromptExplain: customPrompt,
    aiPromptMode: {explain: {system: 'custom', user: 'custom'}}
  })
  assert.equal(effectiveSystem(custom, 'explain'), customSystem)
  assert.equal(effectivePrompt(custom, 'explain'), customPrompt)

  // 模式是默认时，即使存着自定义文案也不用它（改内置文案会自动跟上）。
  const fallback = normalizeSettings({aiSystemExplain: customSystem, aiPromptExplain: customPrompt})
  assert.equal(effectiveSystem(fallback, 'explain'), defaultSystem('explain'))
  assert.equal(effectivePrompt(fallback, 'explain'), defaultPrompt('explain'))
})

test('effective*：模式是自定义但文案为空时退回默认（不发空提示词）', () => {
  const value = normalizeSettings({aiPromptMode: {translate: {system: 'custom', user: 'custom'}}})
  assert.equal(effectiveSystem(value, 'translate'), defaultSystem('translate'))
  assert.equal(effectivePrompt(value, 'translate'), defaultPrompt('translate'))
})

test('withPromptMode 只改一个槽，不动其它字段与文案', () => {
  const base = normalizeSettings({aiSystemExplain: '人设'})
  const next = withPromptMode(base, 'explain', 'system', 'custom')
  assert.equal(next.aiPromptMode.explain.system, 'custom')
  assert.equal(next.aiPromptMode.explain.user, 'default')
  assert.equal(next.aiSystemExplain, '人设')
  // 返回新对象，调用方手里的旧值不被改动。
  assert.equal(base.aiPromptMode.explain.system, 'default')
})

test('sameSettings 认得出提示词差异', () => {
  const base: Settings = {...DEFAULT_SETTINGS}
  assert.equal(sameSettings({...base, aiPromptExplain: `x ${PROMPT_TEXT_SLOT}`}, base), false)
  assert.equal(sameSettings({...base, aiPromptExplain: undefined}, base), true)
  // 模式也是设置的一部分：只改模式同样算变过（否则一次切换不会镜像到同步区）。
  const custom = withPromptMode(base, 'translate', 'user', 'custom')
  assert.equal(sameSettings(custom, base), false)
  assert.equal(sameSettings(base, custom), false)
})

test('sameSettings 认得出设置差异', () => {
  const base: Settings = {...DEFAULT_SETTINGS}
  assert.equal(sameSettings(base, base), true)
  assert.equal(sameSettings({...base, aiThinking: true}, base), false)
  assert.equal(sameSettings({...base, translateLang: 'ja'}, base), false)
  assert.equal(sameSettings({...base, syncHighlights: true}, base), false)
  // 缺字段与显式默认值等价——否则每次同步都会白写一次。
  assert.equal(sameSettings({...base, aiThinking: undefined}, base), true)
})

test('不认识的设置字段保留在 extra 里，归一两次不套娃', () => {
  const value = normalizeSettings({penStyle: 2, futureFlag: true, futureNested: {a: 1}})
  assert.deepEqual(value.extra, {futureFlag: true, futureNested: {a: 1}})
  // 已经收在 extra 里的那份，再归一一次不能被收成 {extra: {...}}。
  assert.deepEqual(normalizeSettings(value).extra, {futureFlag: true, futureNested: {a: 1}})
  // 没有未知字段时不留空壳。
  assert.equal('extra' in normalizeSettings({penStyle: 2}), false)
})

test('sameSettings 比较未知字段：只差 extra 也算改过', () => {
  const plain = normalizeSettings({})
  const withFuture = normalizeSettings({futureFlag: true})
  assert.equal(sameSettings(withFuture, plain), false)
  assert.equal(sameSettings(plain, withFuture), false)
  // 同一份未知字段：键序不同不算改过（否则每次多一次无意义的镜像写）。
  assert.equal(sameSettings({futureA: 1, futureB: 2}, normalizeSettings({futureB: 2, futureA: 1})), true)
})
