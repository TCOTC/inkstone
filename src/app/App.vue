<!--
  偏好设置的外壳：左边分组，右边只渲染当前一组。

  分组进地址栏（`#settings/ai`），刷新与分享都能落到同一组。切分组用 `replaceState`
  而不是改 `location.hash`：后者会触发 `pages/app.ts` 的 hashchange，整个视图被卸载重建，
  正在编辑的输入框会丢焦点。

  三组各自的视图是 `AppHighlight` / `AppAi` / `AppData`，状态在 `settingsStore.ts`。
-->
<script setup lang="ts">
import {onMounted, ref, watch} from 'vue'
import {LIBRARY_HASH, readSettingsGroup, SETTINGS_GROUPS, settingsGroupHash, type SettingsGroup} from '../shared/route'
import AppAi from './AppAi.vue'
import AppData from './AppData.vue'
import AppHighlight from './AppHighlight.vue'
import {refreshSettings, saveState} from './settingsStore'

/** 左栏文字。**顺序不写这里**：顺序由 `SETTINGS_GROUPS` 决定（地址栏协议在那边）。 */
const LABELS: Record<SettingsGroup, string> = {
  highlight: '划选高亮',
  ai: '划选翻译与解释',
  data: '数据与同步'
}

const GROUPS = SETTINGS_GROUPS.map((id) => ({id, label: LABELS[id]}))

const group = ref<SettingsGroup>(readSettingsGroup(location.hash))

function select(id: SettingsGroup): void {
  if (id === group.value) return
  group.value = id
  history.replaceState(null, '', settingsGroupHash(id))
}

/** 标题跟着分组走：地址栏是 `#settings/ai`，标签页却写「偏好设置」会让人找不到自己在哪。 */
watch(
  group,
  (value) => {
    document.title = `${LABELS[value]} · Inkstone`
  },
  {immediate: true}
)

onMounted(() => {
  // 设置必须真的读一次：初始值只是 `DEFAULT_SETTINGS`，不读就永远显示默认值。
  void refreshSettings()
})
</script>

<template>
  <header class="top">
    <h1>偏好设置</h1>
    <nav class="topnav">
      <!-- 同一个文档、不同 hash（见 pages/app.ts 的分发）。箭头用图标，不用 `→` 字符：
           字符在不同字体的基线/字宽下与文字对不齐。 -->
      <a class="link icon-link" :href="LIBRARY_HASH">
        我的划线
        <svg class="arrow" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </a>
    </nav>
  </header>

  <main class="settings">
    <nav class="settings-nav" aria-label="设置分组">
      <button
        v-for="item in GROUPS"
        :key="item.id"
        type="button"
        class="nav-item"
        :class="{active: item.id === group}"
        :aria-current="item.id === group ? 'page' : undefined"
        @click="select(item.id)"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="settings-body">
      <AppHighlight v-if="group === 'highlight'" />
      <AppAi v-else-if="group === 'ai'" />
      <AppData v-else />
    </div>
  </main>

  <!-- 保存反馈只有这一处：控件自己不再各写一行「已保存」/「保存失败」。 -->
  <p v-if="saveState.text" class="toast" :class="saveState.kind" role="status" aria-live="polite">
    {{ saveState.text }}
  </p>
</template>
