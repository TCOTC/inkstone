<!--
  数据与同步：统计、备份、跨设备同步、清空。

  设置项**始终**镜像到 `storage.sync`（包括同步开关本身），只有划线数据看开关。
  关掉不删云端副本——那是用户数据，要收回得显式点「清除云端数据」。

  「未定位清单」不在这里——它不是设置，已搬到「我的划线」。
-->
<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {applyBackup, backupFileName, buildBackup, parseBackup} from '../shared/backup'
import {clearAll, stats, type DatabaseStats} from '../shared/db'
import {
  clearGithubToken,
  GITHUB_CLIENT_ID,
  pollDeviceCode,
  requestDeviceCode,
  saveGithubToken,
  type DeviceCode
} from '../shared/githubAuth'
import {parseRepo} from '../shared/githubBackup'
import {
  backupHistory,
  githubStatus,
  loadRepo,
  pushBackup,
  restoreCommit,
  saveRepo,
  syncBackupAlarm
} from '../shared/githubService'
import {clearRemote, pushSettings, syncNow, syncState, type SyncState} from '../shared/sync'
import {BACKUP_INTERVALS, BACKUP_INTERVAL_LABELS} from '../shared/types'
import {openTabAfterCurrent} from './openTab'
import {refreshSettings, settings, updateSettings} from './settingsStore'

const stat = ref<DatabaseStats | null>(null)
/** 备份区的一行状态：`kind` 只用于换颜色，空串表示进行中。 */
const backupStatus = ref<{text: string; kind: '' | 'ok' | 'error'}>({text: '', kind: ''})

/** 同步状态（开关、已用字节、页数）。**关闭时也要读**：云端还剩什么必须看得见。 */
const sync = ref<SyncState>({enabled: false, bytes: 0, limit: 100000, pages: 0})
const syncStatus = ref<{text: string; kind: '' | 'ok' | 'error'}>({text: '', kind: ''})

const syncLine = computed(() => {
  if (!sync.value.enabled && sync.value.pages === 0) return ''
  const kb = (value: number): string => `${(value / 1024).toFixed(1)} KB`
  return `云端 ${sync.value.pages} 页 · 已用 ${kb(sync.value.bytes)} / ${kb(sync.value.limit)}`
})

/** 同步端有没有东西可清。 */
const hasRemote = computed(() => sync.value.pages > 0 || sync.value.bytes > 0)

const syncEnabled = computed<boolean>({
  get: () => settings.value.syncHighlights,
  set: (value) => void applySync(value)
})

const statLine = computed(() => {
  const value = stat.value
  if (!value) return ''
  return [
    `${value.pages} 页`,
    `${value.highlights} 条划线`,
    value.lastImportAt ? `导入于 ${new Date(value.lastImportAt).toLocaleDateString()}` : '尚未导入'
  ]
    .filter(Boolean)
    .join(' · ')
})

/** 自动备份的档位。文案与档位同源（`BACKUP_INTERVALS` + `BACKUP_INTERVAL_LABELS`）。 */
const BACKUP_OPTIONS = BACKUP_INTERVALS.map((value) => ({value, label: BACKUP_INTERVAL_LABELS[value] ?? ''}))

const autoBackup = computed<number>({
  get: () => settings.value.autoBackupMinutes,
  set: (value) => {
    void updateSettings({autoBackupMinutes: value}).then((ok) => {
      if (ok) void syncBackupAlarm()
    })
  }
})

async function refreshStats(): Promise<void> {
  stat.value = await stats()
}

/* ── GitHub 备份 ────────────────────────────────────────────────────────
   与「跨设备同步」是两条独立的路：那条走 Chrome 同步通道做实时镜像，这条往
   你自己仓库的一个文件里写定时快照。卸载扩展会连本机与同步区一起清掉，
   而仓库里的提交不会——这是唯一能跨过卸载的通道。                    */

const configured = ref(GITHUB_CLIENT_ID.length > 0)
const ghConnected = ref(false)
const ghRepo = ref('')
const ghRepoSaved = ref(false)
/** 设备码：等用户去浏览器输的时候才存在。 */
const ghDevice = ref<DeviceCode | null>(null)
const ghStatus = ref<{text: string; kind: '' | 'ok' | 'error'}>({text: '', kind: ''})
const ghHistory = ref<Array<{sha: string; at: number; message: string}>>([])

