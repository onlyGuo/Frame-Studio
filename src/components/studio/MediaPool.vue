<script setup vapor>
import MediaPreview from '../MediaPreview.vue'
import StudioSelect from '../StudioSelect.vue'
import { computed, ref, watch } from 'vue'
import {
  api,
  accept,
  doc,
  ui,
  episode,
  edit,
  editEpisode,
  media,
  generate,
  importMedia,
  perform,
  notify,
  time
} from '../../store.js'
import { bindShotMedia } from '../../../shared/shot-media.mjs'
import { makeClip, makeAudio, makeShot } from '../../../shared/model.mjs'
import Glyph from '../Glyph.vue'

const types = { all: '全部', image: '图像', video: '视频', audio: '音频' }
const kindIcon = { image: 'media', video: 'film', audio: 'audio' }
const search = ref(''),
  type = ref('all'),
  usage = ref('all'),
  sort = ref('recent'),
  layout = ref('grid')
const selected = ref(''),
  dimensions = ref(''),
  targetShot = ref('')
const unavailable = ref(new Set())
const recovered = ref(0)

/** 预览失效时可找回同一原图，所有镜头继续指向原素材 ID。 */
async function recoverImage() {
  const id = chosen.value.id
  await perform('正在找回原图', async () => {
    const state = await api.recoverImage({ session: ui.session, id })
    if (state) {
      accept(state)
      unavailable.value.delete(id)
      recovered.value++
      notify('原图已恢复，关联分镜可继续使用')
    }
  })
}
/** 建立素材在分集、分镜和设定卡中的反向索引，筛选和检查器共用。 */
const references = computed(() => {
  const index = new Map()
  function record(id, page, part, name, shotId) {
    if (!id) return
    if (!index.has(id)) index.set(id, [])
    index.get(id).push({ page, episodeId: part?.id, title: part?.title, name, shotId })
  }
  for (const part of doc.value.episodes) {
    for (const s of part.shots) {
      record(s.assetId, 'shots', part, s.title, s.id)
      if (s.referenceId !== s.assetId) record(s.referenceId, 'shots', part, s.title + ' · 参考图', s.id)
    }
    part.clips.forEach((c, i) => record(c.assetId, 'edit', part, '画面片段 ' + (i + 1)))
    part.audio.forEach((c, i) => record(c.assetId, 'edit', part, '音频片段 ' + (i + 1)))
  }
  doc.value.cards.forEach((c) => {
    if (c.outfits) c.outfits.forEach((o) => record(o.assetId, 'cards', null, c.name + ' · ' + o.name))
    else record(c.assetId, 'cards', null, c.name)
  })
  return index
})
/** 素材库和分镜共用同一份视频，归属从工程中的实际引用推导。 */
const shotVideos = computed(
  () => new Set(doc.value.episodes.flatMap((part) => part.shots.map((s) => s.assetId)))
)
function matchesUsage(asset) {
  if (usage.value === 'unbound-video') return asset.kind === 'video' && !shotVideos.value.has(asset.id)
  if (usage.value === 'used') return references.value.has(asset.id)
  if (usage.value === 'unused') return !references.value.has(asset.id)
  return true
}
const visible = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase()
  const list = doc.value.assets.filter((a) => {
    return (
      (type.value === 'all' || type.value === a.kind) &&
      matchesUsage(a) &&
      (!needle || (a.name + ' ' + a.ext).toLocaleLowerCase().includes(needle))
    )
  })
  if (sort.value === 'name')
    return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  if (sort.value === 'duration') return list.sort((a, b) => b.duration - a.duration)
  return list.reverse()
})
const chosen = computed(() => visible.value.find((a) => a.id === selected.value) || visible.value[0])
const links = computed(() => references.value.get(chosen.value?.id) || [])
const boundShot = computed(() =>
  episode.value?.shots.find((s) => s.id === targetShot.value && s.assetId === chosen.value?.id)
)
const showAll = ref(false)
const visibleLinks = computed(() => (showAll.value ? links.value : links.value.slice(0, 6)))
watch(
  [() => chosen.value?.id, () => episode.value?.id],
  () => {
    targetShot.value = episode.value?.shots.find((s) => s.assetId === chosen.value?.id)?.id || ''
    dimensions.value = ''
    showAll.value = false
  },
  { immediate: true }
)
/** 在预览载入后读取媒体的实际分辨率。 */
function readDimensions(el) {
  const w = el.naturalWidth || el.videoWidth,
    h = el.naturalHeight || el.videoHeight
  if (w && h) dimensions.value = w + ' × ' + h
}
function rename(input) {
  const id = chosen.value?.id
  if (!id) return
  if (
    !edit((d) => {
      d.assets.find((a) => a.id === id).name = input.value.trim()
    })
  )
    input.value = chosen.value.name
}
function clearFilters() {
  search.value = ''
  type.value = 'all'
  usage.value = 'all'
}
/** 将所选素材加入当前分集，再即时更新工程中的引用清单。 */
function append() {
  const a = chosen.value
  if (!a) return
  if (
    editEpisode((e) => {
      if (a.kind === 'audio') e.audio.push(makeAudio(a.id, a.duration || 5))
      else e.clips.push(makeClip(a.id, a.duration || 5))
    })
  )
    notify('已加入「' + episode.value.title + '」时间线')
}
/** 已生成或导入的视频可直接认领为分镜，无需再次生成、复制文件或修改原剪辑。 */
function adoptVideo() {
  const a = chosen.value
  if (a?.kind !== 'video') return
  if (boundShot.value) {
    ui.shotId = boundShot.value.id
    ui.page = 'shots'
    return
  }
  const episodeId = episode.value.id
  let shotId
  if (
    !edit((d) => {
      const ep = d.episodes.find((e) => e.id === episodeId)
      let shot = ep.shots.find((s) => s.id === targetShot.value)
      if (!shot) {
        shot = makeShot()
        shot.title = a.name.slice(0, 200)
        shot.duration = a.duration || 5
        ep.shots.push(shot)
      }
      bindShotMedia(shot, a, d.assets)
      shotId = shot.id
    })
  )
    return
  ui.shotId = shotId
  ui.page = 'shots'
  notify('已绑定视频并打开分镜')
}
function openRef(link) {
  if (link.shotId) ui.shotId = link.shotId
  if (link.episodeId) ui.episodeId = link.episodeId
  ui.page = link.page
}
</script>
<template>
  <header class="studio-page-title">
    <div>
      <div class="studio-breadcrumb">{{ doc.title }}</div>
      <h1>素材库</h1>
    </div>
    <div class="actions">
      <button class="outline" @click="generate()">
        <Glyph name="spark" />
        生成素材
      </button>
      <button class="primary" @click="importMedia">
        <Glyph name="up" />
        导入素材
      </button>
    </div>
  </header>
  <div class="production-panel media-pool">
    <header class="pool-toolbar">
      <div class="pool-types" aria-label="素材类型">
        <button
          v-for="(label, key) in types"
          :key="key"
          :class="{ chosen: type === key }"
          :aria-pressed="type === key"
          @click="type = key"
        >
          {{ label }}
        </button>
      </div>
      <div class="pool-search">
        <Glyph name="search" :size="15" />
        <input type="search" aria-label="搜索素材" placeholder="搜索素材" v-model="search" />
      </div>
    </header>
    <div class="pool-body">
      <div class="pool-collection">
        <div class="pool-sort">
          <span>{{ visible.length }} 项</span>
          <StudioSelect
            v-model="usage"
            aria-label="素材使用情况"
            :options="[
              { value: 'all', label: '全部使用状态' },
              { value: 'used', label: '已使用' },
              { value: 'unused', label: '未使用' },
              { value: 'unbound-video', label: '未绑定分镜的视频' }
            ]"
          />
          <StudioSelect
            v-model="sort"
            aria-label="素材排序"
            :options="[
              { value: 'recent', label: '最近添加' },
              { value: 'name', label: '名称排序' },
              { value: 'duration', label: '时长优先' }
            ]"
          />
          <div class="pool-layout">
            <button title="缩略图视图" :aria-pressed="layout === 'grid'" @click="layout = 'grid'">
              <Glyph name="grid" :size="14" />
            </button>
            <button title="列表视图" :aria-pressed="layout === 'list'" @click="layout = 'list'">
              <Glyph name="list" :size="15" />
            </button>
          </div>
        </div>
        <div v-if="visible.length" class="pool-items" :class="{ rows: layout === 'list' }">
          <button
            v-for="a in visible"
            :key="a.id"
            class="pool-item"
            :class="{ chosen: chosen?.id === a.id }"
            :aria-pressed="chosen?.id === a.id"
            @click="selected = a.id"
          >
            <div class="pool-thumb">
              <img v-if="a.kind === 'image'" :key="recovered" :src="media(a.id)" loading="lazy" alt="" />
              <video v-else-if="a.kind === 'video'" :src="media(a.id)" muted preload="metadata"></video>
              <Glyph v-else name="audio" :size="28" />
              <span v-if="a.duration" class="pool-duration">{{ time(a.duration) }}</span>
            </div>
            <div class="pool-item-label">
              <b>{{ a.name }}</b>
              <small>
                {{ a.kind === 'video' ? (shotVideos.has(a.id) ? '分镜视频' : '未绑定分镜') : types[a.kind] }}
                · {{ a.ext.slice(1).toUpperCase() }}
              </small>
            </div>
            <small class="pool-row-usage">{{ references.has(a.id) ? '已使用' : '未使用' }}</small>
          </button>
        </div>
        <div v-else class="pool-empty">
          <Glyph name="media" :size="27" />
          <h3>{{ doc.assets.length ? '暂无匹配的素材' : '工程素材库为空' }}</h3>
          <p>
            {{
              doc.assets.length
                ? '调整类型、使用状态或搜索词。'
                : '导入本地图片、视频和音频，或生成第一份素材。'
            }}
          </p>
          <button v-if="doc.assets.length" class="outline" @click="clearFilters">清除筛选</button>
        </div>
      </div>
      <section v-if="chosen" class="pool-inspector" :key="chosen.id">
        <header>
          <Glyph name="sliders" :size="15" />
          <h2>素材属性</h2>
        </header>
        <div class="pool-preview">
          <img
            v-if="chosen.kind === 'image'"
            :key="recovered"
            :src="media(chosen.id)"
            :alt="chosen.name"
            @load="readDimensions($event.target)"
            @error="unavailable.add(chosen.id)"
          />
          <MediaPreview            v-else-if="chosen.kind === 'video'"
            :src="media(chosen.id)"
            @loadedmetadata="readDimensions"
          />
          <template v-else>
            <Glyph name="audio" :size="28" />
            <MediaPreview kind="audio" :src="media(chosen.id)" />
          </template>
        </div>
        <button
          v-if="unavailable.has(chosen.id) || ui.offlineImageIds.includes(chosen.id)"
          class="outline"
          @click="recoverImage"
        >
          找回丢失的原图
        </button>
        <label class="pool-name">
          素材名称
          <input :value="chosen.name" maxlength="300" @change="rename($event.target)" />
        </label>
        <dl class="pool-specs">
          <div>
            <dt>文件格式</dt>
            <dd>{{ chosen.ext.slice(1).toUpperCase() }} · {{ types[chosen.kind] }}</dd>
          </div>
          <div v-if="dimensions">
            <dt>分辨率</dt>
            <dd>{{ dimensions }}</dd>
          </div>
          <div v-if="chosen.duration">
            <dt>源时长</dt>
            <dd>{{ time(chosen.duration) }}</dd>
          </div>
          <div>
            <dt>目标分集</dt>
            <dd>{{ episode.title }}</dd>
          </div>
        </dl>
        <div v-if="chosen.kind === 'video'" class="pool-shot-target">
          <label>
            分镜归属
            <StudioSelect
              v-model="targetShot"
              aria-label="分镜归属"
              :options="[
                { value: '', label: '新建分镜 · ' + episode.title },
                ...episode.shots.map((s) => ({ value: s.id, label: s.title + (s.assetId === chosen.id ? ' · 已绑定' : '') }))
              ]"
            />
          </label>
          <button class="outline" @click="adoptVideo">
            <Glyph name="shots" :size="14" />
            {{ boundShot ? '打开分镜' : targetShot ? '绑定至分镜' : '用视频创建分镜' }}
          </button>
        </div>
        <button class="primary pool-insert" @click="append">
          <Glyph name="plus" :size="15" />
          加入剪辑
        </button>
        <div class="pool-refs">
          <h3>
            工程引用
            <small>{{ links.length }}</small>
          </h3>
          <p v-if="!links.length">尚未用于分镜、设定或剪辑。</p>
          <button
            v-for="(link, index) in visibleLinks"
            :key="index"
            @click="openRef(link)"
            :title="'进入' + (link.title || '设定卡')"
          >
            <Glyph
              :name="link.page === 'edit' ? 'edit' : link.page === 'cards' ? 'cards' : 'shots'"
              :size="14"
            />
            <span>{{ link.title ? link.title + ' · ' : '' }}{{ link.name }}</span>
            <Glyph name="chevron" :size="12" />
          </button>
          <button v-if="links.length > 6" class="text-btn" @click="showAll = !showAll">
            {{ showAll ? '收起' : '查看全部引用' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
