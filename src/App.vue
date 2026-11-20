<script setup vapor>
import studioIcon from './assets/studio-icon.svg'
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import {
  ui,
  doc,
  episode,
  api,
  accept,
  agentUpdate,
  setAgent,
  videoBatchUpdate,
  cancelAgent,
  flush,
  home,
  openProject,
  openSettings,
  travel,
  history,
  archive,
  error
} from './store.js'
import { captionImage } from './captions.js'
import Glyph from './components/Glyph.vue'
import Home from './views/Home.vue'
import Settings from './views/Settings.vue'
import Workspace from './views/Workspace.vue'
import Editor from './views/Editor.vue'
import Dialogs from './components/Dialogs.vue'
import Assistant from './components/Assistant.vue'
import StudioSelect from './components/StudioSelect.vue'
import AppearancePicker from './components/AppearancePicker.vue'
import { version } from '../package.json'
const pages = [
  ['overview', 'grid', '项目总览'],
  ['story', 'pen', '剧本写作', 'violet'],
  ['cards', 'cards', '资产', 'amber'],
  ['shots', 'shots', '分镜工作台', 'rose'],
  ['media', 'media', '素材库', 'teal'],
  ['edit', 'edit', '剪辑台', 'violet']
]
const windowRole = ref('')
const closingSettings = ref(false)
const displayedModal = ref(ui.modal)
let modalTimer
watch(
  () => ui.modal,
  (value) => {
    clearTimeout(modalTimer)
    if (value) displayedModal.value = value
    else
      modalTimer = setTimeout(
        () => {
          displayedModal.value = ''
        },
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160
      )
  },
  { flush: 'sync' }
)
const currentPage = computed(() => pages.find((p) => p[0] === ui.page))
let offClose,
  offProgress,
  offCaptions,
  offAgent,
  offBatch,
  offAppearance,
  offRecent,
  offConfiguration,
  offOpenProject,
  closeRequested = false