/** 正在轮询设备码：防止连点开两条轮询链。 */
let polling = false
/** 当前轮询链的取消标记（关页面 / 断开 / 重新开始都会换一个）。 */
let pollRun = 0

async function refreshGithub(): Promise<void> {
  const status = await githubStatus()
  ghConnected.value = status.connected
  const repo = await loadRepo()
  ghRepo.value = repo ? `${repo.owner}/${repo.repo}` : ''
  ghRepoSaved.value = repo !== null
  if (status.connected && status.hasRepo) ghHistory.value = await backupHistory()
  else ghHistory.value = []
}

/**
 * 第一步：要一个 8 位码，把它摆到界面上。
 *
 * 顺序不能换：`permissions.request` 必须是这一串里的**第一个 await**——它要用户手势，
 * 前面先 await 别的东西（读存储、发请求）会把手势消耗掉，请求直接被拒。
 */
async function connectGithub(): Promise<void> {
  if (!configured.value) {
    ghStatus.value = {text: '构建里没有配置 GitHub App 的 client id。', kind: 'error'}
    return
  }
  try {
    const granted = await chrome.permissions.request({
      origins: ['https://github.com/*', 'https://api.github.com/*']
    })
    if (!granted) {
      ghStatus.value = {text: '需要访问 GitHub 的权限才能备份。', kind: 'error'}
      return
    }
  } catch (error) {
    ghStatus.value = {text: `申请权限失败：${error instanceof Error ? error.message : String(error)}`, kind: 'error'}
    return
  }

  ghStatus.value = {text: '正在获取设备码…', kind: ''}
  try {
    const code = await requestDeviceCode({clientId: GITHUB_CLIENT_ID})
    ghDevice.value = code
    // 拿到码就复制：用户接下来只需要「打开授权页 → 粘上 → 点继续」。
    // 成功不写提示：标签已经变成「已复制，去授权页粘贴」，再冒一行就重复了。
    // 复制失败不当错误：码就在界面上，手动选中也能用。
    ghCopied.value = await writeClipboard(code.userCode)
    ghStatus.value = ghCopied.value
      ? {text: '', kind: ''}
      : {text: '没能自动复制，请手动选中下面的码。', kind: ''}
    void pollUntilToken(code, ++pollRun)
  } catch (error) {
    ghStatus.value = {text: `获取设备码失败：${error instanceof Error ? error.message : String(error)}`, kind: 'error'}
  }
}

/**
 * 第三步：轮询换 token。
 *
 * **必须在选项页跑**，不能交给 service worker：码 15 分钟有效、轮询间隔数秒，
 * SW 活不了那么久，而这个界面本来就开着。
 */
async function pollUntilToken(code: DeviceCode, run: number): Promise<void> {
  if (polling) return
  polling = true
  let interval = code.interval
  const deadline = Date.now() + code.expiresIn * 1000
  try {
    while (run === pollRun && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))
      if (run !== pollRun) return

      const outcome = await pollDeviceCode({clientId: GITHUB_CLIENT_ID, deviceCode: code.deviceCode})
      if (outcome.kind === 'token') {
        await saveGithubToken(outcome.token)
        ghDevice.value = null
        ghCopied.value = false
        ghStatus.value = {text: '已连接 GitHub。', kind: 'ok'}
        await refreshGithub()
        return
      }
      if (outcome.kind === 'slow-down') {
        interval = outcome.interval
        continue
      }
      if (outcome.kind === 'pending') continue
      if (outcome.kind === 'expired') {
        ghStatus.value = {text: '设备码已过期，请重新获取。', kind: 'error'}
      } else if (outcome.kind === 'denied') {
        ghStatus.value = {text: '已取消授权。', kind: ''}
      } else {
        ghStatus.value = {text: `授权失败：${outcome.message}`, kind: 'error'}
      }
      ghDevice.value = null
      ghCopied.value = false
      return
    }
    if (run === pollRun) {
      ghStatus.value = {text: '设备码已过期，请重新获取。', kind: 'error'}
      ghDevice.value = null
      ghCopied.value = false
    }
  } finally {
    polling = false
  }
}

