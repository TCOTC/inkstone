/**
 * 同步的传输层：上传、拉取合并、删除传播。
 *
 * 这里锁的是「两台设备各改一页之后，两边最终一样，而且谁都没丢东西」。
 * `chrome.storage.local` 与 `sync` 都是内存替身（`storageFixture.ts`）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {encodePage, type PageRow} from './rowCodec'
import {highlightSignature} from './merge'
import {installStorage, type Store} from './storageFixture'
import {pageStorageKey} from './storageKeys'
import {clearRemote, mergeRemoteKeys, pullAndMerge, pullSettings, pushSettings, removeRemotePage, syncNow, syncState, uploadAll} from './sync'
import {DEFAULT_SETTINGS, type HighlightRecord, type PageRecord, type Settings} from './types'

const URL_A = 'https://example.com/a'
const KEY_A = pageStorageKey(URL_A)

function highlight(id: number, text: string): HighlightRecord {
  return {id, text, prev: '', next: '', createdAtSec: id}
}

function page(url: string, highlights: HighlightRecord[]): PageRecord {
  return {url, title: '标题', createdAtSec: 1, highlights}
}

/** 装上本地 + 同步两份 store，并把设置里的 sync 打开。 */
function setup(): {local: Store; remote: Store} {
  const local: Store = new Map()
  const remote: Store = new Map()
  installStorage(local, 0, remote)
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: true})
  return {local, remote}
}

function readRow(store: Store, key: string): PageRow {
  return store.get(key) as PageRow
}

/**
 * 归一后的设置快照：以 `DEFAULT_SETTINGS` 为底，只写出用例关心的字段。
 * 提示词默认值是多行长字符串，每处都抄一份只会变成多份要同步维护的副本。
 */
function normalized(patch: Partial<Settings> = {}): Settings {
  return {...DEFAULT_SETTINGS, ...patch}
}

test('uploadAll：把本机的页行镜像到同步端', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  const report = await uploadAll()

  assert.equal(report.pushed, 1)
  assert.equal(JSON.stringify(readRow(remote, KEY_A)), JSON.stringify(readRow(local, KEY_A)))
})

test('uploadAll：内容没变时不重复写（省同步端的写配额）', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  assert.equal((await uploadAll()).pushed, 1)
  assert.equal((await uploadAll()).pushed, 0)
  assert.ok(remote.has(KEY_A))
})

test('uploadAll：同步关掉时什么也不做', async () => {
  const local: Store = new Map()
  const remote: Store = new Map()
  installStorage(local, 0, remote)
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  assert.equal((await uploadAll()).pushed, 0)
  assert.equal(remote.size, 0)
})

test('pullAndMerge：两端的划线合成一份，远端多出来的接在后面', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲'), highlight(2, '乙')])))

  const report = await pullAndMerge()

  assert.equal(report.merged, 1)
  const merged = readRow(local, KEY_A)
  assert.deepEqual(
    merged.h.map((row) => row.x),
    ['甲', '乙']
  )
  // 合并结果与远端一致，不该再推一次。
  assert.equal(JSON.stringify(readRow(remote, KEY_A)), JSON.stringify(merged))
})

test('pullAndMerge：合并结果比远端多时推回远端，两端收敛', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲'), highlight(2, '乙')])))
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  await pullAndMerge()

  assert.equal(JSON.stringify(readRow(remote, KEY_A)), JSON.stringify(readRow(local, KEY_A)))
  assert.equal(readRow(remote, KEY_A).h.length, 2)
})

test('删除传播：本机删掉并留了墓碑，远端的旧副本不会把它复活', async () => {
  const {local, remote} = setup()
  // 远端还留着两条（另一台设备没删）。
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲'), highlight(2, '乙')])))
  // 本机只剩「乙」，并记了「甲」的墓碑。
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '乙')])))
  local.set('tombstones', {[URL_A]: {[highlightSignature(highlight(1, '甲'))]: Date.now()}})

  const report = await pullAndMerge()

  assert.equal(report.merged, 0)
  assert.deepEqual(
    readRow(local, KEY_A).h.map((row) => row.x),
    ['乙']
  )
  assert.deepEqual(
    readRow(remote, KEY_A).h.map((row) => row.x),
    ['乙']
  )
})

