/**
 * 页级写互斥。storage 的 `get` / `set` 之间没有事务，两个「读 → 改 → 写」交错会丢线。
 *
 * 两级：同一 JS 上下文用 Promise 链；跨标签页用 storage 里的租约锁。
 * 锁身份用 **`looseKey` 而不是存储键**：同一条记录可能被多个 URL 通过回退匹配指向，
 * 按存储键抢锁等于各抢一把。详见 `docs/design.md` §4.6。
 */
import {looseKey} from './url'

/** 写锁的键前缀。锁住在 storage 里，才能被别的标签页看到。 */
export const LOCK_PREFIX = 'lock:'

/** 持锁的标签页被关掉 / 扩展重载时，超过它就自动失效。 */
const LOCK_TTL_MS = 5000
/** 超时就直接写：宁可极小概率覆盖，也不要卡住界面。 */
const LOCK_WAIT_MS = 3000
/** 重试间隔基数，接随机抖动避免两个写者同步重试。 */
const LOCK_RETRY_MS = 20

interface LockRecord {
  /** 持有者标识 */
  o: string
  /** 过期时刻（毫秒时间戳） */
  e: number
}

/** 这把锁还在不在租期内。过期的锁任何写者都可以直接接管。 */
export function isLiveLock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<LockRecord>
  return typeof record.e === 'number' && record.e > Date.now()
}

/** 完整的存储键（`LOCK_PREFIX` + `looseKey(url)`）。 */
export function lockKey(url: string): string {
  return LOCK_PREFIX + looseKey(url)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeOwner(): string {
  // 不用 `crypto.randomUUID`：它在非安全上下文（http 页面里的 content script）不存在。
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 抢不到（等超时）返回 null，调用方照常执行但要接受可能被覆盖。
 *
 * storage 没有 CAS，所以用**写后回读**把竞态收窄到一次往返：抢输的那个在回读里
 * 看到别人的标识，继续等。失败方向是「多等一会儿」，不是「默默丢数据」。
 * 不用 `storage.session`：它对 content script 默认不可见，还要额外配置。
 */
async function acquireLock(identity: string): Promise<string | null> {
  const owner = makeOwner()
  const deadline = Date.now() + LOCK_WAIT_MS

  for (;;) {
    const stored = await chrome.storage.local.get(identity)
    if (!isLiveLock(stored[identity])) {
      const record: LockRecord = {o: owner, e: Date.now() + LOCK_TTL_MS}
      await chrome.storage.local.set({[identity]: record})
      const check = await chrome.storage.local.get(identity)
      if ((check[identity] as LockRecord | undefined)?.o === owner) return owner
    }
    if (Date.now() >= deadline) return null
    await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS)
  }
}

/** 释放锁。只删自己那一把：租期被接管后不能误删别人的。 */
async function releaseLock(identity: string, owner: string): Promise<void> {
  const stored = await chrome.storage.local.get(identity)
  if ((stored[identity] as LockRecord | undefined)?.o !== owner) return
  await chrome.storage.local.remove(identity)
}

/**
 * 同页写操作的串行链（**只覆盖当前 JS 上下文**）。
 *
 * 队列里存「永不拒绝」的版本：一次写入失败不能让后续写全部被跳过。
 */
const writeQueues = new Map<string, Promise<void>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  writeQueues.set(key, settled)
  void settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key)
  })
  return run
}

/**
 * 在页级互斥下执行 `task`：本上下文排队，跨上下文抢存储锁。
 *
 * 先排队再抢锁，同一个上下文里的写者不会互相对着同一把锁空转。
 */
export async function withPageLock<T>(url: string, task: () => Promise<T>): Promise<T> {
  const key = lockKey(url)
  return enqueue(key, async () => {
    const owner = await acquireLock(key)
    try {
      return await task()
    } finally {
      if (owner) await releaseLock(key, owner)
    }
  })
}

/**
 * 一次拿住多页的锁再执行 `task`（导入会改很多页）。
 *
 * **先按锁身份排序再逐个抢**：两个并发导入若以相反顺序抢同一批键，会互相等到超时。
 */
export async function withPageLocks<T>(urls: readonly string[], task: () => Promise<T>): Promise<T> {
  const keys = [...new Set(urls.map(lockKey))].sort()
  const held: Array<{key: string; owner: string}> = []

  try {
    for (const key of keys) {
      const owner = await acquireLock(key)
      if (owner) held.push({key, owner})
    }
    return await task()
  } finally {
    for (const item of held) await releaseLock(item.key, item.owner)
  }
}
