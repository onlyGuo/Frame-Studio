<script setup vapor>
import { computed } from 'vue'
import { api, ui, error } from '../store.js'
import Glyph from './Glyph.vue'

const modes = [
  { id: 'system', title: '跟随系统', icon: 'display' },
  { id: 'light', title: '浅色', icon: 'sun' },
  { id: 'dark', title: '深色', icon: 'moon' }
]
const current = computed(() => modes.find((m) => m.id === ui.config?.appearance) || modes[0])
/** 应用外观交由 Electron 切换，系统窗口和网页会同时响应。 */
async function choose(event) {
  try {
    const { mode, dark } = await api.appearance({ mode: event.target.value })
    ui.config.appearance = mode
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  } catch (err) {
    event.target.value = current.value.id
    error(err)
  }
}
</script>
<template>
  <label class="appearance-picker" :title="'外观 · ' + current.title">
    <Glyph :name="current.icon" :size="17" />
    <select aria-label="外观模式" :value="current.id" :disabled="!ui.config" @change="choose">
      <option v-for="mode in modes" :key="mode.id" :value="mode.id">{{ mode.title }}</option>
    </select>
  </label>
</template>