test('本地没有这一页时直接采用远端那一页', async () => {
  const {local, remote} = setup()
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲'), highlight(2, '乙')])))

  const report = await pullAndMerge()

  assert.equal(report.merged, 2)
  assert.deepEqual(
    readRow(local, KEY_A).h.map((row) => row.x),
    ['甲', '乙']
  )
})

test('本机把一页删到空（本地已无行）时，远端那一页被删掉而不是长回一条空记录', async () => {
  const {local, remote} = setup()
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲'), highlight(2, '乙')])))
  // 本机已经删光这两条：整页记录与页行都没了，只留下墓碑。
  local.set('tombstones', {
    [URL_A]: {
      [highlightSignature(highlight(1, '甲'))]: Date.now(),
      [highlightSignature(highlight(2, '乙'))]: Date.now()
    }
  })

  const report = await pullAndMerge()

  assert.equal(report.merged, 0)
  assert.equal(local.has(KEY_A), false)
  assert.equal(remote.has(KEY_A), false)
})

test('远端带来的 0 条页行不落地，同步端那份也清掉', async () => {
  const {local, remote} = setup()
  remote.set(KEY_A, encodePage(page(URL_A, [])))

  await pullAndMerge()

  assert.equal(local.has(KEY_A), false)
  assert.equal(remote.has(KEY_A), false)
})

test('uploadAll：空页行不推到同步端', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [])))

  assert.equal((await uploadAll()).pushed, 0)
  assert.equal(remote.has(KEY_A), false)
})

test('removeRemotePage：删掉同步端那一页；远端没有该键时不白写一次', async () => {
  const {remote} = setup()
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  await removeRemotePage(URL_A)
  assert.equal(remote.has(KEY_A), false)

  // 再删一次：键已经不在了，不应该再付一次写配额（写次数用 spy 数不准，这里只验状态不变）。
  await removeRemotePage(URL_A)
  assert.equal(remote.size, 0)
})

test('removeRemotePage：同步关掉时不动同步区', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  await removeRemotePage(URL_A)

  assert.ok(remote.has(KEY_A))
})

test('mergeRemoteKeys：忽略非 p: 键', async () => {
  const {local, remote} = setup()
  remote.set('settings', {penStyle: 2})

  const report = await mergeRemoteKeys(['settings'])

  assert.equal(report.merged, 0)
  assert.deepEqual(local.get('settings'), {penStyle: 1, highlightEnabled: true, syncHighlights: true})
})

test('合并是幂等的：连拉两次不会再变', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(5, '乙')])))

  await pullAndMerge()
  const first = JSON.stringify(readRow(local, KEY_A))
  await pullAndMerge()

  assert.equal(JSON.stringify(readRow(local, KEY_A)), first)
})

test('同步关掉时不合并：另一台设备的改动不会逆着用户意愿长进来', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲'), highlight(2, '乙')])))

  const merged = await mergeRemoteKeys([KEY_A])
  assert.equal(merged.merged, 0)
  assert.equal(readRow(local, KEY_A).h.length, 1)

  const pulled = await pullAndMerge()
  assert.equal(pulled.merged, 0)
  assert.equal(readRow(local, KEY_A).h.length, 1)
})

test('clearRemote：只清页行，别的键不动', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))
  remote.set('other', {keep: true})

  const removed = await clearRemote()

  assert.equal(removed, 1)
  assert.equal(remote.has(KEY_A), false)
  assert.deepEqual(remote.get('other'), {keep: true})
  // 本地不受影响：清空本地由 `clearAll` 负责，`clearRemote` 只管同步端。
  assert.ok(local.has(KEY_A))
})

