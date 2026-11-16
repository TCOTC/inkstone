/**
 * 跨设备同步：`storage.local` 是权威，`storage.sync` 只是通道。
 *
 * Chrome 不会替扩展搬运 local → sync，所以同步必然包含一步主动写入；`Settings.syncHighlights`
 * 只表示「要不要把页行放进那个会被 Chrome 搬走的区」。合并与墓碑规则、配额口径见
 * `docs/design.md` §4.8。
 *
 * 体积一律按 UTF-8 字节量：`JSON.stringify().length` 对中文会低估。
 */
import {adoptKeyMaterial, clearAiKey, readKeyMaterial} from './aiKey'
import {mergePage} from './merge'
import {decodePage, encodePage, type PageRow} from './rowCodec'
import {loadSettings, normalizeSettings, sameSettings, saveSettings} from './settings'
import {AI_KEY_STORAGE, AI_WRAP_STORAGE, PAGE_PREFIX, pageStorageKey, SETTINGS_KEY} from './storageKeys'
import {loadTombstones, type TombstoneMap} from './tombstones'
import {type PageRecord, type Settings} from './types'
// 官方上限分别是 8192 B / 102400 B / 512 项，都留一点余量。
const ITEM_LIMIT = 7000
const TOTAL_LIMIT = 100000
const ITEM_COUNT_LIMIT = 500

/** 写操作按调用次数计配额，所以攒够一次写。 */
const BATCH_KEYS = 40

export interface SyncReport {
  /** 推上去的页数 */
  pushed: number
  /** 因单页过大跳过的页数 */
  skippedLarge: number
  /** 因总量/项数上限跳过的页数 */
  skippedQuota: number
  /** 合并后本地新增的划线条数 */
  merged: number
}

const EMPTY_REPORT = (): SyncReport => ({pushed: 0, skippedLarge: 0, skippedQuota: 0, merged: 0})

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/**
 * 只管划线数据（`p:` 键）；设置始终镜像，见 `pushSettings()`。
 * 不要改成「探测 Chrome 是否在同步」——没有这种 API，关掉时 sync 区照常读写成功。
 */
async function enabled(): Promise<boolean> {
  const settings = await loadSettings()
  return settings.syncHighlights
}

/** 内容与远端一致时跳过（写操作有配额）。 */
async function writeIfChanged(key: string, value: unknown, equal: (remote: unknown) => boolean): Promise<boolean> {
  const stored = await chrome.storage.sync.get(key)
  if (stored[key] !== undefined && equal(stored[key])) return false
  await chrome.storage.sync.set({[key]: value})
  return true
}

/**
 * 设置始终镜像，**不看 `Settings.syncHighlights`**：开关本身就在设置里，先手动打开才同步
 * 就永远得在每台设备上各做一遍。返回值表示这次是否真的写了同步区。
 */
export async function pushSettings(): Promise<boolean> {
  const local = await loadSettings()
  return writeIfChanged(SETTINGS_KEY, local, (remote) => sameSettings(remote, local))
}

/**
 * 采用同步区的设置。语义是后写覆盖：设置是低频操作，够用。
 * 返回是否真的改动了本机——调用方靠它决定要不要重新渲染。
 */
export async function pullSettings(): Promise<boolean> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY)
  const raw = stored[SETTINGS_KEY]
  if (raw === undefined) return false

  const remote = normalizeSettings(raw)
  const local = await loadSettings()
  if (sameSettings(remote, local)) return false

  await saveSettings(remote)
  return true
}

/**
 * API Key 与设置同一条口径：**始终**镜像，不看 `Settings.syncHighlights`。
 *
 * 搬的是密文 + 包装密钥**这一对**：分开搬会出现「密文到了、密钥在路上」的窗口，
 * 而拿到密文解不开的那个设备会把它当坏值处理。
 *
 * 本机没配过时**不搬**（不能区分「没配」与「刚删掉」）；删除走 `removeRemoteAiKey()`，
 * 那个判断由调用方凭 `storage.onChanged` 的 oldValue 做。
 */
