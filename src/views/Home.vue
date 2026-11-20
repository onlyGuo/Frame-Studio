<script setup vapor>
import { computed, ref } from 'vue'
import Glyph from '../components/Glyph.vue'
import { ui, openProject, openSettings } from '../store.js'
import '../studio.css'
const query = ref('')
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
        <button v-for="p in projects" :key="p.root" @click="openProject('recent', { root: p.root })">
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
  </div>
</template>
