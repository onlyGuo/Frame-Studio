<script setup vapor>
import studioIcon from './assets/studio-icon.svg'
import { computed, onMounted, onBeforeUnmount, watch } from 'vue'
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
  travel,
  history,
  archive,
  error
} from './store.js'
import { captionImage } from './captions.js'
import Glyph from './components/Glyph.vue'
import Home from './views/Home.vue'
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
  ['cards', 'cards', '角色与设定', 'amber'],
  ['shots', 'shots', '分镜工作台', 'rose'],
  ['media', 'media', '素材库', 'teal'],
  ['edit', 'edit', '剪辑台', 'violet']
]
const currentPage = computed(() => pages.find((p) => p[0] === ui.page))
let offClose,
  offProgress,
  offCaptions,
  offAgent,
  offBatch,
  offAppearance,
  closeRequested = false
/** 关闭时先提交当前输入，等待正在执行的任务完成取消并刷新工程。 */
async function finishClose() {
  if (!closeRequested || ui.busy || ui.agentRunning || ui.videoBatch?.status === 'running') return
  closeRequested = false
  try {
    document.activeElement?.blur?.()
    await flush()
    await api.closeReady()
  } catch (err) {
    error(err)
  }
}
watch(() => [ui.busy, ui.agentRunning, ui.videoBatch?.status], finishClose)
function key(e) {
  if (e.defaultPrevented || ui.modal || e.target.closest?.('dialog[open]')) return
  if (e.key === 'Escape') {
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
onMounted(async () => {
  try {
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
  } catch (err) {
    error(err)
  }
  window.addEventListener('keydown', key)
})
onBeforeUnmount(() => {
  offClose?.()
  offProgress?.()
  offCaptions?.()
  offAgent?.()
  offBatch?.()
  offAppearance?.()
  window.removeEventListener('keydown', key)
})
</script>
<template>
  <div class="shell" :inert="!!ui.modal || !!ui.busy">
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
        <AppearancePicker />
        <button
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
      <aside class="sidebar" aria-label="工作室导航">
        <nav class="nav-group" aria-label="工作空间">
          <button
            aria-label="项目工作台"
            data-hint="项目工作台"
            :aria-current="!doc || !currentPage ? 'page' : undefined"
            @click="home"
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
          <button data-hint="模型配置" aria-label="模型配置" @click="ui.modal = 'settings'">
            <Glyph name="settings" :size="19" />
          </button>
        </nav>
      </aside>
      <div class="main">
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
            <Home v-if="ui.page === 'home' || !doc" />
            <Editor v-else-if="ui.page === 'edit'" />
            <Workspace v-else />
          </main>
          <Assistant v-show="ui.agent" id="studio-assistant" />
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
  <div v-if="ui.modal" :inert="!!ui.busy"><Dialogs /></div>
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