export async function pushAiKey(): Promise<boolean> {
  const material = await readKeyMaterial()
  if (!material) return false
  const stored = await chrome.storage.sync.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  if (stored[AI_KEY_STORAGE] === material.key && stored[AI_WRAP_STORAGE] === material.wrap) return false
  await chrome.storage.sync.set({
    [AI_KEY_STORAGE]: material.key,
    [AI_WRAP_STORAGE]: material.wrap
  })
  return true
}

/**
 * 采用同步区的 Key。解不开就不落盘（`adoptKeyMaterial` 自己会验）。
 *
 * 同步区的 `ai:key` 是**空串**时表示「别的设备把它删了」——删键本身做不到这一点，
 * 因为「键不存在」分不清「这台设备没配过」与「刚被删掉」。
 */
export async function pullAiKey(): Promise<boolean> {
  const stored = await chrome.storage.sync.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  const key = stored[AI_KEY_STORAGE]
  if (key === '') return clearAiKey()
  const wrap = stored[AI_WRAP_STORAGE]
  if (typeof key !== 'string' || !key) return false
  if (typeof wrap !== 'string' || !wrap) return false
  return adoptKeyMaterial({key, wrap})
}

/**
 * 本机删了 Key → 同步端留一个**空值标记**（不是删键，理由见 `pullAiKey`）。
 * `pushAiKey()` 不搬空值，所以删除只能走这里。
 */
export async function removeRemoteAiKey(): Promise<void> {
  const stored = await chrome.storage.sync.get([AI_KEY_STORAGE, AI_WRAP_STORAGE])
  if (stored[AI_KEY_STORAGE] === '' && stored[AI_WRAP_STORAGE] === undefined) return
  await chrome.storage.sync.set({[AI_KEY_STORAGE]: ''})
  await chrome.storage.sync.remove(AI_WRAP_STORAGE)
}

export interface SyncRun {
  /** 从同步端合并进来的划线条数 */
  merged: number
  /** 推上去的页数 */
  pushed: number
  /** 因单页过大跳过的页数 */
  skippedLarge: number
  /** 因总量/项数上限跳过的页数 */
  skippedQuota: number
}

/**
 * 先合并再全量上传。顺序不能反：先合并才知道两端的完整集合，否则可能把本机的旧集合
 * 整批盖上去。只在同步刚被打开时用。
 */
export async function syncNow(): Promise<SyncRun> {
  const merged = await pullAndMerge()
  const pushed = await uploadAll()
  return {
    merged: merged.merged,
    pushed: pushed.pushed,
    skippedLarge: pushed.skippedLarge,
    skippedQuota: pushed.skippedQuota
  }
}

/**
 * 推一页（写后调用，失败不阻塞调用方）：同步端没有增量概念，整页是最小单位。
 * 单页过大 / 配额满时静默跳过，要看跳过多少页用 `uploadAll()`。
 */
export async function pushPage(url: string): Promise<void> {
  if (!(await enabled())) return
  await pushKeys([pageStorageKey(url)])
}

/**
 * 本机那条记录已经不存在了。**必须删键而不是写空页行**——空行会被另一台设备当成
 * 本机数据存下来。远端没有这个键时什么都不做（删也要占一次写配额）。
 */
export async function removeRemotePage(url: string): Promise<void> {
  if (!(await enabled())) return
  const key = pageStorageKey(url)
  const stored = await chrome.storage.sync.get(key)
  if (stored[key] === undefined) return
  await chrome.storage.sync.remove(key)
}

/** 只用于刚打开（或重新打开）同步：已有的页要一次性补上去。 */
export async function uploadAll(): Promise<SyncReport> {
  if (!(await enabled())) return EMPTY_REPORT()
  const keys = await localPageKeys()
  return pushKeys(keys)
}