/** 关闭时先提交当前输入，等待正在执行的任务完成取消并刷新工程。 */
async function finishClose() {
  if (!closeRequested || ui.busy || ui.agentRunning || ui.videoBatch?.status === 'running') return
  closeRequested = false
  try {
    document.activeElement?.blur?.()
    await flush()
    if (
      windowRole.value === 'settings' &&
      window.matchMedia('(prefers-reduced-motion: no-preference)').matches
    ) {
      if (closingSettings.value) return
      closingSettings.value = true
      await new Promise((resolve) => setTimeout(resolve, 160))
    }
    await api.closeReady()
  } catch (err) {
    error(err)
  }
}
watch(() => [ui.busy, ui.agentRunning, ui.videoBatch?.status], finishClose)
function key(e) {
  if (e.defaultPrevented || ui.modal || e.target.closest?.('dialog[open]')) return
  if (e.key === 'Escape') {
    if (windowRole.value === 'settings' && !ui.busy) {
      api.closeWindow().catch(error)
      return
    }
    if (!ui.busy) {
      if (ui.error) ui.error = ''
      else ui.agent = false
    }
    return
  }
  if (ui.busy) return
  const section = e.altKey && /^Digit[1-6]$/.test(e.code) && doc.value && pages[Number(e.code.slice(-1)) - 1]
  if (section) {
    e.preventDefault()
    ui.page = section[0]
    return
  }
  if (!(e.ctrlKey || e.metaKey)) return
  if (e.key === 's') {
    e.preventDefault()
    flush().catch(error)
  }
  if (e.key === 'z' && !e.target.closest('input,textarea,[contenteditable]')) {
    e.preventDefault()
    travel(e.shiftKey)
  }
  if (e.key === 'k') {
    e.preventDefault()
    ui.agent = !ui.agent
  }
}
/** 窗口切到后台时降低外壳工具的强调程度。 */
function syncWindowFocus() {
  document.documentElement.toggleAttribute('data-window-inactive', !document.hasFocus())
}
onMounted(async () => {
  syncWindowFocus()
  window.addEventListener('focus', syncWindowFocus)
  window.addEventListener('blur', syncWindowFocus)
  try {
    offConfiguration = api.onConfiguration(({ config, skills }) => {
      ui.config = config
      ui.skills = skills
    })
    offRecent = api.onRecent((recent) => {
      ui.recent = recent
    })
    offOpenProject = api.onOpenProject(({ method, payload }) => openProject(method, payload))
    let reconnect = []
    let pendingBatches = []
    offAppearance = api.onAppearance(
      (dark) => (document.documentElement.dataset.theme = dark ? 'dark' : 'light')
    )
    offBatch = api.onVideoBatch((update) =>
      pendingBatches ? pendingBatches.push(update) : videoBatchUpdate(update)
    )
    offAgent = api.onAgentEvent((update) => (reconnect ? reconnect.push(update) : agentUpdate(update)))
    const data = await api.initial()
    windowRole.value = data.windowRole
    setAgent(data.agentTask)
    ui.videoBatch = data.videoBatch
    ui.recent = data.recent
    ui.config = data.config
    document.documentElement.dataset.theme = data.darkMode ? 'dark' : 'light'
    ui.skills = data.skills
    if (data.current) accept(data.current)
    for (const update of reconnect) agentUpdate(update)
    reconnect = null
    for (const update of pendingBatches) videoBatchUpdate(update)
    pendingBatches = null
    offProgress = api.onProgress((label) => (ui.busy = label))
    offCaptions = api.onCaptions(async ({ id, rows, ratio, quality }) => {
      const images = Object.fromEntries(
        rows.map((r) => [r.id, captionImage(r.caption, ratio, quality).split(',')[1]])
      )
      await api.captionResult({ id, images })
    })

    offClose = api.onClose(async () => {
      closeRequested = true
      if (ui.agentRunning) await cancelAgent()
      if (ui.videoBatch?.status === 'running') await api.cancelVideoBatch({ id: ui.videoBatch.id })
      if (ui.canCancel) await api.cancel()
      await finishClose()
    })
    await api.closeListenerReady()
  } catch (err) {
    error(err)
  }
  window.addEventListener('keydown', key)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', syncWindowFocus)
  window.removeEventListener('blur', syncWindowFocus)
  clearTimeout(modalTimer)
  offClose?.()
  offProgress?.()
  offCaptions?.()
  offAgent?.()
  offBatch?.()
  offAppearance?.()
  offRecent?.()
  offConfiguration?.()
  offOpenProject?.()
  window.removeEventListener('keydown', key)
})
</script>
<template>
  <div
    v-if="windowRole === 'settings'"
    class="shell settings-shell"
    :class="{ 'settings-closing': closingSettings }"
    :inert="!!ui.busy || closingSettings"
  >
    <header class="toolbar">
      <div class="brand">
        <Glyph name="settings" :size="17" />
        <span>设置</span>
      </div>
      <div class="actions">
        <button class="icon" title="关闭设置" aria-label="关闭" @click="api.closeWindow().catch(error)">
          <Glyph name="x" :size="16" />
        </button>
      </div>
    </header>
    <Settings v-if="ui.config" />
  </div>
  <div
    v-else
    class="shell"
    :class="{ 'launcher-shell': windowRole === 'home' }"
    :inert="!!displayedModal || !!ui.busy"
  >
    <header class="toolbar">
      <div class="window-title">
        <div class="brand" title="帧序 Frame Studio">
          <img class="brand-icon" :src="studioIcon" alt="" />
          <span>帧序</span>
        </div>
        <div v-if="doc && currentPage" class="window-project">
          <Glyph name="folder" :size="15" />
          <b :title="ui.root">{{ doc.title }}</b>
          <span class="window-section" :data-tone="currentPage[3]">
            <Glyph name="chevron" :size="11" />
            {{ currentPage[2] }}
          </span>
        </div>
      </div>
      <div class="actions">
        <div
          v-if="ui.videoBatch?.status === 'running'"
          class="batch-progress"
          role="status"
          :title="ui.videoBatch.title + ' · ' + ui.videoBatch.shotTitle"
        >
          <span class="spinner" />
          分镜视频 {{ ui.videoBatch.done + ui.videoBatch.skipped }}/{{ ui.videoBatch.total }}
          <button
            @click="api.cancelVideoBatch({ id: ui.videoBatch.id })"
            aria-label="停止分镜批量生成"
            title="停止生成"
          >
            <Glyph name="x" :size="13" />
          </button>
        </div>
        <template v-if="doc && currentPage">
          <div class="toolbar-group">
            <button
              class="icon"
              :disabled="!history.back"
              title="撤销"
              aria-label="撤销"
              @click="travel(false)"
            >
              <Glyph name="undo" :size="16" />
            </button>
            <button
              class="icon"
              :disabled="!history.forward"
              title="重做"
              aria-label="重做"
              @click="travel(true)"
            >
              <Glyph name="redo" :size="16" />
            </button>
            <button class="icon" title="工程包" aria-label="工程包" @click="archive">
              <Glyph name="up" :size="16" />
            </button>
          </div>
        </template>
        <button v-if="doc" class="icon" aria-label="关闭工程" title="关闭工程" @click="api.closeWindow()">
          <Glyph name="x" :size="16" />
        </button>
        <AppearancePicker />
        <button
          v-if="doc"
          class="assist-btn"
          data-tone="violet"
          aria-controls="studio-assistant"
          aria-keyshortcuts="Control+K Meta+K"
          :aria-pressed="ui.agent"
          @click="ui.agent = !ui.agent"
        >
          <Glyph name="spark" :size="17" />
          创作助手
          <i v-if="ui.agentRunning" class="run-light" aria-label="执行中" />
        </button>
      </div>
    </header>
    <div class="workbench">
      <aside v-if="doc" class="sidebar" aria-label="工作室导航">
        <nav class="nav-group" aria-label="工作空间">
          <button
            aria-label="项目工作台"
            data-hint="项目工作台"
            :aria-current="!doc || !currentPage ? 'page' : undefined"
            @click="doc && home()"
          >
            <Glyph name="home" :size="19" />
          </button>
        </nav>
        <nav v-if="doc && currentPage" class="nav-group" aria-label="当前制作">
          <button
            v-for="(p, i) in pages"
            :key="p[0]"
            :data-tone="p[3]"
            :data-hint="p[2] + ' · Alt+' + (i + 1)"
            :aria-label="p[2]"
            :aria-current="ui.page === p[0] ? 'page' : undefined"
            @click="ui.page = p[0]"
          >
            <Glyph :name="p[1]" :size="19" />
          </button>
        </nav>
        <nav class="nav-group sidebar-bottom" aria-label="工作室工具">
          <button
            v-if="doc && currentPage"
            data-hint="命令工作台"
            aria-label="命令工作台"
            data-tone="teal"
            @click="ui.modal = 'command'"
          >
            <Glyph name="terminal" :size="19" />
          </button>
          <button
            data-hint="Skill 管理"
            aria-label="Skill 管理"
            data-tone="amber"
            @click="ui.modal = 'skills'"
          >
            <Glyph name="skill" :size="19" />
          </button>
          <button data-hint="模型配置" aria-label="模型配置" @click="openSettings">
            <Glyph name="settings" :size="19" />
          </button>
        </nav>
      </aside>
      <div class="main" :class="{ 'with-directory': doc && ['cards', 'shots'].includes(ui.page) }">
        <div v-if="doc && currentPage" class="project-strip">
          <label class="inline episode-picker">
            当前分集
            <StudioSelect
              aria-label="当前分集"
              :model-value="episode?.id"
              :options="doc.episodes.map((e) => ({ value: e.id, label: e.title }))"
              @update:model-value="ui.episodeId = $event"
            />
          </label>
        </div>
        <div class="body" :class="{ 'assistant-open': ui.agent }">
          <main :key="ui.page">
            <Home v-if="windowRole === 'home'" />
            <Editor v-else-if="ui.page === 'edit'" />
            <Workspace v-else-if="doc" />
          </main>
          <Assistant v-if="doc" v-show="ui.agent" id="studio-assistant" />
        </div>
      </div>
    </div>
    <footer class="status-bar">
      <span>
        <i />
        本地工作室
        <span class="studio-version">{{ version }}</span>
      </span>
      <div v-if="doc && currentPage" class="project-status">
        <span role="status">
          <Glyph name="check" :size="12" />
          {{ ui.saved }}
        </span>
        <button class="format-settings" title="工程输出设置" @click="ui.modal = 'project'">
          {{ doc.ratio }} · {{ doc.quality }} · {{ doc.fps }} fps
        </button>
      </div>
    </footer>
  </div>
  <div v-if="displayedModal" :inert="!!ui.busy"><Dialogs :modal="displayedModal" :leaving="!ui.modal" /></div>
  <div v-if="ui.busy" class="job" role="status">
    <div>
      <i class="spinner" />
      {{ ui.busy }}
      <button v-if="ui.canCancel" class="outline" @click="api.cancel()">取消</button>
    </div>
  </div>
  <div class="toast error" v-if="ui.error" role="alert">
    <span>{{ ui.error }}</span>
    <button class="icon" @click="ui.error = ''"><Glyph name="x" /></button>
  </div>
  <div v-else-if="ui.notice" class="toast" role="status">
    <Glyph name="check" />
    {{ ui.notice }}
  </div>
</template>
