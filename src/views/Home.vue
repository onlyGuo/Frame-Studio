<script setup vapor>
import { computed, ref } from 'vue'
import Glyph from '../components/Glyph.vue'
import FilmArt from '../components/FilmArt.vue'
import { ui, openProject } from '../store.js'
import '../studio.css'
const query = ref('')
const projects = computed(() =>
  ui.recent.filter((p) => (p.title + ' ' + p.root).toLowerCase().includes(query.value.trim().toLowerCase()))
)
const groups = [
  ['llm', '对话', 'chat', 'violet'],
  ['image', '图像', 'media', 'teal'],
  ['video', '视频', 'film', 'rose']
]
const enabled = (type) =>
  Object.values(ui.config?.profiles || {}).filter((p) => p.group === type && p.configured).length
</script>
<template>
  <div class="page studio-work studio-home">
    <header class="studio-page-title">
      <h1>项目工作台</h1>
      <div class="actions">
        <button class="outline" @click="openProject('restore')">
          <Glyph name="download" :size="15" />
          导入工程包
        </button>
        <button class="outline" @click="openProject('open')">
          <Glyph name="folder" :size="15" />
          打开目录
        </button>
        <button class="primary" @click="ui.modal = 'create'">
          <Glyph name="plus" :size="15" />
          新建项目
        </button>
      </div>
    </header>
    <section class="production-panel home-library">
      <header>
        <h2>
          最近项目
          <small>{{ ui.recent.length }}</small>
        </h2>
        <label v-if="ui.recent.length" class="project-search">
          <Glyph name="search" :size="15" />
          <input class="library-search" placeholder="查找项目" v-model="query" aria-label="查找项目" />
        </label>
      </header>
      <div class="project-list-heading" v-if="ui.recent.length" aria-hidden="true">
        <span>名称与位置</span>
        <span>画幅</span>
        <span>最后打开</span>
      </div>
      <div v-if="!ui.recent.length" class="project-empty project-welcome">
        <div class="project-welcome-copy">
          <span class="project-welcome-icon" aria-hidden="true"><Glyph name="film" :size="23" /></span>
          <h2>开始一部短剧</h2>
          <p>新建项目，或打开已有的本地工程目录。</p>
        </div>
        <div class="project-welcome-art" aria-hidden="true"><FilmArt /></div>
      </div>
      <div v-else-if="!projects.length" class="project-empty">
        <Glyph name="search" :size="30" />
        <h2>未找到匹配的项目</h2>
      </div>
      <div v-else class="home-projects">
        <button v-for="p in projects" :key="p.root" @click="openProject('recent', { root: p.root })">
          <span class="project-tile"><Glyph name="film" :size="17" /></span>
          <span class="project-name">
            <b>{{ p.title }}</b>
            <small :title="p.root">{{ p.root }}</small>
          </span>
          <span class="project-ratio">{{ p.ratio }}</span>
          <time :datetime="p.date">{{ new Date(p.date).toLocaleDateString() }}</time>
          <Glyph name="chevron" :size="13" />
        </button>
      </div>
    </section>
    <section class="production-panel home-setup">
      <header><h2>工作室状态</h2></header>
      <div class="home-services">
        <div v-for="[kind, label, icon, tone] in groups" :key="kind" :data-tone="tone">
          <Glyph :name="icon" :size="15" />
          <span>{{ label }}</span>
          <small :class="{ configured: enabled(kind) > 0 }">
            {{ enabled(kind) ? enabled(kind) + ' 项已配置' : '未配置' }}
          </small>
        </div>
        <div data-tone="amber">
          <Glyph name="skill" :size="15" />
          <span>Skill</span>
          <small>{{ ui.skills.filter((s) => s.enabled).length }} / {{ ui.skills.length }} 已启用</small>
        </div>
      </div>
    </section>
  </div>
</template>
