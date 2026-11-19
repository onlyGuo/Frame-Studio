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
import AppearancePicker from './components/AppearancePicker.vue'
import { version } from '../package.json'
const pages = [
  ['overview', 'grid', '项目总览'],
  ['story', 'pen', '剧本写作'],
  ['cards', 'cards', '角色与设定'],
  ['shots', 'shots', '分镜工作台'],
  ['media', 'media', '素材库'],
  ['edit', 'edit', '剪辑台']
]
const title = computed(() => pages.find((p) => p[0] === ui.page)?.[2] || '项目工作台')
// 工具栏可收起以扩大监看区域，窗口恢复时沿用本机布局。
const compactNav = ref(localStorage.getItem('studio.compactNav') === '1')
function toggleNav() {
  compactNav.value = !compactNav.value
  localStorage.setItem('studio.compactNav', compactNav.value ? '1' : '0')
}
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
  if (e.defaultPrevented || e.target.closest?.('dialog[open]')) return
  if (e.key === 'Escape') {
    if (!ui.busy) {
      if (ui.error) ui.error = ''
      else if (ui.modal) ui.modal = ''
      else ui.agent = false
    }
    return
  }
  if (ui.busy || ui.modal) return
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
  <div class="shell" :class="{ 'compact-nav': compactNav }" :inert="!!ui.modal || !!ui.busy">
    <aside class="sidebar">
      <div class="brand" title="帧序 Frame Studio">
        <img class="brand-icon" :src="studioIcon" alt="" />
        <div class="brand-wordmark">
          <b>帧序</b>
          <small>FRAME STUDIO</small>
        </div>
      </div>
      <div class="nav-group">
        <div class="nav-label">工作空间</div>
        <button aria-label="项目工作台" title="项目工作台" :class="{ active: !doc }" @click="home">
          <Glyph name="home" />
          项目工作台
        </button>
      </div>
      <div v-if="doc" class="nav-group">
        <div class="nav-label">当前制作</div>
        <button
          v-for="(p, i) in pages"
          :title="p[2] + ' · Alt+' + (i + 1)"
          :aria-label="p[2]"
          :key="p[0]"
          :class="{ active: ui.page === p[0] }"
          @click="ui.page = p[0]"
        >
          <Glyph :name="p[1]" />
          {{ p[2] }}
        </button>
      </div>
      <div v-else class="nav-group">
        <div class="nav-label">项目操作</div>
        <button title="新建项目" aria-label="新建项目" @click="ui.modal = 'create'">
          <Glyph name="plus" />
          新建项目
        </button>
        <button title="打开目录" aria-label="打开目录" @click="openProject('open')">
          <Glyph name="folder" />
          打开目录
        </button>
      </div>
      <div class="sidebar-bottom">
        <div class="nav-group">
          <div class="nav-label">工作室</div>
          <button title="模型配置" aria-label="模型配置" @click="ui.modal = 'settings'">
            <Glyph name="settings" />
            模型配置
          </button>
          <button title="Skill 管理" aria-label="Skill 管理" @click="ui.modal = 'skills'">
            <Glyph name="skill" />
            Skill 管理
          </button>
          <button v-if="doc" title="命令工作台" aria-label="命令工作台" @click="ui.modal = 'command'">
            <Glyph name="sliders" />
            命令工作台
          </button>
        </div>
        <div class="local">
          <i />
          本地工作室
          <span>{{ version }}</span>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="toolbar">
        <div class="crumb">
          <button
            class="nav-toggle"
            :title="compactNav ? '展开导航' : '收起导航'"
            :aria-label="compactNav ? '展开导航' : '收起导航'"
            @click="toggleNav"
          >
            <Glyph name="panel" :size="17" />
          </button>
          <Glyph name="folder" :size="16" />
          <button @click="home">工作室</button>
          <span>/</span>
          <b :title="ui.root">{{ doc?.title || '项目工作台' }}</b>
          <template v-if="doc">
            <span>/</span>
            {{ title }}
          </template>
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
          <AppearancePicker />
          <template v-if="doc">
            <button class="icon" :disabled="!history.back" title="撤销" @click="travel(false)">
              <Glyph name="undo" :size="15" />
            </button>
            <button class="icon" :disabled="!history.forward" title="重做" @click="travel(true)">
              <Glyph name="redo" :size="15" />
            </button>
            <button class="outline" @click="archive">
              <Glyph name="up" :size="15" />
              工程包
            </button>
          </template>
          <button class="assist-btn" :class="{ on: ui.agent }" @click="ui.agent = !ui.agent">
            <Glyph name="spark" />
            创作助手
            <i v-if="ui.agentRunning" class="run-light" aria-label="执行中" />
          </button>
        </div>
      </header>
      <div v-if="doc" class="project-strip">
        <label class="inline">
          当前分集
          <select :value="episode?.id" @change="ui.episodeId = $event.target.value">
            <option v-for="e in doc.episodes" :key="e.id" :value="e.id">{{ e.title }}</option>
          </select>
        </label>
        <div class="project-status">
          <button class="format-settings" title="工程输出设置" @click="ui.modal = 'project'">
            {{ doc.ratio }}
            <span>·</span>
            {{ doc.quality }}
            <span>·</span>
            {{ doc.fps }} fps
          </button>
          <small>
            <Glyph name="check" :size="13" />
            {{ ui.saved }}
          </small>
        </div>
      </div>
      <div class="body" :class="{ 'assistant-open': ui.agent }">
        <main :key="ui.page">
          <Home v-if="!doc" />
          <Editor v-else-if="ui.page === 'edit'" />
          <Workspace v-else />
        </main>
        <Assistant v-show="ui.agent" />
      </div>
    </div>
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
