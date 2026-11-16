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
import {clearRemote, pushSettings, syncNow, syncState, type SyncState} from '../shared/sync'
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

async function refreshStats(): Promise<void> {
  stat.value = await stats()
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

  <section class="card danger">
    <h2>清空数据</h2>
    <div class="fields">
      <div class="actions">
        <button class="danger" @click="onWipe">清空全部数据</button>
      </div>
    </div>
  </section>
</template>
