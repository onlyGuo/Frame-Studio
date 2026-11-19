<script setup vapor>
import { computed } from 'vue'
import { api, ui, error } from '../store.js'
import StudioSelect from './StudioSelect.vue'

const modes = [
  { value: 'system', label: '跟随系统', icon: 'display' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '暗色', icon: 'moon' }
]
const current = computed(() => modes.find((mode) => mode.value === ui.config?.appearance) || modes[2])
/** 应用外观交由 Electron 切换，系统窗口和工作区同时响应。 */
async function choose(mode) {
  try {
    const result = await api.appearance({ mode })
    ui.config.appearance = result.mode
    document.documentElement.dataset.theme = result.dark ? 'dark' : 'light'
  } catch (err) {
    error(err)
  }
}
</script>
<template>
  <StudioSelect
    class="appearance-picker"
    aria-label="外观模式"
    title="外观模式"
    :icon="current.icon"
    :model-value="current.value"
    :options="modes"
    :disabled="!ui.config"
    @update:model-value="choose"
  />
</template>
