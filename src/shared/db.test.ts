/**
 * 存储层的并发语义。
 *
 * 这两条是「丢数据」级别的问题，而它们只在「读与写之间有别人插进来」时才暴露，
 * 所以测试必须让 fake storage 的每次操作都真的异步等一会儿——同步实现的假 store
 * 会让竞态窗口消失，测试就永远是绿的。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {addHighlight, clearAll, deleteHighlight, getPageByUrl, importPages, listPages} from './db'
import {encodePage, pageStorageKey, type PageRow} from './rowCodec'
import {installStorage, type Store} from './storageFixture'
import type {HighlightRecord, PageRecord} from './types'

/** 假的 `chrome.storage.local`（见 `storageFixture.ts`）。每次操作都异步等一会儿。 */
function installChrome(store: Store, delay = 2): void {
  installStorage(store, delay)
}

function draft(text: string): Omit<HighlightRecord, 'id' | 'local'> {
  return {text, prev: '', next: '', createdAt: 1}
}

function page(url: string, highlights: HighlightRecord[]): PageRecord {
  return {url, title: '标题', createdAt: 1, highlights}
}

function row(highlights: HighlightRecord[]): PageRow {
  return encodePage(page('', highlights))
}

test('并发追加划线：两条都在，id 不重复', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/race'

  const [first, second] = await Promise.all([
    addHighlight(url, draft('第一条'), '标题'),
    addHighlight(url, draft('第二条'), '标题')
  ])

  const saved = (store.get(pageStorageKey(url)) as PageRow).h
  assert.equal(saved.length, 2)
  assert.equal(new Set(saved.map((item) => item.i)).size, 2)
  assert.deepEqual(
    [first.highlights.length, second.highlights.length].sort(),
    [1, 2]
  )
})

test('新划线的 id 从 1 开始，在已有最大序号之后继续', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/mixed'

  // 页面上已经有两条导入的线（序号 1、2）。
  store.set(
    pageStorageKey(url),
    row([
      {id: 1, text: '旧一', prev: '', next: '', createdAt: 0},
      {id: 2, text: '旧二', prev: '', next: '', createdAt: 0}
    ])
  )

  const page_ = await addHighlight(url, draft('新的'), '标题')
  assert.deepEqual(page_.highlights.map((item) => item.id), [1, 2, 3])
  assert.equal(page_.highlights[2]?.local, true)
  assert.equal(page_.highlights[0]?.local, undefined)
})

test('删掉序号最大那条后再划，复用那个序号（页内唯一即可）', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/reuse'

  const first = await addHighlight(url, draft('一'), '标题')
  await addHighlight(url, draft('二'), '标题')
  await deleteHighlight(url, first.highlights[0]!.id)

  const after = await addHighlight(url, draft('三'), '标题')
  assert.deepEqual(after.highlights.map((item) => item.id).sort((a, b) => a - b), [2, 3])
})

test('并发追加与删除交错时，删除的那条不会被并发的追加复活', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/mix'

  const seeded = await addHighlight(url, draft('要删掉的'), '标题')
  const id = seeded.highlights[0]!.id

  await Promise.all([deleteHighlight(url, id), addHighlight(url, draft('后来的'), '标题')])

  const saved = (store.get(pageStorageKey(url)) as PageRow).h
  assert.deepEqual(saved.map((item) => item.x), ['后来的'])
})

test('导入不覆盖并发新增的本地线', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/import'

  await Promise.all([
    addHighlight(url, draft('本地新划'), '标题'),
    importPages([page(url, [{id: 1, text: '导入的', prev: '', next: '', createdAt: 0}])])
  ])

  const saved = (store.get(pageStorageKey(url)) as PageRow).h
  assert.deepEqual(saved.map((item) => item.x).sort(), ['导入的', '本地新划'].sort())
})

test('写锁用完就释放，不在 storage 里留下垃圾', async () => {
  const store: Store = new Map()
  installChrome(store)
  await addHighlight('https://example.com/clean', draft('一条'), '标题')

  const leftovers = [...store.keys()].filter((key) => key.startsWith('lock:'))
  assert.deepEqual(leftovers, [])
})

test('同一页的两种 URL 写法（带 utm_ / 干净）抢同一把锁', async () => {
  const store: Store = new Map()
  installChrome(store)
  const clean = 'https://example.com/shared'
  const tagged = `${clean}?utm_source=weibo`

  // 先有一条记录，让带追踪参数的 URL 走回退匹配、落到干净链接那个键上。
  await addHighlight(clean, draft('原有'), '标题')

  await Promise.all([addHighlight(tagged, draft('来自分享链接'), '标题'), addHighlight(clean, draft('来自本站'), '标题')])

  const saved = (store.get(pageStorageKey(clean)) as PageRow).h
  // 按存储键抢锁时这里只会剩 2 条（后写的覆盖前者），按宽松键才会是 3 条。
  assert.equal(saved.length, 3)
  assert.equal(new Set(saved.map((item) => item.i)).size, 3)
})

