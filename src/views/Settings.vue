<script setup vapor>
import { computed, ref } from 'vue'
import { api, notify, perform, ui } from '../store.js'
import StudioSelect from '../components/StudioSelect.vue'
import AppearancePicker from '../components/AppearancePicker.vue'
import AgentPreferences from '../components/AgentPreferences.vue'
import Glyph from '../components/Glyph.vue'

const group = ref('llm')
const profile = ref('')
const form = ref({})
const key = ref('')
const use = ref(true)
const settingsGroups = [
  ['llm', '语言模型', 'chat'],
  ['image', '图像生成', 'media'],
  ['video', '视频生成', 'film'],
  ['audio', '声音生成', 'audio'],
  ['agent', '助手运行', 'spark'],
  ['appearance', '外观', 'display']
]
const profileOptions = computed(() =>
  Object.entries(ui.config.profiles)
    .filter(([, p]) => p.group === group.value)
    .map(([value, p]) => ({
      value,
      label:
        p.label +
        (p.group !== 'llm' && p.ready ? ' · 已配置' : '') +
        (ui.config.mediaDefaults[p.group] === value ? ' · 默认' : '')
    }))
)
function pick(id) {
  profile.value = id
  form.value = { ...ui.config.profiles[id] }
  key.value = ''
  const selected = group.value === 'llm' ? ui.config.llm : ui.config.mediaDefaults[group.value]
  use.value = selected === id || (group.value !== 'llm' && !selected)
}
function selectGroup(g) {
  group.value = g
  if (g === 'agent' || g === 'appearance') return
  const selected = g === 'llm' ? ui.config.llm : ui.config.mediaDefaults[g]
  pick(selected || Object.keys(ui.config.profiles).find((id) => ui.config.profiles[id].group === g))
}
function saveSettings(clear = false) {
  return perform('正在保存配置', async () => {
    ui.config = await api.settings({
      id: profile.value,
      url: form.value.url,
      model: form.value.model,
      key: clear ? '' : key.value || undefined,
      secretId: form.value.secretId,
      region: form.value.region,
      steps: form.value.steps,
      active: use.value
    })
    pick(profile.value)
    notify(clear ? '凭据已清除' : '模型配置已保存')
  })
}
selectGroup('llm')
</script>
<template>
  <div class="settings-workspace">
    <nav class="settings-nav" aria-label="模型配置分类">
      <button
        v-for="[id, label, icon] in settingsGroups"
        :key="id"
        :aria-current="group === id ? 'true' : undefined"
        @click="selectGroup(id)"
      >
        <Glyph :name="icon" :size="16" />
        {{ label }}
      </button>
    </nav>
    <main class="settings-form">
      <h3 class="settings-heading">{{ settingsGroups.find(([id]) => id === group)?.[1] }}</h3>
      <AgentPreferences v-if="group === 'agent'" />
      <div v-else-if="group === 'appearance'" class="form-stack">
        <label>
          外观模式
          <AppearancePicker />
        </label>
      </div>
      <form v-else class="form-stack" @submit.prevent="saveSettings(false)">
        <label>
          服务协议
          <StudioSelect
            aria-label="服务协议"
            :model-value="profile"
            :options="profileOptions"
            @update:model-value="pick"
          />
        </label>
        <label>
          API 基础地址
          <input v-model="form.url" type="url" required spellcheck="false" />
        </label>
        <label v-if="profile !== 'hunyuan-image'">
          模型名称
          <input v-model="form.model" required />
        </label>
        <label v-if="profile === 'vllm-h3'">
          推理步数
          <input v-model.number="form.steps" type="number" min="1" step="1" required />
        </label>
        <label v-if="profile === 'hunyuan-image'">
          SecretId
          <input v-model="form.secretId" required />
        </label>
        <label>
          {{ profile === 'hunyuan-image' ? 'SecretKey' : 'API Key' }}
          <input
            type="password"
            autocomplete="new-password"
            v-model="key"
            :placeholder="
              form.configured
                ? '已保存，留空保留原凭据'
                : profile === 'vllm-h3'
                  ? '服务启用鉴权时填写'
                  : '输入密钥'
            "
          />
        </label>
        <label class="inline">
          <input type="checkbox" v-model="use" />
          {{
            group === 'llm'
              ? '设为创作助手使用的协议'
              : '设为默认' + { image: '图像', video: '视频', audio: '声音' }[group] + '生成服务'
          }}
        </label>
        <p v-if="group !== 'llm'" class="hint">
          创作助手按媒体类型使用默认模型。凭据仅在生成命令执行期间注入。
        </p>
        <div class="modal-actions">
          <button type="button" v-if="form.configured" class="outline" @click="saveSettings(true)">
            清除凭据
          </button>
          <button class="primary">保存配置</button>
        </div>
      </form>
    </main>
  </div>
</template>