/** 用户取消等待（码还在有效期内，只是我们不轮询了）。 */
function cancelConnect(): void {
  pollRun += 1
  ghDevice.value = null
  ghCopied.value = false
  ghStatus.value = {text: '', kind: ''}
}

async function onSaveRepo(): Promise<void> {
  const value = ghRepo.value.trim()
  if (!(await saveRepo(value))) {
    ghStatus.value = {text: '仓库要写成 owner/repo。', kind: 'error'}
    return
  }
  ghRepoSaved.value = value.length > 0
  ghStatus.value = value ? {text: `已设为 ${value}`, kind: 'ok'} : {text: '', kind: ''}
  await refreshGithub()
}

async function onBackupNow(): Promise<void> {
  ghStatus.value = {text: '正在备份…', kind: ''}
  const outcome = await pushBackup()
  if (outcome.kind === 'pushed') {
    ghStatus.value = {
      text: `已备份 ${outcome.pages} 页 / ${outcome.highlights} 条`,
      kind: 'ok'
    }
  } else if (outcome.kind === 'unchanged') {
    ghStatus.value = {text: '内容没有变化，未产生新提交。', kind: ''}
  } else if (outcome.kind === 'unauthorized') {
    ghStatus.value = {text: 'GitHub 授权已失效，请重新连接。', kind: 'error'}
  } else if (outcome.kind === 'unconfigured') {
    ghStatus.value = {text: '先填上要备份到的仓库。', kind: 'error'}
  } else {
    ghStatus.value = {text: outcome.message, kind: 'error'}
  }
  await refreshGithub()
}

async function onRestore(sha: string): Promise<void> {
  if (!window.confirm('用这一份合并恢复？本机独有的划线会保留，不会删除任何东西。')) return
  const result = await restoreCommit(sha)
  if (!result.ok) {
    ghStatus.value = {text: result.error, kind: 'error'}
    return
  }
  ghStatus.value = {
    text: `已恢复：新增 ${result.summary.added} 页，更新 ${result.summary.updated} 页，保留本机独有的 ${result.summary.keptHighlights} 条`,
    kind: 'ok'
  }
  await refreshStats()
}

async function onDisconnectGithub(): Promise<void> {
  if (!window.confirm('断开 GitHub？仓库里的备份不会被删除，只是本机不再自动备份。')) return
  pollRun += 1
  ghDevice.value = null
  await clearGithubToken()
  ghConnected.value = false
  ghHistory.value = []
  ghStatus.value = {text: '已断开。', kind: ''}
}

/** 历史行的时间：只到分钟，列表里够用。 */
function historyTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  return new Date(at).toLocaleString()
}

/** 设备码是否已在剪贴板里（决定提示说「粘贴」还是「手动选中」）。 */
const ghCopied = ref(false)

/** 写剪贴板。返回是否成功——失败不是错误，界面上本来就能手动选中。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 重新复制（用户可能粘贴到别处了，或第一次自动复制失败）。 */
async function copyDeviceCode(): Promise<void> {
  if (!ghDevice.value) return
  ghCopied.value = await writeClipboard(ghDevice.value.userCode)
  ghStatus.value = ghCopied.value
    ? {text: '', kind: ''}
    : {text: '复制失败，请手动选中设备码。', kind: 'error'}
}

/** 打开 GitHub 的输码页。用 `tabs.create` 而不是 `<a href>`：扩展页里点链接会留在同一标签。 */
function openVerifyPage(): void {
  if (!ghDevice.value) return
  void openTabAfterCurrent(ghDevice.value.verificationUri)
}

/** 在新标签里打开备份仓库（看提交历史、下载某份文件都靠它）。 */
function openRepoPage(): void {
  const parsed = parseRepo(ghRepo.value)
  if (!parsed) return
  void openTabAfterCurrent(`https://github.com/${parsed.owner}/${parsed.repo}`)
}

async function refreshSync(): Promise<void> {
  sync.value = await syncState(settings.value)
}