test('带追踪参数的 URL 把新划线写回记录自己的键，不另开一条记录', async () => {
  const store: Store = new Map()
  installChrome(store)
  const clean = 'https://example.com/keep'
  const tagged = `${clean}?utm_campaign=x`

  await addHighlight(clean, draft('原有'), '标题')
  await addHighlight(tagged, draft('新划'), '标题')

  const keys = [...store.keys()].filter((key) => key.startsWith('p:'))
  assert.deepEqual(keys, [pageStorageKey(clean)])
})

test('getPageByUrl：唯一命中追踪参数版本时采用它；多处命中返回 null', async () => {
  const store: Store = new Map()
  installChrome(store)
  const clean = 'https://example.com/loose'
  store.set(pageStorageKey(`${clean}?utm_source=x`), row([{id: 1, text: '甲', prev: '', next: '', createdAt: 1}]))

  // 预筛（只在「? 之前的部分」相同时才去算 looseKey）不能改变结论：
  // 带 utm_ 的键仍应靠回退匹配命中。
  const found = await getPageByUrl(clean)
  assert.equal(found?.highlights.length, 1)

  // 两处都能宽松匹配（不同 query 但都不是追踪参数）时仍会算 looseKey，结论仍是唯一/非唯一。
  store.set(pageStorageKey(`${clean}?a=1`), row([{id: 1, text: '乙', prev: '', next: '', createdAt: 1}]))
  assert.equal(await getPageByUrl(`${clean}?b=2`), null)
})

test('getPageByUrl：路径不同但 query 相同的键不会被预筛当候选', async () => {
  const store: Store = new Map()
  installChrome(store)
  store.set(
    pageStorageKey('https://example.com/other?utm_source=x'),
    row([{id: 1, text: '甲', prev: '', next: '', createdAt: 1}])
  )
  assert.equal(await getPageByUrl('https://example.com/mine?utm_source=x'), null)
})

test('删掉最后一条划线时整页记录一起消失（不留 0 条的空页）', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/last'
  const seeded = await addHighlight(url, draft('唯一一条'), '标题')

  const after = await deleteHighlight(url, seeded.highlights[0]!.id)

  assert.equal(after, null)
  assert.equal(store.has(pageStorageKey(url)), false)
  assert.equal((await listPages()).length, 0)
})

test('还有别的划线时只删那一条，整页记录留着', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/partial'
  const seeded = await addHighlight(url, draft('一'), '标题')
  await addHighlight(url, draft('二'), '标题')

  const after = await deleteHighlight(url, seeded.highlights[0]!.id)

  assert.ok(after)
  assert.deepEqual(after.highlights.map((item) => item.text), ['二'])
  assert.ok(store.has(pageStorageKey(url)))
})

test('老版本留下的空页行不再出现在列表里，顺手被清掉', async () => {
  const store: Store = new Map()
  installChrome(store)
  const stale = 'https://example.com/stale'
  store.set(pageStorageKey(stale), row([]))
  await addHighlight('https://example.com/kept', draft('有划线'), '标题')

  const pages = await listPages()

  assert.deepEqual(pages.map((item) => item.url), ['https://example.com/kept'])
  assert.equal(store.has(pageStorageKey(stale)), false)
})

test('导入里带 0 条的页行不落地', async () => {
  const store: Store = new Map()
  installChrome(store)
  const url = 'https://example.com/imported-empty'

  const summary = await importPages([page(url, [])])

  assert.equal(summary.added, 0)
  assert.equal(store.has(pageStorageKey(url)), false)
})

test('clearAll 连同步端的页行一起清（否则下次拉取会把整库搬回来）', async () => {
  const store: Store = new Map()
  const remote: Store = new Map()
  installStorage(store, 0, remote)
  const url = 'https://example.com/wipe'
  const key = pageStorageKey(url)
  store.set(key, row([{id: 1, text: '甲', prev: '', next: '', createdAt: 1}]))
  remote.set(key, row([{id: 1, text: '甲', prev: '', next: '', createdAt: 1}]))
  store.set('deleted', {[url]: {'abc': Date.now()}})

  await clearAll()

  assert.equal(store.has(key), false)
  assert.equal(remote.has(key), false)
  assert.equal(store.has('deleted'), false)
})
