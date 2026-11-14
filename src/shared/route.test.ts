import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS_GROUP,
  LIBRARY_HASH,
  readHighlightAnchor,
  readSelectedPage,
  readSettingsGroup,
  selectedPageHash,
  settingsGroupHash,
  withHighlightAnchor
} from './route'

test('withHighlightAnchor：替换原有 hash，id 是十进制序号', () => {
  assert.equal(
    withHighlightAnchor('https://example.com/a#section', 12),
    'https://example.com/a#inkstone-hl=12'
  )
})

test('readHighlightAnchor：只认正整数，其余返回 null', () => {
  assert.equal(readHighlightAnchor('#inkstone-hl=12'), 12)
  assert.equal(readHighlightAnchor('#inkstone-hl=0'), null)
  assert.equal(readHighlightAnchor('#inkstone-hl=-3'), null)
  assert.equal(readHighlightAnchor('#inkstone-hl=0x10'), null)
  assert.equal(readHighlightAnchor('#inkstone-hl=3.5'), null)
  assert.equal(readHighlightAnchor('#inkstone-hl=abc'), null)
  assert.equal(readHighlightAnchor('#inkstone-hl='), null)
  assert.equal(readHighlightAnchor('#note=1'), null)
  assert.equal(readHighlightAnchor(''), null)
})

test('readSelectedPage / selectedPageHash：来回一致，且都带视图前缀', () => {
  const url = 'https://zh.javascript.info/tutorial/map'
  assert.equal(readSelectedPage(selectedPageHash(url)), url)
  assert.equal(readSelectedPage('#library'), null)
  assert.equal(readSelectedPage('#library/'), null)
  assert.equal(readSelectedPage('#inkstone-hl=x'), null)
})

test('selectedPageHash：URL 被编码，不会因为 # 或 ? 破坏 hash 结构', () => {
  const hash = selectedPageHash('https://a.com/x?b=1')
  assert.equal(hash, '#library/https%3A%2F%2Fa.com%2Fx%3Fb%3D1')
  assert.equal(hash.includes('?'), false)
  assert.equal(readSelectedPage(hash), 'https://a.com/x?b=1')
})

test('readSettingsGroup / settingsGroupHash：三组来回一致', () => {
  for (const group of ['highlight', 'ai', 'data'] as const) {
    assert.equal(readSettingsGroup(settingsGroupHash(group)), group)
  }
})

test('readSettingsGroup：空 hash 与认不出的分组都落回默认组', () => {
  assert.equal(readSettingsGroup(''), DEFAULT_SETTINGS_GROUP)
  assert.equal(readSettingsGroup('#'), DEFAULT_SETTINGS_GROUP)
  assert.equal(readSettingsGroup('#settings'), DEFAULT_SETTINGS_GROUP)
  assert.equal(readSettingsGroup('#settings/'), DEFAULT_SETTINGS_GROUP)
  assert.equal(readSettingsGroup('#settings/AI'), DEFAULT_SETTINGS_GROUP)
  assert.equal(readSettingsGroup('#settings/ai/extra'), DEFAULT_SETTINGS_GROUP)
  assert.equal(readSettingsGroup(LIBRARY_HASH), DEFAULT_SETTINGS_GROUP)
})
