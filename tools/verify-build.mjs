/**
 * 构建产物自检：`pnpm verify`（需先 `pnpm build`）。
 *
 * 检查的都是「构建能过、但装到浏览器里才发现」的问题：
 * 权限漂移、混进 host 权限、清单残留 Firefox 字段、入口文件缺失、中文被写坏、测试文件泄漏进产物。
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {idFromAbsolutePath, idFromKey} from './extension-id.mjs'

/** 仓库根。**不依赖当前工作目录**：从任何位置调本脚本都要读同一份产物。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist/chrome')

/**
 * 期望的权限集：多一个都算漂移，必须同步更新 docs/design.md。
 *
 * `contextMenus` 只用于给工具栏图标加两个右键条目（我的划线 / 偏好设置），
 * 不涉及任何页面数据。`alarms` 只用来排定时备份（MV3 的 worker 会被回收，
 * `setTimeout` 活不过去），装它不会额外弹权限提示。
 */
const EXPECTED_PERMISSIONS = ['storage', 'contextMenus', 'alarms']

/**
 * 期望的 host 权限，**只有 AI 接口这一个**。
 *
 * 划词翻译/解释的请求从 service worker 发出；扩展 origin 的 fetch 要靠 host 权限
 * 才能绕过 CORS（页面源的 content script 永远受 CORS 约束）。页面注入仍然由
 * `content_scripts.matches` 声明，这里**不能**出现 `<all_urls>`。
 */
const EXPECTED_HOST_PERMISSIONS = ['https://api.deepseek.com/*']

/**
 * 可选的 host 权限：GitHub 备份。
 *
 * 用 `optional_host_permissions` 而不是写进 `host_permissions`：绝大多数人不开备份，
 * 不该在安装时被吓一跳。点「连接 GitHub」时才 `permissions.request` —— 那次点击就是
 * 需要的手势。
 */
const EXPECTED_OPTIONAL_HOST_PERMISSIONS = ['https://api.github.com/*', 'https://github.com/*']

/** 清单里必须指向这些文件的入口。 */
const EXPECTED_ENTRIES = {
  'background.service_worker': 'background/service_worker.js',
  'content_scripts.0.js.0': 'content_scripts/content-0.js',
  options_page: 'options/index.html',
  action: 'images/icon-128.png'
}

/**
 * 期望的产物文件。
 *
 * 不要断言 `shared/commons.js` 之类的共享 chunk：它是否被抽出取决于入口数量，
 * 断言它会得到一条与产物质量无关的失败。
 */
const EXPECTED_FILES = [
  'manifest.json',
  'background/service_worker.js',
  'content_scripts/content-0.js',
  'options/index.html',
  'options/index.js',
  'options/index.css',
  'images/icon-16.png',
  'images/icon-32.png',
  'images/icon-48.png',
  'images/icon-128.png'
]

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