/**
 * 打开 / 关闭划线数据同步。
 *
 * 顺序不能换：写本机设置（权威）→ `pushSettings()` 把开关本身传出去 → 打开时才 `syncNow()`
 * （它先合并再上传）。关掉时**不删**同步端数据，另一台设备可能还在用它。
 */
async function applySync(turnOn: boolean): Promise<void> {
  if (!(await updateSettings({syncHighlights: turnOn}))) return
  await pushSettings()
  if (!turnOn) {
    syncStatus.value = {
      text: hasRemote.value
        ? '已关闭同步。云端副本仍在，要收回请点「清除云端数据」。'
        : '已关闭同步。设置项与 API Key 仍会同步。',
      kind: ''
    }
    await refreshSync()
    return
  }

  syncStatus.value = {text: '正在合并并上传…', kind: ''}
  try {
    const run = await syncNow()
    syncStatus.value = {
      text: [
        run.merged > 0 ? `从云端合并 ${run.merged} 条` : '已合并',
        `上传 ${run.pushed} 页`,
        run.skippedLarge > 0 ? `${run.skippedLarge} 页过大跳过` : '',
        run.skippedQuota > 0 ? `${run.skippedQuota} 页超出配额跳过` : ''
      ]
        .filter(Boolean)
        .join('，'),
      kind: 'ok'
    }
  } catch (error) {
    syncStatus.value = {text: `同步失败：${error instanceof Error ? error.message : String(error)}`, kind: 'error'}
  }
  await refreshSync()
}

/**
 * 与开关无关：关掉只意味着不再读写，云端那份副本还在。真正的「收回数据」必须有这个按钮。
 */
async function onClearRemote(): Promise<void> {
  if (!window.confirm(`确定清除云端的 ${sync.value.pages} 页数据？这不影响本机，但其它设备将看不到这些划线。`)) {
    return
  }
  try {
    const removed = await clearRemote()
    syncStatus.value = {text: `已清除云端的 ${removed} 页数据（本机不受影响）。`, kind: 'ok'}
  } catch (error) {
    syncStatus.value = {text: `清除失败：${error instanceof Error ? error.message : String(error)}`, kind: 'error'}
  }
  await refreshSync()
}

async function onWipe(): Promise<void> {
  if (!window.confirm('确定清空全部划线数据？云端的副本也会一起清掉，此操作不可撤销。')) return
  await clearAll()
  await refreshStats()
  await refreshSync()
  syncStatus.value = {text: '', kind: ''}
  backupStatus.value = {text: '已清空全部数据。', kind: 'ok'}
}

/** 导出：生成备份 → 触发一次下载。 */
async function runExport(): Promise<void> {
  backupStatus.value = {text: '正在生成…', kind: ''}
  try {
    const backup = await buildBackup()
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url
    link.download = backupFileName(new Date(backup.exportedAt))
    link.click()
    URL.revokeObjectURL(url)
    const total = backup.pages.reduce((sum, page) => sum + page.h.length, 0)
    backupStatus.value = {text: `已导出 ${backup.pages.length} 页 / ${total} 条划线。`, kind: 'ok'}
  } catch (error) {
    backupStatus.value = {
      text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
      kind: 'error'
    }
  }
}

async function onImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  backupStatus.value = {text: '正在读取…', kind: ''}
  try {
    const parsed = parseBackup(JSON.parse(await file.text()))
    if (!parsed.ok) {
      backupStatus.value = {text: parsed.error, kind: 'error'}
      return
    }

    const total = parsed.pages.reduce((sum, page) => sum + page.highlights.length, 0)
    backupStatus.value = {text: `正在写入 ${parsed.pages.length} 页 / ${total} 条划线…`, kind: ''}
    const summary = await applyBackup(parsed)
    backupStatus.value = {
      text: [
        `导入完成：新增 ${summary.added} 页，更新 ${summary.updated} 页，${summary.importedHighlights} 条划线`,
        summary.keptHighlights > 0 ? `保留本机独有的 ${summary.keptHighlights} 条` : ''
      ]
        .filter(Boolean)
        .join('，'),
      kind: 'ok'
    }

    // 备份里带了设置：重新读一次，否则界面显示的与实际生效的不一致。
    await refreshSettings()
    await refreshStats()
  } catch (error) {
    backupStatus.value = {
      text: `导入失败：${error instanceof Error ? error.message : String(error)}`,
      kind: 'error'
    }
  } finally {
    // 允许再次选中同一个文件（否则 `change` 不会再触发）。
    input.value = ''
  }
}

