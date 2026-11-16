<!--
  划选高亮：画笔与启用开关。

  这一组只有两个控件，是左栏分组的最小单位——不为了填满而加控件。
-->
<script setup lang="ts">
import {computed} from 'vue'
import type {PenStyle} from '../shared/styles'
import {settings, updateSettings} from './settingsStore'

/** value 用数字：`<option>` 的 `_value` 由 `:value` 给出，`v-model` 取的就是它。 */
const PEN_OPTIONS = [
  {value: 1, label: '荧光笔'},
  {value: 2, label: '实线下划线'},
  {value: 3, label: '虚线下划线'},
  {value: 4, label: '半透明底 + 下划线'}
] as const satisfies readonly {value: PenStyle; label: string}[]

const penStyle = computed<PenStyle>({
  get: () => settings.value.penStyle,
  set: (value) => void updateSettings({penStyle: value})
})

const highlightEnabled = computed<boolean>({
  get: () => settings.value.highlightEnabled,
  set: (value) => void updateSettings({highlightEnabled: value})
})
</script>

<template>
  <section class="card">
    <h2>外观</h2>
    <div class="fields">
      <label class="row">
        <span>画笔</span>
        <!-- 用 `v-model` 而不是 `:value`：元素的 props 先于子节点 patch，
             直接绑 `:value` 时 `<option>` 还没挂载，`select.value` 会被丢掉。 -->
        <select v-model="penStyle">
          <option v-for="option in PEN_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="row">
        <span>在网页上启用</span>
        <!-- 语义仍是原生 checkbox（role="switch" 让读屏读成「开关」）。 -->
        <input v-model="highlightEnabled" type="checkbox" role="switch" />
      </label>
    </div>
  </section>
</template>