test('clearRemote：同步关掉之后仍然能清（要收回数据时才最需要它）', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  assert.equal(await clearRemote(), 1)
  assert.equal(remote.has(KEY_A), false)
})

test('syncState：同步关掉时也能看到云端还剩多少', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))

  const state = await syncState()

  assert.equal(state.enabled, false)
  assert.equal(state.pages, 1)
  assert.ok(state.bytes > 0)
})

test('设置始终镜像：同步关着也会写到同步区', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 3, highlightEnabled: false, syncHighlights: false})

  assert.equal(await pushSettings(), true)
  assert.deepEqual(
    remote.get('settings'),
    normalized({penStyle: 3, highlightEnabled: false, syncHighlights: false})
  )
})

test('设置镜像：内容没变时不重复写（省写配额）', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 2, highlightEnabled: true, syncHighlights: false})

  assert.equal(await pushSettings(), true)
  assert.equal(await pushSettings(), false)
  assert.equal(remote.size, 1)
})

test('设置镜像：缺字段与显式默认值算同一个值', async () => {
  const {local, remote} = setup()
  remote.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  // local 只有默认值（setup 里写的是完整三字段）；换成缺字段的形态再推一次。
  local.set('settings', {penStyle: 1, highlightEnabled: true})

  assert.equal(await pushSettings(), false)
})

test('采用远端设置：值不同时覆盖本机并报告已变', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: false})
  remote.set('settings', {penStyle: 4, highlightEnabled: false, syncHighlights: true})

  assert.equal(await pullSettings(), true)
  assert.deepEqual(
    local.get('settings'),
    normalized({penStyle: 4, highlightEnabled: false, syncHighlights: true})
  )
})

test('采用远端设置：值相同时不动本机', async () => {
  const {local, remote} = setup()
  local.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: true})
  remote.set('settings', {penStyle: 1, highlightEnabled: true, syncHighlights: true})

  assert.equal(await pullSettings(), false)
})

test('采用远端设置：远端没有这个键时保持本机不变', async () => {
  const {local} = setup()
  local.set('settings', {penStyle: 2, highlightEnabled: true, syncHighlights: false})

  assert.equal(await pullSettings(), false)
  // 一个字段都不重写：本机存的还是自己写进去的那份（不是归一后的全部字段）。
  assert.deepEqual(local.get('settings'), {penStyle: 2, highlightEnabled: true, syncHighlights: false})
})

test('采用远端设置：远端是脏值时按归一后的值写入', async () => {
  const {local, remote} = setup()
  // 本机默认是 {penStyle:1, highlightEnabled:true, syncHighlights:true}（见 setup）。
  // 远端的 99 越界 → 归一为 1；`highlightEnabled: 'yes'` 非 boolean → 归一为默认 true；
  // 只有 syncHighlights 真的变了。
  remote.set('settings', {penStyle: 99, highlightEnabled: 'yes', syncHighlights: false})

  assert.equal(await pullSettings(), true)
  assert.deepEqual(
    local.get('settings'),
    normalized({penStyle: 1, highlightEnabled: true, syncHighlights: false})
  )
})

test('采用远端设置：归一后与本机相同时不写', async () => {
  const {local, remote} = setup()
  remote.set('settings', {penStyle: 99, highlightEnabled: 'yes', syncHighlights: true})

  assert.equal(await pullSettings(), false)
  assert.deepEqual(local.get('settings'), {penStyle: 1, highlightEnabled: true, syncHighlights: true})
})

test('syncNow：先合并再上传，两端一致', async () => {
  const {local, remote} = setup()
  local.set(KEY_A, encodePage(page(URL_A, [highlight(1, '甲')])))
  remote.set(KEY_A, encodePage(page(URL_A, [highlight(9, '乙')])))

  const run = await syncNow()

  assert.equal(run.merged, 1)
  assert.equal(JSON.stringify(readRow(local, KEY_A)), JSON.stringify(readRow(remote, KEY_A)))
})