async function localPageKeys(): Promise<string[]> {
  const keys = await chrome.storage.local.getKeys()
  return keys.filter((key) => key.startsWith(PAGE_PREFIX))
}

async function pushKeys(candidates: readonly string[]): Promise<SyncReport> {
  const report = EMPTY_REPORT()
  if (candidates.length === 0) return report

  const names = [...candidates]
  // 一次读齐：`storage.get` 按调用次数付 IPC，读不消耗写入配额。
  const [locals, remotes] = await Promise.all([
    chrome.storage.local.get(names),
    chrome.storage.sync.get(names)
  ])

  let used = await totalBytes()
  let count = await itemCount()
  const batch: Record<string, PageRow> = {}

  for (const key of names) {
    const row = locals[key] as PageRow | undefined
    if (!row) continue
    // 空页行不推：同步端收到一行 0 条会被另一台设备当成本机数据存下来。
    if (!Array.isArray(row.h) || row.h.length === 0) continue

    const size = bytesOf(row)
    if (size > ITEM_LIMIT) {
      report.skippedLarge += 1
      continue
    }
    if (count >= ITEM_COUNT_LIMIT || used + size > TOTAL_LIMIT) {
      report.skippedQuota += 1
      continue
    }

    // 内容没变就不写：写操作有每分钟配额。
    const remote = remotes[key]
    if (remote !== undefined && JSON.stringify(remote) === JSON.stringify(row)) continue

    batch[key] = row
    used += size
    count += 1
    report.pushed += 1

    if (Object.keys(batch).length >= BATCH_KEYS) {
      await chrome.storage.sync.set(batch)
      for (const name of Object.keys(batch)) delete batch[name]
    }
  }

  if (Object.keys(batch).length > 0) await chrome.storage.sync.set(batch)
  return report
}

async function totalBytes(): Promise<number> {
  try {
    return await chrome.storage.sync.getBytesInUse(null)
  } catch {
    return 0
  }
}

async function itemCount(): Promise<number> {
  try {
    return (await chrome.storage.sync.getKeys()).filter((key) => key.startsWith(PAGE_PREFIX)).length
  } catch {
    return 0
  }
}

/** 合并结果与远端不一致时会推回去，两台设备收敛到同一份。 */
export async function pullAndMerge(): Promise<SyncReport> {
  if (!(await enabled())) return EMPTY_REPORT()
  return mergeRemoteKeys(await syncPageKeys())
}

async function syncPageKeys(): Promise<string[]> {
  try {
    return (await chrome.storage.sync.getKeys()).filter((key) => key.startsWith(PAGE_PREFIX))
  } catch {
    return []
  }
}

/**
 * `storage.sync.onChanged` 与全量拉取共用，只处理 `p:` 键。
 * 同步关闭时不合并：关掉就该完全停手，否则别的设备的改动会逆着用户意愿长进来。
 */
