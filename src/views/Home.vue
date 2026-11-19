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
  ['llm', '对话'],
  ['image', '图像'],
  ['video', '视频']
]
const enabled = (type) =>
  Object.values(ui.config?.profiles || {}).filter((p) => p.group === type && p.configured).length
</script>
<template>
  <div class="page studio-work studio-home">
    <header class="studio-page-title">
      <div><h1>项目工作台</h1></div>
      <div class="actions">
        <button class="outline" @click="openProject('restore')">
          <Glyph name="download" :size="15" />
          导入工程包
        </button>
        <button v-if="ui.recent.length" class="primary" @click="ui.modal = 'create'">
          <Glyph name="plus" :size="15" />
          新建项目
        </button>
      </div>
    </header>
    <div v-if="!ui.recent.length" class="hero home-hero">
      <div class="hero-copy">
        <h2>开始一部短剧</h2>
        <p>选择本地工程目录，开始编剧、分镜与剪辑。</p>
        <div class="actions">
          <button class="lime" @click="ui.modal = 'create'">
            <Glyph name="plus" />
            新建项目
          </button>
          <button class="ghost-dark" @click="openProject('open')">
            <Glyph name="folder" />
            打开项目
          </button>
        </div>
      </div>
      <FilmArt />
    </div>
    <section class="production-panel home-library">
      <header>
        <h2>
          最近项目
          <small>{{ ui.recent.length }}</small>
        </h2>
        <div class="actions">
          <input
            v-if="ui.recent.length"
            class="library-search"
            type="search"
            placeholder="查找项目"
            v-model="query"
            aria-label="查找项目"
          />
          <button v-if="ui.recent.length" class="outline" @click="openProject('open')">
            <Glyph name="folder" :size="15" />
            打开目录
          </button>
        </div>
      </header>
      <div v-if="!projects.length" class="inline-empty">
        <Glyph name="folder" :size="17" />
        {{ query ? '未找到匹配的项目' : '打开过的工程会显示在这里。' }}
      </div>
      <div v-else class="home-projects">
        <button v-for="p in projects" :key="p.root" @click="openProject('recent', { root: p.root })">
          <span class="project-tile"><Glyph name="film" :size="21" /></span>
          <span class="project-name">
            <b>{{ p.title }}</b>
            <small>{{ p.root }}</small>
          </span>
          <span class="project-ratio">{{ p.ratio }}</span>
          <time :datetime="p.date">{{ new Date(p.date).toLocaleDateString() }}</time>
          <Glyph name="chevron" :size="15" />
        </button>
      </div>
    </section>
    <div class="home-setup">
      <section class="production-panel">
        <header>
          <h2>模型服务</h2>
          <button class="text-btn" @click="ui.modal = 'settings'">
            模型配置
            <Glyph name="arrow" :size="13" />
          </button>
        </header>
        <div class="home-services">
          <div v-for="[k, label] in groups" :key="k">
            <i :class="{ configured: enabled(k) > 0 }" />
            <span>{{ label }}</span>
            <small>{{ enabled(k) ? enabled(k) + ' 项已配置' : '未配置' }}</small>
          </div>
        </div>
      </section>
      <section class="production-panel">
        <header>
          <h2>创作能力</h2>
          <button class="text-btn" @click="ui.modal = 'skills'">
            Skill 管理
            <Glyph name="arrow" :size="13" />
          </button>
        </header>
        <div class="skill-summary">
          <Glyph name="skill" />
          <b>{{ ui.skills.filter((s) => s.enabled).length }}</b>
          项已启用
          <span>共 {{ ui.skills.length }} 项</span>
        </div>
      </section>
    </div>
  </div>
</template>