const manifestPath = `${DIST}/manifest.json`
if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} 不存在，先跑 pnpm build`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

check(manifest.manifest_version === 3, `manifest_version 应为 3，实际 ${manifest.manifest_version}`)

// 本项目只做 Chrome；出现 Firefox 字段说明清单没清干净。
for (const key of Object.keys(manifest)) {
  check(!key.startsWith('firefox:'), `清单里残留 Firefox 前缀字段：${key}`)
}
check(!('browser_specific_settings' in manifest), '清单里残留 browser_specific_settings')
check(!('browser_action' in manifest), '清单里残留 browser_action')
check(!('side_panel' in manifest), '清单里残留 side_panel（管理页是独立标签页）')

// 页面注入完全由 content_scripts.matches 声明；host 权限只留给 AI 接口这一个具体域名。
const hosts = [...(manifest.host_permissions ?? [])].sort()
check(
  JSON.stringify(hosts) === JSON.stringify([...EXPECTED_HOST_PERMISSIONS].sort()),
  `host_permissions 与预期不一致\n    预期 ${EXPECTED_HOST_PERMISSIONS.join(', ')}\n    实际 ${hosts.join(', ') || '(空)'}`
)
check(
  !hosts.includes('<all_urls>'),
  'host_permissions 里出现了 <all_urls>：请求只需要发往 AI 接口'
)
const optionalHosts = [...(manifest.optional_host_permissions ?? [])].sort()
check(
  JSON.stringify(optionalHosts) === JSON.stringify([...EXPECTED_OPTIONAL_HOST_PERMISSIONS].sort()),
  `optional_host_permissions 与预期不一致\n    预期 ${EXPECTED_OPTIONAL_HOST_PERMISSIONS.join(', ')}\n    实际 ${optionalHosts.join(', ') || '(空)'}`
)
check(!('optional_permissions' in manifest), '出现了 optional_permissions，本项目用不到')

const actual = [...(manifest.permissions ?? [])].sort()
const wanted = [...EXPECTED_PERMISSIONS].sort()
check(
  JSON.stringify(actual) === JSON.stringify(wanted),
  `权限与预期不一致\n    预期 ${wanted.join(', ')}\n    实际 ${actual.join(', ')}`
)
check(!actual.includes('scripting'), '出现了 scripting 权限，注入范围由 content_scripts 声明')

// content script 必须覆盖所有站点，否则「打开一个划过的页面」会因为没注入而静默失效。
const matches = manifest.content_scripts?.[0]?.matches ?? []
check(
  Array.isArray(matches) && matches.includes('<all_urls>'),
  `content_scripts.matches 应包含 <all_urls>，实际 ${JSON.stringify(matches)}`
)

const readPath = (path) => path.split('.').reduce((value, key) => value?.[key], manifest)
for (const [path, marker] of Object.entries(EXPECTED_ENTRIES)) {
  const value = readPath(path)
  check(value !== undefined, `清单缺少 ${path}`)
  if (value !== undefined) {
    check(
      JSON.stringify(value).includes(marker),
      `${path} 未指向 ${marker}（实际 ${JSON.stringify(value)}）`
    )
  }
}

// 用到的最新 API 是 `storage.local.getKeys`（Chrome 130，见 `shared/db.ts` 的回退查找）。
// 下调 = 声明未验证的兼容性。
const MIN_CHROME_VERSION = 130
const minVersion = Number(manifest.minimum_chrome_version)
check(
  Number.isFinite(minVersion) && minVersion >= MIN_CHROME_VERSION,
  `minimum_chrome_version 应 >= ${MIN_CHROME_VERSION}，实际 ${manifest.minimum_chrome_version}`
)

for (const file of EXPECTED_FILES) {
  check(existsSync(`${DIST}/${file}`), `缺少产物 ${file}`)
}

// `*.test.ts` 只给 `node --test` 用。它们没被任何入口引用，理应不进产物；
// 一旦出现在这里，说明有人从产品代码里 import 了测试文件。
const packaged = readdirSync(DIST, {recursive: true}).map(String)
for (const file of packaged) {
  check(!/\.test\.[cm]?[jt]s$/.test(file), `产物里混进了测试文件：${file}`)
}

// 中文描述被写坏时构建不会报错，装到浏览器里才会显形。
const description = manifest.description ?? ''
check(
  !description.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(description),
  `description 中文可能已损坏（${description}）`
)

console.log(`  ${manifest.name} ${manifest.version} — 权限 ${actual.join(', ')}`)
console.log(`  host 权限 ${hosts.join(', ') || '(无)'}`)
console.log(`  可选 host 权限：${EXPECTED_OPTIONAL_HOST_PERMISSIONS.join(', ')}（GitHub 备份，点连接时才申请）`)
console.log(`  minimum_chrome_version ${manifest.minimum_chrome_version}`)

// 扩展 ID 决定 storage 分区：ID 变了，磁盘上的数据还在但没有任何入口能读到。
// 有 `key` 时 ID 固定；没有时由加载路径算，换目录/换机器就变。这里只提示，不让自检失败。
const extensionId = manifest.key ? idFromKey(manifest.key) : idFromAbsolutePath(resolve(DIST))
console.log(`  扩展 ID ${extensionId}${manifest.key ? '（清单 key 固定）' : '（由加载路径决定）'}`)
if (!manifest.key) {
  console.log('  提示：清单没有 key，ID 随加载路径变化。切到商店版之前先看 docs/identity.md。')
}

if (failures.length > 0) {
  console.error('\n自检未通过：')
  for (const failure of failures) console.error(`  x ${failure}`)
  process.exit(1)
}

console.log('\n自检通过：产物齐全、host 权限只有 AI 接口、无 Firefox 残留、权限集与 docs/design.md 一致。')
