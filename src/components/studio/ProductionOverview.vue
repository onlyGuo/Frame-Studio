<script setup vapor>
import { computed } from 'vue'
import { doc, ui, episode, media, time } from '../../store.js'
import Glyph from '../Glyph.vue'
import FilmArt from '../FilmArt.vue'
defineEmits(['addEpisode'])
/** 工程的生产清单以实际剧本、分镜绑定及剪辑时长为依据。 */
const rows = computed(() =>
  doc.value.episodes.map((part, i) => ({
    id: part.id,
    name: part.title,
    number: String(i + 1).padStart(2, '0'),
    script: part.script.trim().length,
    shots: part.shots.length,
    ready: part.shots.filter((s) => videoIds.value.has(s.assetId)).length,
    duration: part.clips.reduce((n, c) => n + c.duration, 0)
  }))
)
const videoIds = computed(() => new Set(doc.value.assets.filter((a) => a.kind === 'video').map((a) => a.id)))
const cover = computed(() => doc.value.assets.find((a) => a.kind === 'image'))
const recent = computed(() => doc.value.assets.slice(-5).reverse())
const totals = computed(() => ({
  shots: rows.value.reduce((a, e) => a + e.shots, 0),
  ready: rows.value.reduce((a, e) => a + e.ready, 0),
  duration: rows.value.reduce((a, e) => a + e.duration, 0)
}))
/** 保持所选分集，直接进入对应制作环节。 */
function enter(id, page) {
  ui.episodeId = id
  ui.page = page
}
</script>
<template>
  <header class="studio-page-title">
    <div>
      <div class="studio-breadcrumb">{{ doc.title }}</div>
      <h1>创作工作区</h1>
    </div>
    <button class="outline" @click="ui.modal = 'project'">
      <Glyph name="settings" />
      工程设置
    </button>
  </header>
  <div class="production-slate">
    <div class="slate-info">
      <div class="slate-tech">
        <Glyph name="film" :size="15" />
        {{ doc.ratio }}
        <i />
        {{ doc.quality }}
        <i />
        {{ doc.fps }} fps
      </div>
      <h2>{{ doc.title }}</h2>
      <p v-if="doc.synopsis">{{ doc.synopsis }}</p>
      <button v-else class="slate-synopsis" @click="ui.modal = 'project'">
        <Glyph name="pen" :size="14" />
        填写项目梗概
      </button>
    </div>
    <div class="slate-cover">
      <img v-if="cover" :src="media(cover.id)" :alt="cover.name" />
      <FilmArt v-else />
    </div>
  </div>
  <div class="production-stats">
    <button @click="ui.page = 'story'">
      <Glyph name="pen" />
      <span>分集</span>
      <strong>{{ rows.length }}</strong>
    </button>
    <button @click="ui.page = 'shots'">
      <Glyph name="shots" />
      <span>已生成或绑定视频 / 镜头</span>
      <strong>
        {{ totals.ready }}
        <em>/ {{ totals.shots }}</em>
      </strong>
    </button>
    <button @click="ui.page = 'media'">
      <Glyph name="media" />
      <span>工程素材</span>
      <strong>{{ doc.assets.length }}</strong>
    </button>
    <button @click="ui.page = 'edit'">
      <Glyph name="clock" />
      <span>剪辑总时长</span>
      <strong>{{ time(totals.duration) }}</strong>
    </button>
  </div>
  <div class="overview-panels">
    <section class="production-panel">
      <header>
        <h2>分集制作清单</h2>
        <button class="outline" @click="$emit('addEpisode')">
          <Glyph name="plus" :size="15" />
          添加分集
        </button>
      </header>
      <div class="episode-table-scroll">
        <table class="episode-table">
          <thead>
            <tr>
              <th>分集</th>
              <th>剧本</th>
              <th>分镜视频</th>
              <th>剪辑时长</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" :class="{ current: r.id === episode.id }">
              <td>
                <button @click="enter(r.id, 'shots')">
                  <span class="episode-number">{{ r.number }}</span>
                  <b>{{ r.name }}</b>
                </button>
              </td>
              <td>
                <button @click="enter(r.id, 'story')">
                  {{ r.script ? r.script + ' 字' : '开始写作' }}
                  <Glyph name="pen" :size="13" />
                </button>
              </td>
              <td>
                <button @click="enter(r.id, 'shots')">
                  <progress :value="r.ready" :max="r.shots || 1" />
                  {{ r.ready }} / {{ r.shots }}
                </button>
              </td>
              <td>
                <button @click="enter(r.id, 'edit')">
                  {{ time(r.duration) }}
                  <Glyph name="chevron" :size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="production-panel">
      <header>
        <h2>最近素材</h2>
        <button class="text-btn" @click="ui.page = 'media'">
          进入素材库
          <Glyph name="arrow" :size="14" />
        </button>
      </header>
      <div v-if="recent.length" class="production-assets">
        <button v-for="a in recent" :key="a.id" @click="ui.page = 'media'">
          <div class="asset-cover">
            <img v-if="a.kind === 'image'" :src="media(a.id)" loading="lazy" />
            <video v-else-if="a.kind === 'video'" preload="metadata" muted :src="media(a.id)" />
            <Glyph v-else name="audio" />
          </div>
          <span>{{ a.name }}</span>
        </button>
      </div>
      <div v-else class="inline-empty">
        <Glyph name="media" />
        此工程尚无素材。
        <button class="text-btn" @click="ui.page = 'media'">导入或生成素材</button>
      </div>
    </section>
  </div>
</template>