onMounted(() => {
  void refreshStats()
  void refreshSync()
  void refreshGithub()
})
</script>

<template>
  <section class="card">
    <h2>统计</h2>
    <div class="fields">
      <p class="stats">{{ statLine || '正在读取…' }}</p>
    </div>
  </section>

  <section class="card">
    <h2>备份</h2>
    <div class="fields">
      <div class="actions">
        <button class="primary" @click="runExport">导出</button>
        <label class="file-button">
          <input type="file" accept="application/json,.json" @change="onImport" />
          导入
        </label>
        <span v-if="backupStatus.text" class="status" :class="backupStatus.kind">{{ backupStatus.text }}</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>跨设备同步</h2>
    <div class="fields">
      <label class="row">
        <span>同步划线到其它设备</span>
        <input v-model="syncEnabled" type="checkbox" role="switch" />
      </label>
      <p v-if="syncLine" class="status">{{ syncLine }}</p>
      <p v-if="syncStatus.text" class="status" :class="syncStatus.kind">{{ syncStatus.text }}</p>
      <div v-if="hasRemote" class="actions">
        <button class="danger" @click="onClearRemote">清除云端数据</button>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>GitHub 备份</h2>
    <div class="fields">
      <template v-if="!configured">
        <p class="status">这一版没有配置 GitHub App，无法启用备份。</p>
      </template>

      <!-- 等用户去浏览器输码：界面上只留码、链接与取消。 -->
      <template v-else-if="ghDevice">
        <div class="gh-device">
          <span class="gh-device-label">{{ ghCopied ? '已复制，去授权页粘贴' : '在 GitHub 输入' }}</span>
          <span class="gh-code">{{ ghDevice.userCode }}</span>
        </div>
        <div class="actions">
          <button class="primary" @click="openVerifyPage">打开授权页</button>
          <button @click="copyDeviceCode">重新复制</button>
          <button @click="cancelConnect">取消</button>
        </div>
      </template>

      <template v-else-if="!ghConnected">
        <div class="actions">
          <button class="primary" @click="connectGithub">连接 GitHub</button>
        </div>
      </template>

      <template v-else>
        <label class="row">
          <span>备份到仓库</span>
          <input v-model="ghRepo" class="text" placeholder="owner/repo" spellcheck="false" />
        </label>
        <div class="actions">
          <button class="primary" @click="onSaveRepo">保存仓库</button>
          <button v-if="ghRepoSaved" @click="onBackupNow">立即备份</button>
          <button v-if="ghRepoSaved" @click="openRepoPage">打开仓库</button>
          <button @click="onDisconnectGithub">断开</button>
        </div>

        <label v-if="ghRepoSaved" class="row">
          <span>自动备份</span>
          <select v-model="autoBackup">
            <option v-for="item in BACKUP_OPTIONS" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
        </label>

        <template v-if="ghHistory.length > 0">
          <div class="gh-history">
            <div v-for="item in ghHistory" :key="item.sha" class="gh-commit">
              <span class="gh-commit-time">{{ historyTime(item.at) }}</span>
              <span class="gh-commit-msg">{{ item.message }}</span>
              <button @click="onRestore(item.sha)">恢复</button>
            </div>
          </div>
        </template>
      </template>

      <p v-if="ghStatus.text" class="status" :class="ghStatus.kind">{{ ghStatus.text }}</p>
      <p class="status">卸载扩展会连本机与同步区一起清掉；仓库里的备份是唯一能找回的地方。</p>
    </div>
  </section>

  <section class="card danger">
    <h2>清空数据</h2>
    <div class="fields">
      <div class="actions">
        <button class="danger" @click="onWipe">清空全部数据</button>
      </div>
    </div>
  </section>
</template>
