<script setup vapor>
import { computed, ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Glyph from '../components/Glyph.vue'
import { ui, openProject, openSettings, manageProject } from '../store.js'
import '../studio.css'
const query = ref('')
const menu = ref(null)
const target = ref(null)
let trigger
function closeMenu(event) {
  if (event?.type === 'pointerdown' && menu.value?.contains(event.target)) return
  if (menu.value?.matches(':popover-open')) menu.value.hidePopover()
}
onMounted(() => {
  window.addEventListener('pointerdown', closeMenu)
  window.addEventListener('blur', closeMenu)
  window.addEventListener('resize', closeMenu)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', closeMenu)
  window.removeEventListener('blur', closeMenu)
  window.removeEventListener('resize', closeMenu)
})
/** 鼠标右键与键盘菜单键共用项目操作入口。 */
function projectMenu(event, project) {
  if (ui.busy) return
  event.preventDefault()
  target.value = project
  trigger = event.currentTarget
  const bounds = trigger.getBoundingClientRect()
  const x = event.type === 'keydown' ? bounds.left + 20 : event.clientX
  const y = event.type === 'keydown' ? bounds.bottom : event.clientY
  nextTick(() => {
    if (!menu.value?.isConnected) return
    menu.value.showPopover()
    menu.value.style.left = Math.max(4, Math.min(x, innerWidth - menu.value.offsetWidth - 4)) + 'px'
    menu.value.style.top = Math.max(4, Math.min(y, innerHeight - menu.value.offsetHeight - 4)) + 'px'
    menu.value.querySelector('button').focus()
  })
}
function menuKey(event) {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const items = [...menu.value.querySelectorAll('button')]
    const index = items.indexOf(document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    menu.value.hidePopover()
    trigger?.focus()
  }
}
function projectKey(event, project) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) projectMenu(event, project)
}
function runAction(action) {
  const root = target.value?.root
  menu.value.hidePopover()
  trigger?.focus()
  if (root) manageProject(root, action)
}
const projects = computed(() =>
  ui.recent.filter((p) => (p.title + ' ' + p.root).toLowerCase().includes(query.value.trim().toLowerCase()))
)
</script>
<template>
  <div class="launcher">
    <aside class="launcher-nav" aria-label="工程面板">
      <div class="launcher-heading">
        <Glyph name="folder" :size="17" />
        <h1>项目工作台</h1>
      </div>
      <button class="launcher-settings" aria-label="模型配置" @click="openSettings">
        <Glyph name="settings" :size="16" />
        设置
      </button>
      <button class="launcher-settings" @click="ui.modal = 'skills'">
        <Glyph name="skill" :size="16" />
        Skill 管理
      </button>
    </aside>
    <section class="home-library" aria-label="最近项目">
      <header class="launcher-tools">
        <label class="sidebar-search">
          <Glyph name="search" :size="15" />
          <input type="search" aria-label="查找项目" placeholder="搜索项目" v-model="query" />
        </label>
        <div class="actions">
          <button class="outline" @click="openProject('restore')">导入工程包</button>
          <button class="outline" @click="openProject('open')">打开目录</button>
          <button class="primary" @click="ui.modal = 'create'">新建项目</button>
        </div>
      </header>
      <div v-if="!ui.recent.length" class="project-empty">
        <Glyph name="film" :size="30" />
        <h2>开始一部短剧</h2>
        <p>新建项目，或打开已有的本地工程目录。</p>
      </div>
      <div v-else-if="!projects.length" class="project-empty">
        <Glyph name="search" :size="24" />
        <h2>未找到匹配的项目</h2>
      </div>
      <div v-else class="home-projects">
        <button
          v-for="p in projects"
          :key="p.root"
          aria-haspopup="menu"
          @click="openProject('recent', { root: p.root })"
          @contextmenu="projectMenu($event, p)"
          @keydown="projectKey($event, p)"
        >
          <span class="project-tile"><Glyph name="film" :size="17" /></span>
          <span class="project-name">
            <b>{{ p.title }}</b>
            <small :title="p.root">{{ p.root }}</small>
          </span>
          <span class="project-ratio">{{ p.ratio }}</span>
          <Glyph name="chevron" :size="13" />
        </button>
      </div>
    </section>
    <div
      ref="menu"
      popover="manual"
      class="timeline-menu project-menu"
      role="menu"
      aria-label="项目操作"
      @keydown="menuKey"
    >
      <button role="menuitem" @click="runAction('remove')">
        <Glyph name="x" :size="15" />
        移除项目
      </button>
      <button role="menuitem" class="menu-danger" @click="runAction('delete')">
        <Glyph name="trash" :size="15" />
        彻底删除项目和文件
      </button>
    </div>
  </div>
</template>
