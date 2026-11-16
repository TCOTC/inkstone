/**
 * 页级写互斥的语义。
 *
 * 只测**本模块能自证的部分**：租约是否会被释放、抛错时是否也释放、过期租约能否被接管、
 * 多页批次是否全放掉。跨标签页的真实竞争要靠 storage 的往返延时，这里用假 store 的
 * 异步延迟近似（见 `storageFixture.ts`：延迟不是装饰，同步 fake 会让竞态窗口消失）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {isLiveLock, lockKey, withPageLock, withPageLocks} from './lock'
import {installStorage, type Store} from './storageFixture'
import {LOCK_PREFIX} from './storageKeys'

const URL_A = 'https://example.com/a'
const URL_B = 'https://example.com/b'

function freshStore(): Store {
  const store: Store = new Map()
  installStorage(store, 0)
  return store
}

test('isLiveLock：只认还在租期内的记录', () => {
  assert.equal(isLiveLock({o: 'x', e: Date.now() + 1000}), true)
  assert.equal(isLiveLock({o: 'x', e: Date.now() - 1}), false)
  assert.equal(isLiveLock({o: 'x'}), false)
  assert.equal(isLiveLock(null), false)
  assert.equal(isLiveLock('x'), false)
})

test('lockKey：同一页的两种写法落到同一把锁，且带前缀', () => {
  const clean = lockKey('https://example.com/post')
  const tracked = lockKey('https://example.com/post?utm_source=share&fbclid=1')
  assert.equal(clean, tracked)
  assert.ok(clean.startsWith(LOCK_PREFIX))
})

test('withPageLock：执行完把租约删掉', async () => {
  const store = freshStore()
  await withPageLock(URL_A, async () => 'ok')

  const live = [...store.keys()].filter((key) => key.startsWith(LOCK_PREFIX))
  assert.deepEqual(live, [])
})

test('withPageLock：任务抛错也释放租约', async () => {
  const store = freshStore()
  await assert.rejects(
    withPageLock(URL_A, async () => {
      throw new Error('boom')
    })
  )
  const live = [...store.keys()].filter((key) => key.startsWith(LOCK_PREFIX))
  assert.deepEqual(live, [])
})

test('withPageLocks：多页一次拿住，结束后全放掉', async () => {
  const store = freshStore()
  const seen: string[] = []
  await withPageLocks([URL_A, URL_B], async () => {
    for (const key of store.keys()) if (key.startsWith(LOCK_PREFIX)) seen.push(key)
  })
  assert.deepEqual(seen.sort(), [lockKey(URL_A), lockKey(URL_B)].sort())
  assert.deepEqual([...store.keys()].filter((key) => key.startsWith(LOCK_PREFIX)), [])
})

test('withPageLocks：同一页重复出现只抢一把', async () => {
  const store = freshStore()
  await withPageLocks([URL_A, `${URL_A}?utm_medium=x`, URL_B], async () => {
    const held = [...store.keys()].filter((key) => key.startsWith(LOCK_PREFIX))
    assert.equal(held.length, 2)
  })
})

test('过期的租约可以被直接接管', async () => {
  const store = freshStore()
  // 先放一把过期的锁，模拟「持锁的标签页崩了」。
  store.set(lockKey(URL_A), {o: 'dead-owner', e: Date.now() - 1})

  let ran = false
  await withPageLock(URL_A, async () => {
    ran = true
  })
  assert.equal(ran, true)
  assert.equal(store.has(lockKey(URL_A)), false)
})
