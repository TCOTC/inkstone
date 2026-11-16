<!--
  划选翻译与解释：Key、目标语言、提示词、是否先思考。

  只有控件，没有说明段落。需要用户知道的信息一律落在控件自身：
  placeholder 放占位符清单、状态行只在出错时出现、其余进按钮与标签文字。
-->
<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {loadAiKey, maskKey, saveAiKey} from '../shared/aiKey'
import {
  AI_ACTION_LABEL,
  AI_ACTIONS,
  AI_LANGUAGES,
  PROMPT_CONTEXT_SLOT,
  PROMPT_LANG_SLOT,
  PROMPT_TEXT_SLOT
} from '../shared/prompt'
import {settings, updateSettings} from './settingsStore'
import {drafts, ensurePromptsLoaded, PROMPT_FIELDS, promptErrors, savePrompt, setPromptMode} from './usePrompts'

/** textarea 的 placeholder：三个占位符就是这里能用的全部替换位。 */
const SLOT_HINT = `${PROMPT_TEXT_SLOT} ${PROMPT_LANG_SLOT} ${PROMPT_CONTEXT_SLOT}`

const translateLang = computed<string>({
  get: () => settings.value.translateLang,
  set: (value) => void updateSettings({translateLang: value})
})

const aiThinking = computed<boolean>({
  get: () => settings.value.aiThinking,
  set: (value) => void updateSettings({aiThinking: value})
})

/**
 * 连接配置只剩一把 API Key：地址与模型都写死在 `shared/ai.ts`（只支持 DeepSeek 官方接口）。
 * 单独用草稿 + 显式保存，是为了不把用户正在输入的内容当成已生效的配置。
 */
const aiKeyDraft = ref('')
/** 已保存 Key 的掩码（只告诉用户「存过了」，不回填 Key 本身）。 */
const savedKeyMask = ref('')
const aiStatus = ref<{text: string; kind: '' | 'ok' | 'error'}>({text: '', kind: ''})

async function refreshAi(): Promise<void> {
  savedKeyMask.value = maskKey(await loadAiKey())
  aiKeyDraft.value = ''
}

/**
 * 保存 API Key。
 *
 * 空草稿 = 「不改动已有的 Key」（只想看看状态时不该把 Key 抹掉）；
 * 一次都没存过则要说清楚还缺什么，否则点保存像什么都没发生。
 */
async function onSaveAi(): Promise<void> {
  const typedKey = aiKeyDraft.value.trim()
  if (!typedKey) {
    aiStatus.value = savedKeyMask.value
      ? {text: 'Key 没有变化。要更换就填入新的 Key 再保存。', kind: ''}
      : {text: '请先填入 DeepSeek API Key。', kind: 'error'}
    return
  }
  try {
    await saveAiKey(typedKey)
    await refreshAi()
    aiStatus.value = {text: `已保存 ${savedKeyMask.value}`, kind: 'ok'}
  } catch (error) {
    aiStatus.value = {text: `保存失败：${error instanceof Error ? error.message : String(error)}`, kind: 'error'}
  }
}

async function onClearKey(): Promise<void> {
  if (!window.confirm('删除 API Key？会同步到其它设备，工具条上的翻译 / 解释按钮也随之消失。')) return
  await saveAiKey('')
  await refreshAi()
  aiStatus.value = {text: '已删除 API Key', kind: 'ok'}
}

onMounted(() => {
  ensurePromptsLoaded()
  void refreshAi()
})
</script>

<template>
  <section class="card">
    <h2>DeepSeek</h2>
    <div class="fields">
      <label class="row">
        <span>API Key</span>
        <input
          v-model="aiKeyDraft"
          class="text"
          type="password"
          autocomplete="off"
          :placeholder="savedKeyMask ? `已保存 ${savedKeyMask}` : 'sk-…'"
        />
      </label>
      <div class="actions">
        <button class="primary" @click="onSaveAi">保存</button>
        <button v-if="savedKeyMask" class="ghost" @click="onClearKey">删除</button>
        <a class="link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">获取 Key</a>
        <span v-if="aiStatus.text" class="status" :class="aiStatus.kind">{{ aiStatus.text }}</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>翻译</h2>
    <div class="fields">
      <label class="row">
        <span>目标语言</span>
        <select v-model="translateLang">
          <option v-for="item in AI_LANGUAGES" :key="item.code" :value="item.code">
            {{ item.name }}
          </option>
        </select>
      </label>
    </div>
  </section>

  <section class="card">
    <h2>提示词</h2>
    <div class="fields">
      <div v-for="action in AI_ACTIONS" :key="action" class="prompt-group">
        <span class="group-label">{{ AI_ACTION_LABEL[action] }}</span>
        <div v-for="field in PROMPT_FIELDS" :key="field.kind" class="prompt-field">
          <div class="prompt-field-head">
            <span class="prompt-caption">{{ field.label }}</span>
            <!-- 分段控件取代两个 radio：状态一眼可见，且不占两倍横向空间。 -->
            <div class="segmented">
              <label :class="{on: settings.aiPromptMode[action][field.kind] === 'default'}">
                <input
                  type="radio"
                  :name="`${action}-${field.kind}`"
                  :checked="settings.aiPromptMode[action][field.kind] === 'default'"
                  @change="setPromptMode(action, field.kind, 'default')"
                />
                默认
              </label>
              <label :class="{on: settings.aiPromptMode[action][field.kind] === 'custom'}">
                <input
                  type="radio"
                  :name="`${action}-${field.kind}`"
                  :checked="settings.aiPromptMode[action][field.kind] === 'custom'"
                  @change="setPromptMode(action, field.kind, 'custom')"
                />
                自定义
              </label>
            </div>
            <span v-if="promptErrors[action][field.kind]" class="status error">
              {{ promptErrors[action][field.kind] }}
            </span>
          </div>
          <textarea
            v-if="settings.aiPromptMode[action][field.kind] === 'custom'"
            v-model="drafts[action][field.kind]"
            :rows="field.rows"
            spellcheck="false"
            :placeholder="SLOT_HINT"
            :aria-label="`${AI_ACTION_LABEL[action]}的${field.label}`"
            @change="savePrompt(action, field.kind)"
          ></textarea>
        </div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>模型行为</h2>
    <div class="fields">
      <label class="row">
        <span>先思考再回答</span>
        <input v-model="aiThinking" type="checkbox" role="switch" />
      </label>
    </div>
  </section>
</template>