export async function mergeRemoteKeys(keys: readonly string[]): Promise<SyncReport> {
  const report = EMPTY_REPORT()
  if (!(await enabled())) return report
  const names = keys.filter((key) => key.startsWith(PAGE_PREFIX))
  if (names.length === 0) return report

  const remote = await chrome.storage.sync.get([...names])
  // 本机行也一次读齐（合并需要它；逐键读会在 500 页时变成 500 次 IPC）。
  const locals = await chrome.storage.local.get([...names])
  const tombstones = await loadTombstones()
  const writes: Record<string, PageRow> = {}
  const pushes: string[] = []
  /** 合并后一条不剩的键：本地与同步端都要删掉。 */
  const gone: string[] = []

  for (const key of names) {
    const incoming = remote[key]
    if (!incoming || typeof incoming !== 'object') continue
    const remoteRow = incoming as PageRow
    if (typeof remoteRow.u !== 'string' || !remoteRow.u) continue

    const localRow = locals[key] as PageRow | undefined
    const remotePage = decodePage(remoteRow)
    const localPage: PageRecord | null = localRow ? decodePage(localRow) : null
    // 本地没有这一页时**也要过墓碑**：删最后一条会把整页记录删掉，只看并集的话
    // 它会在下一次拉取时原样长回来。
    const merged = mergePage(
      localPage ?? {url: '', title: '', createdAtSec: 0, highlights: []},
      remotePage,
      signaturesOf(tombstones, key)
    )

    report.merged += merged.added

    // 空页不落地：本地不留记录，同步端删键（不是写空行）。
    if (merged.page.highlights.length === 0) {
      gone.push(key)
      continue
    }

    const encoded = encodePage(merged.page)
    if (!localRow || JSON.stringify(localRow) !== JSON.stringify(encoded)) writes[key] = encoded
    if (JSON.stringify(remoteRow) !== JSON.stringify(encoded)) pushes.push(key)
  }

  if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes)
  if (gone.length > 0) await chrome.storage.local.remove(gone)
  // 不能走 `pushKeys` 的「内容没变就跳过」：远端此刻还是旧值。
  // 本机行优先取刚算出的 `writes`（内存里那份 `locals` 是旧的）。
  if (pushes.length > 0) {
    const batch: Record<string, PageRow> = {}
    for (const key of pushes) {
      const row = writes[key] ?? (locals[key] as PageRow | undefined)
      if (row && bytesOf(row) <= ITEM_LIMIT) batch[key] = row
    }
    if (Object.keys(batch).length > 0) await chrome.storage.sync.set(batch)
  }

  // 空页在同步端同样删键：另一台设备收到「键没了」不会重建它。
  if (gone.length > 0) await chrome.storage.sync.remove(gone)

  return report
}

/** 墓碑按去掉 `p:` 前缀的 `pageKey` 分桶，所以要切掉前缀。 */
function signaturesOf(tombstones: TombstoneMap, key: string): Set<string> {
  const bucket = tombstones[key.slice(PAGE_PREFIX.length)]
  return new Set(bucket ? Object.keys(bucket) : [])
}

export interface SyncState {
  /** 设置里是否开了同步 */
  enabled: boolean
  /** 同步端已用字节 / 总量上限 */
  bytes: number
  limit: number
  /** 同步端已有的页数 */
  pages: number
}

/**
 * 给偏好设置页展示用。
 *
 * **同步端的状态与开关无关**：关掉同步之后，用户仍然需要知道云端还剩多少数据、
 * 以及能不能清掉。开关只决定「要不要往那里写」，不决定「那里有什么」。
 * 早先这里在关闭时直接返回 0/0，结果是关掉后界面显示「云端 0 页」——
 * 而实际上整库还在那里，且没有任何入口能看出来。
 *
 * `current` 是调用方**手上已有**的设置：偏好设置页刚 `loadSettings()` 过，
 * 不传就会再读一次 `storage.local`。缺省仍然自己读，保持对外行为不变。
 */
export async function syncState(current?: Settings): Promise<SyncState> {
  const settings = current ?? (await loadSettings())
  return {
    enabled: settings.syncHighlights,
    bytes: await totalBytes(),
    limit: TOTAL_LIMIT,
    pages: (await syncPageKeys()).length
  }
}

/**
 * 清掉同步端的全部页行。
 *
 * 两个入口都走它：
 * 1. 「清空本地数据」——不这样做的话，清空之后下一次启动的全量拉取会把整库原样搬回来。
 * 2. 「清除云端数据」——用户关掉同步之后，云端那些副本不该再留着，否则「关掉同步」
 *    只是停止使用，而不是收回数据。这一步**不看开关**：正因为关掉之后才最需要它。
 *
 * 诚实前提：如果**另一台设备仍开着同步**，它下次写入某页时会把那一页再写回同步端。
 * 想彻底清空，所有设备都要关掉同步（或先清再关）。
 */
export async function clearRemote(): Promise<number> {
  const keys = await syncPageKeys()
  if (keys.length > 0) await chrome.storage.sync.remove(keys)
  return keys.length
}
