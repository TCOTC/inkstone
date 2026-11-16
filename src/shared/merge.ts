/**
 * 跨设备合并：把两个设备上的同一页合成一份。
 *
 * 前提：`chrome.storage.sync` 是**按键整值**同步的（同键以更晚写入的整个值覆盖），
 * 两台设备都改过同一页时，后写的会把先写的整页盖掉。所以同步不能「收到就用」，
 * 必须**合并**：
 *
 * 1. 以**内容签名**判断「是不是同一条划线」——不用 `id`，因为 `id` 是页内序号，
 *    两台设备各自从 1 开始数，同号必然撞车。
 * 2. 本机已有的行**原样保留**（顺序、id 都不动），远端多出来的接在后面并分配新号。
 *    没有任何变化时不重排，所以「同步一次」不会产生无意义的写盘。
 * 3. 删除靠**墓碑**（见 `shared/tombstones.ts`）：只做并集的话，A 设备删掉的线
 *    会被 B 设备的旧副本复活。
 *
 * 这个模块是纯函数（不碰 storage），同步的传输部分在 `shared/sync.ts`。
 */
import {stripWs} from './whitespace'
import {mergeExtra} from './rowCodec'
import type {HighlightRecord, PageRecord} from './types'

/** 分隔符：三个字段本来就可能含任意字符，用 NUL 才不会拼出歧义。 */
const SEP = '\u0000'

/**
 * 内容签名：同一条划线在两台设备上的签名相同。
 *
 * 只取定位三元组，且按 `stripWs` 归一——空白差异（两端 DOM 的换行/缩进不同）
 * 不该让我们把同一条线当成两条。`createdAtSec` 不参与：同一段文字在两台设备上先后划过时，
 * 时间戳不同，但它们是「同一处高亮」。
 */
export function highlightSignature(highlight: Pick<HighlightRecord, 'text' | 'prev' | 'next'>): string {
  const plain = [highlight.text, highlight.prev, highlight.next].map((value) => stripWs(value ?? '')).join(SEP)
  return hash64(plain)
}

/**
 * 64 位 FNV-1a（两轮不同种子拼起来）。
 *
 * 不用 `crypto.subtle`：它需要安全上下文，而 content script 会跑在 http 页面上。
 * 也不用直接存三个字段的原文：墓碑要在 storage 里长期留着，原文太长。
 */
function hash64(text: string): string {
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x1b873593)}`
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export interface MergeResult {
  page: PageRecord
  /** 从远端新加进来的条数 */
  added: number
  /** 因为墓碑被剔除的条数（远端带来的、本机已删的） */
  dropped: number
}

/**
 * 合并一页。
 *
 * `local` 是权威（顺序与 id 都保留），`remote` 只提供本机没有的内容。
 * `tombstones` 是该页已删划线的签名集合。
 */
export function mergePage(
  local: PageRecord,
  remote: PageRecord | null,
  tombstones: ReadonlySet<string>
): MergeResult {
  if (!remote) return {page: local, added: 0, dropped: 0}

  const kept: HighlightRecord[] = []
  let dropped = 0
  for (const item of local.highlights) {
    if (tombstones.has(highlightSignature(item))) dropped += 1
    else kept.push(item)
  }

  const seen = new Set(kept.map(highlightSignature))
  let nextId = kept.reduce((max, item) => (item.id > max ? item.id : max), 0) + 1
  const added: HighlightRecord[] = []

  for (const item of remote.highlights) {
    const sig = highlightSignature(item)
    if (tombstones.has(sig) || seen.has(sig)) {
      if (tombstones.has(sig)) dropped += 1
      continue
    }
    seen.add(sig)
    added.push({...item, id: nextId})
    nextId += 1
  }

  const merged: PageRecord = {
    url: local.url || remote.url,
    title: local.title || remote.title,
    createdAtSec: local.createdAtSec || remote.createdAtSec,
    highlights: [...kept, ...added]
  }
  // 页面级的未知字段取并集，本机优先：远端（可能是新版本）带来的键不会被本机抹掉。
  const extra = mergeExtra(remote.extra, local.extra)
  if (extra) merged.extra = extra

  return {page: merged, added: added.length, dropped}
}
