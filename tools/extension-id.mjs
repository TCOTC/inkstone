/**
 * 算扩展 ID（`components/crx_file/id_util.cc` 的同一套算法）。
 *
 * 为什么需要：`chrome.storage.local` 与 `chrome.storage.sync` **都按扩展 ID 分区**。
 * ID 变了 = 数据还在磁盘上，但再也没有任何入口能读到它（旧的仍在、新的空白）。
 *
 * 两个 ID 来源：
 * - 清单里有 `key`（公钥 base64）→ ID = SHA-256(公钥 DER) 前 16 字节。
 *   固定、与路径无关，商店版与开发版可以共用一个 ID。
 * - 没有 `key` → ID 由**加载路径**算出来。换个文件夹、换台机器，ID 就变了。
 *
 * 用法：
 *   node tools/extension-id.mjs                 # 看当前清单 / 当前 dist 目录的 ID
 *   node tools/extension-id.mjs --path <dir>    # 看某个目录作为开发版时的 ID
 */
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

/** SHA-256 前 16 字节，十六进制每位 0..f 映射到 a..p（避免出现纯数字主机名）。 */
function generateId(input) {
  const digest = createHash('sha256').update(input).digest().subarray(0, 16)
  let out = ''
  for (const byte of digest) {
    out += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
  }
  return out
}

/** 公钥（清单里 `key` 字段的 base64）→ 扩展 ID。 */
export function idFromKey(base64Key) {
  return generateId(Buffer.from(base64Key, 'base64'))
}

/**
 * 「把某个目录当未打包扩展加载」时 Chrome 会算出的 ID。
 *
 * 输入必须已经是**绝对路径**（调用方负责 `resolve`），因为哈希的就是这个字符串：
 * 相对路径会让结果依赖当前工作目录。
 *
 * `windows` 时按 UTF-16LE 取字节，并把盘符转成大写——这两条都在
 * `id_util.cc` 的 `MaybeNormalizePath` 与 `base::FilePath::value()` 里。
 */
export function idFromAbsolutePath(absolute, {windows = process.platform === 'win32'} = {}) {
  if (!windows) return generateId(Buffer.from(absolute, 'utf8'))
  const normalized = /^[a-z]:/.test(absolute) ? absolute[0].toUpperCase() + absolute.slice(1) : absolute
  return generateId(Buffer.from(normalized, 'utf16le'))
}

/**
 * 自检向量，逐条抄自 `components/crx_file/id_util_unittest.cc`。
 *
 * ⚠️ **输入要与原文一字不差**：`GenerateId("_")` 的输入是一个下划线，不是 `"underscore"`；
 * `GenerateIdForPath` 的输入是 POSIX 形态的 `/path/to/file.ext`（Windows 上也一样，
 * 只是取字节的编码不同）。改向量前先回去核原文，别凭印象写字面量。
 */
const VECTORS = [
  ['GenerateId("test")', () => generateId(Buffer.from('test')), 'jpignaibiiemhngfjkcpokkamffknabf'],
  ['GenerateId("_")', () => generateId(Buffer.from('_')), 'ncocknphbhhlhkikpnnlmbcnbgdempcd'],
  [
    'GenerateId(<长字符串>)',
    () => generateId(Buffer.from('this_string_is_longer_than_a_single_sha256_hash_digest')),
    'jimneklojkjdibfkgiiophfhjhbdgcfi'
  ],
  [
    'GenerateIdForPath (posix)',
    () => idFromAbsolutePath('/path/to/file.ext', {windows: false}),
    'lnkgfdknojmdambfcanadbhmfjfljobb'
  ],
  [
    'GenerateIdForPath (windows)',
    () => idFromAbsolutePath('/path/to/file.ext', {windows: true}),
    'jjlkojfgbeklddcpckipekckcmgcbfjn'
  ]
]

/** 算法或平台假设一旦变了，宁可在这里硬失败，也不要继续打印一个可能是错的 ID。 */
function selfCheck() {
  const failed = VECTORS.filter(([, run, expected]) => run() !== expected)
  if (failed.length === 0) return
  for (const [label, run, expected] of failed) {
    console.error(`自检失败：${label} = ${run()}，期望 ${expected}`)
  }
  process.exit(1)
}

function main() {
  selfCheck()
  const args = process.argv.slice(2)
  const pathIndex = args.indexOf('--path')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const manifestUrl = new URL('../src/manifest.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))

  if (manifest.key) {
    console.log(`固定 ID（来自清单 key）：${idFromKey(manifest.key)}`)
    return
  }

  // 默认看仓库里的 dist/chrome，**不依赖当前工作目录**；显式传的 `--path` 按它自己解析。
  const target = pathIndex >= 0 ? (args[pathIndex + 1] ?? 'dist/chrome') : join(root, 'dist/chrome')
  console.log(`清单没有 key → ID 由加载路径决定。`)
  console.log(`  以 ${resolve(target)} 加载时的 ID：${idFromAbsolutePath(resolve(target))}`)
  console.log(`  ⚠️ 换目录 / 换机器就会变，两边的 storage.local 与 storage.sync 互不相通。`)
  console.log(`  固定办法见 docs/identity.md「安装形式与数据归属」。`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
