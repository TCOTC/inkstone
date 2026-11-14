/**
 * 设置的归一化与默认值。
 *
 * 两条关键约定：
 *
 * 1. **地址与模型不进设置**。扩展只支持 DeepSeek 官方接口（翻译/解释要用它的服务端
 *    联网工具），这两项固定在 `shared/ai.ts` 里，用户改不了。
 * 2. **旧版本存下的 `aiBaseUrl` / `aiModel` 要被丢掉，但其它字段原样保留**——
 *    否则升级一次就等于把用户的画笔、目标语言与提示词全重置一遍。
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
  assert.equal(value.aiLang, DEFAULT_AI_LANGUAGE)
  assert.equal(value.aiThinking, false)
})

test('默认目标语言就是「自动」', () => {
  // 写死 'zh' 会与这里不一致——默认值只允许有 `DEFAULT_AI_LANGUAGE` 这一处定义。
  assert.equal(DEFAULT_SETTINGS.aiLang, AUTO_LANGUAGE)
  assert.equal(normalizeSettings({}).aiLang, AUTO_LANGUAGE)
  // 旧版本存下的具体语言不能被默认值顶掉。
  assert.equal(normalizeSettings({aiLang: 'ja'}).aiLang, 'ja')
})

test('认识不了的语言代码退回默认（自动），而不是某个具体语言', () => {
  for (const raw of ['', 'klingon', null, undefined, 7]) {
    assert.equal(normalizeSettings({aiLang: raw}).aiLang, AUTO_LANGUAGE, String(raw))
  }
})

test('旧版本落盘的地址与模型名被丢掉，其它字段原样保留', () => {
  // 模拟升级前落盘的那份设置：那时界面还能填自建网关。
  const legacy = {
    penStyle: 2,
    enabled: false,
    aiModel: 'my-gateway-model',
    aiBaseUrl: 'https://gw.test/v1',
    aiLang: 'ja'
  }
  const value = normalizeSettings(legacy)
  assert.equal(value.penStyle, 2, '其它字段不能被顺手改掉')
  assert.equal(value.enabled, false)
  assert.equal(value.aiLang, 'ja')
  assert.equal('aiModel' in value, false)
  assert.equal('aiBaseUrl' in value, false)
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
  const modes = {translate: {system: 'custom', prompt: 'default'}, explain: {system: 'bogus', prompt: null}}
  const value = normalizeSettings({aiPromptMode: modes})
  assert.equal(value.aiPromptMode.translate.system, 'custom')
  assert.equal(value.aiPromptMode.translate.prompt, 'default')
  assert.equal(value.aiPromptMode.explain.system, 'default')
  assert.equal(value.aiPromptMode.explain.prompt, 'default')
  // 旧版本没有这个字段：按「默认」处理，让内置文案能继续升级。
  assert.deepEqual(normalizeSettings({}).aiPromptMode, DEFAULT_SETTINGS.aiPromptMode)
})

/**
 * 旧数据里存的自定义文案**不丢**，但也不再自动生效——这是这次改动的核心取舍。
 *
 * 以前只能靠「文案是否等于默认」推断模式，那个办法在默认文案一改之后就失真：
 * 从没自定义过的人也被认成「自定义」，锁在旧文案上。现在模式显式存，旧数据只判一次。
 */
test('旧数据：文案保留、模式按默认，切到自定义即可恢复', () => {
  const legacy = {aiSystemExplain: '旧的自定义人设', aiPromptExplain: `旧模板 ${PROMPT_TEXT_SLOT}`}
  const value = normalizeSettings(legacy)
  assert.equal(value.aiSystemExplain, '旧的自定义人设')
  assert.equal(value.aiPromptExplain, `旧模板 ${PROMPT_TEXT_SLOT}`)
  assert.equal(value.aiPromptMode.explain.system, 'default')
  assert.equal(effectiveSystem(value, 'explain'), defaultSystem('explain'))
})

test('effective*：模式决定用内置默认还是自定义', () => {
  const customSystem = '自定义人设'
  const customPrompt = `自定义模板 ${PROMPT_TEXT_SLOT}`
  const custom = normalizeSettings({
    aiSystemExplain: customSystem,
    aiPromptExplain: customPrompt,
    aiPromptMode: {explain: {system: 'custom', prompt: 'custom'}}
  })
  assert.equal(effectiveSystem(custom, 'explain'), customSystem)
  assert.equal(effectivePrompt(custom, 'explain'), customPrompt)

  // 模式是默认时，即使存着自定义文案也不用它（改内置文案会自动跟上）。
  const fallback = normalizeSettings({aiSystemExplain: customSystem, aiPromptExplain: customPrompt})
  assert.equal(effectiveSystem(fallback, 'explain'), defaultSystem('explain'))
  assert.equal(effectivePrompt(fallback, 'explain'), defaultPrompt('explain'))
})

test('effective*：模式是自定义但文案为空时退回默认（不发空提示词）', () => {
  const value = normalizeSettings({aiPromptMode: {translate: {system: 'custom', prompt: 'custom'}}})
  assert.equal(effectiveSystem(value, 'translate'), defaultSystem('translate'))
  assert.equal(effectivePrompt(value, 'translate'), defaultPrompt('translate'))
})

test('withPromptMode 只改一个槽，不动其它字段与文案', () => {
  const base = normalizeSettings({aiSystemExplain: '人设'})
  const next = withPromptMode(base, 'explain', 'system', 'custom')
  assert.equal(next.aiPromptMode.explain.system, 'custom')
  assert.equal(next.aiPromptMode.explain.prompt, 'default')
  assert.equal(next.aiSystemExplain, '人设')
  // 返回新对象，调用方手里的旧值不被改动。
  assert.equal(base.aiPromptMode.explain.system, 'default')
})

test('sameSettings 认得出提示词差异', () => {
  const base: Settings = {...DEFAULT_SETTINGS}
  assert.equal(sameSettings({...base, aiPromptExplain: `x ${PROMPT_TEXT_SLOT}`}, base), false)
  assert.equal(sameSettings({...base, aiPromptExplain: undefined}, base), true)
  // 模式也是设置的一部分：只改模式同样算变过（否则一次切换不会镜像到同步区）。
  const custom = withPromptMode(base, 'translate', 'prompt', 'custom')
  assert.equal(sameSettings(custom, base), false)
  assert.equal(sameSettings(base, custom), false)
})

test('sameSettings 认得出设置差异，且忽略旧版本的地址与模型名', () => {
  const base: Settings = {...DEFAULT_SETTINGS}
  assert.equal(sameSettings(base, base), true)
  assert.equal(sameSettings({...base, aiThinking: true}, base), false)
  assert.equal(sameSettings({...base, aiLang: 'ja'}, base), false)
  assert.equal(sameSettings({...base, sync: true}, base), false)
  // 缺字段（旧备份）与显式默认值等价——否则每次同步都会白写一次。
  assert.equal(sameSettings({...base, aiThinking: undefined}, base), true)
  // 旧备份里多出来的地址与模型名在归一化时就被丢掉了，不该算成「改过设置」。
  assert.equal(sameSettings({...base, aiBaseUrl: 'https://gw.test', aiModel: 'x'}, base), true)
})
