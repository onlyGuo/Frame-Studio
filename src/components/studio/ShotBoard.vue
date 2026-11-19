<script setup vapor>
import { settingImage } from '../../../shared/outfits.mjs'
import { computed } from 'vue'
import { doc, ui, episode, editEpisode, asset, media, generate, notify, travel } from '../../store.js'
import { indexShotMentions } from '../../../shared/mentions.mjs'
import { setShotAssetFree } from '../../../shared/shot-assets.mjs'
import {
  availableImages,
  inspectVisibleShot,
  previewImage,
  withShotReference
} from '../../editor/shot-assets.mjs'
import { clipFromShot } from '../../../shared/rough-cut.mjs'
import { makeShot } from '../../../shared/model.mjs'
import Glyph from '../Glyph.vue'
import MentionScript from './MentionScript.vue'
import EpisodeVideoBatch from './EpisodeVideoBatch.vue'
import ShotAssetReview from './ShotAssetReview.vue'
import { bindShotMedia } from '../../../shared/shot-media.mjs'
const shot = computed(() => episode.value.shots.find((s) => s.id === ui.shotId) || episode.value.shots[0])
const shots = computed(() => episode.value.shots)
const assetReport = computed(() => shot.value && inspectVisibleShot(doc.value, shot.value))
/** 记录当前脚本版本的出场选择，或将漏标的设定加入脚本。 */
function confirmAssets(value) {
  editEpisode((ep) =>
    setShotAssetFree(
      ep.shots.find((s) => s.id === shot.value.id),
      value
    )
  )
}
function reference(id) {
  const cards = doc.value.cards
  if (!cards.some((card) => card.id === id)) return
  editEpisode((ep) => {
    const current = ep.shots.find((s) => s.id === shot.value.id)
    current.prompt = withShotReference(current.prompt, cards, id)
  })
}
const episodeCards = computed(() => {
  const used = indexShotMentions([episode.value])
  return doc.value.cards.filter((card) => used.has(card.id))
})
/** 从本集出场资产直接定位工程中的原始视觉设定卡。 */
function openCard(id) {
  ui.focusCardId = id
  ui.page = 'cards'
}
const index = computed(() => shots.value.findIndex((s) => s.id === shot.value?.id))
const videos = computed(() => doc.value.assets.filter((a) => a.kind === 'video'))
const ready = computed(() => shots.value.filter((s) => asset(s.assetId)?.kind === 'video').length)
/** 关联当前正在制作的镜头和最后一次批量失败的原因。 */
function videoStatus(s) {
  const batch = ui.videoBatch
  if (batch?.root === ui.root && batch.episodeId === episode.value.id && batch.shotId === s.id) {
    if (batch.status === 'running') return '生成中'
    if (batch.status === 'failed' && asset(s.assetId)?.kind !== 'video') return '生成失败 · ' + batch.error
  }
  if (asset(s.assetId)?.kind === 'video') return '视频就绪'
  const review = inspectVisibleShot(doc.value, s)
  if (!review.ready)
    return review.issues.some((issue) => ['missing_image', 'missing_file'].includes(issue.code))
      ? '出场资产待配图'
      : '出场资产待核对'
  return review.state === 'none' ? '已确认无出场资产 · 待生成视频' : '出场资产已配图 · 待生成视频'
}
const videoId = computed(() => (asset(shot.value?.assetId)?.kind === 'video' ? shot.value.assetId : ''))
const referenceId = computed(
  () => shot.value?.referenceId || (asset(shot.value?.assetId)?.kind === 'image' ? shot.value.assetId : '')
)
/** 人工绑定和生成使用相同的镜头素材规则，独立保留参考图及分镜视频。 */
function bind(kind, id) {
  const shotId = shot.value.id
  editEpisode((ep) => {
    const current = ep.shots.find((s) => s.id === shotId)
    if (kind === 'image' && !id) {
      if (asset(current.assetId)?.kind === 'image') current.assetId = ''
      current.referenceId = ''
    } else bindShotMedia(current, asset(id), doc.value.assets)
  })
}
/** 列表与属性面板按镜头 ID 操作，重排时保留选择。 */
function patch(id, key, value) {
  editEpisode((e) => {
    e.shots.find((s) => s.id === id)[key] = value
  })
}
function add() {
  const s = makeShot()
  if (editEpisode((e) => e.shots.push(s))) ui.shotId = s.id
}
function reorder(offset) {
  const from = index.value,
    to = from + offset
  if (to < 0 || to >= shots.value.length) return
  ui.shotId = shot.value.id
  editEpisode((e) => e.shots.splice(to, 0, e.shots.splice(from, 1)[0]))
}
function remove() {
  const i = index.value
  if (editEpisode((e) => e.shots.splice(i, 1)))
    ui.shotId = shots.value[Math.min(i, shots.value.length - 1)]?.id || ''
}
function append() {
  const s = shot.value,
    a = asset(s.assetId)
  if (!a) return
  if (editEpisode((e) => e.clips.push(clipFromShot(s, a))))
    notify('已加入「' + episode.value.title + '」时间线')
}
</script>
<template>
  <header class="studio-page-title">
    <div>
      <div class="studio-breadcrumb">{{ episode.title }}</div>
      <h1>分镜工作台</h1>
    </div>
    <div class="actions">
      <EpisodeVideoBatch />
      <button class="primary" @click="add">
        <Glyph name="plus" />
        添加分镜
      </button>
    </div>
  </header>
  <section v-if="episodeCards.length" class="episode-card-strip" aria-label="本集引用资产">
    <h2>本集引用资产</h2>
    <button
      v-for="card in episodeCards"
      :key="card.id"
      :aria-label="'查看' + card.type + '设定：' + card.name"
      @click="openCard(card.id)"
    >
      <img
        v-if="previewImage(settingImage(card))"
        :src="previewImage(settingImage(card))"
        alt=""
        loading="lazy"
      />
      <small class="mention-kind" :data-kind="card.type">{{ card.type }}</small>
      <strong>{{ card.name }}</strong>
    </button>
  </section>
  <div v-if="!shots.length" class="empty">
    <Glyph name="shots" :size="36" />
    <h3>为这一集安排第一个镜头</h3>
    <p>添加分镜，或根据本集剧本让创作助手拆镜。</p>
    <button class="outline" @click="ui.agent = true">
      <Glyph name="spark" />
      打开创作助手
    </button>
  </div>
  <div v-else class="shot-console">
    <section class="production-panel shot-list">
      <header>
        <h2>
          镜头清单
          <small>{{ shots.length }}</small>
        </h2>
        <span class="table-meta">{{ ready }} / {{ shots.length }} 个视频就绪</span>
      </header>
      <div v-for="(s, i) in shots" :key="s.id" class="shot-line" :class="{ chosen: shot?.id === s.id }">
        <button class="shot-preview" :aria-label="'选择镜头 ' + (i + 1)" @click="ui.shotId = s.id">
          <img
            v-if="asset(s.assetId)?.kind === 'image' && previewImage(s.assetId)"
            :src="previewImage(s.assetId)"
            loading="lazy"
          />
          <video
            v-else-if="asset(s.assetId)?.kind === 'video'"
            :src="media(s.assetId)"
            muted
            preload="metadata"
          />
          <Glyph v-else name="shots" :size="16" />
        </button>
        <div class="shot-line-content">
          <small>SH {{ String(i + 1).padStart(3, '0') }} · {{ s.duration }}s</small>
          <input
            aria-label="镜头名称"
            :value="s.title"
            @focus="ui.shotId = s.id"
            @change="patch(s.id, 'title', $event.target.value)"
          />
          <small class="shot-render-state" :data-ready="asset(s.assetId)?.kind === 'video'">
            {{ videoStatus(s) }}
          </small>
        </div>
        <button class="icon" title="查看镜头属性" @click="ui.shotId = s.id">
          <Glyph name="chevron" :size="15" />
        </button>
      </div>
    </section>
    <section class="production-panel shot-detail" :key="shot.id">
      <header>
        <h2>镜头属性</h2>
        <div class="actions">
          <button class="icon" title="镜头前移" :disabled="!index" @click="reorder(-1)">
            <Glyph name="back" :size="15" />
          </button>
          <button class="icon" title="镜头后移" :disabled="index === shots.length - 1" @click="reorder(1)">
            <Glyph name="chevron" :size="15" />
          </button>
          <button class="icon" title="删除分镜" @click="remove"><Glyph name="trash" :size="15" /></button>
        </div>
      </header>
      <div class="shot-form">
        <div class="story-frame">
          <img
            v-if="asset(shot.assetId)?.kind === 'image' && previewImage(shot.assetId)"
            :src="previewImage(shot.assetId)"
          />
          <video v-else-if="asset(shot.assetId)?.kind === 'video'" :src="media(shot.assetId)" controls />
          <img v-else-if="previewImage(referenceId)" :src="previewImage(referenceId)" alt="分镜参考图" />
          <span v-else>
            <Glyph name="shots" :size="24" />
            待制作分镜
          </span>
        </div>
        <MentionScript
          :model-value="shot.prompt"
          :cards="doc.cards"
          :image-url="previewImage"
          @update:model-value="patch(shot.id, 'prompt', $event)"
          @history="travel"
          @manage="ui.page = 'cards'"
        />
        <label>
          对白 / 字幕
          <textarea :value="shot.dialogue" @change="patch(shot.id, 'dialogue', $event.target.value)" />
        </label>
        <ShotAssetReview
          :report="assetReport"
          :can-confirm="Boolean(shot.prompt.trim())"
          can-open-card
          @confirm="confirmAssets"
          @reference="reference"
          @open-card="openCard"
        />
        <div class="fields">
          <label>
            分镜视频
            <select :value="videoId" @change="bind('video', $event.target.value)">
              <option value="">未绑定视频</option>
              <option v-for="a in videos" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
          </label>
          <label class="narrow">
            时长（秒）
            <input
              type="number"
              min=".04"
              step=".1"
              :value="shot.duration"
              @change="patch(shot.id, 'duration', $event.target.valueAsNumber)"
            />
          </label>
        </div>
        <div class="shot-reference-row">
          <img v-if="previewImage(referenceId)" :src="previewImage(referenceId)" alt="当前分镜参考图" />
          <label>
            分镜参考图
            <select :value="referenceId" @change="bind('image', $event.target.value)">
              <option value="">未绑定参考图</option>
              <option v-if="referenceId && !previewImage(referenceId)" :value="referenceId" disabled>
                原参考图不可用
              </option>
              <option v-for="a in availableImages" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
          </label>
          <button class="outline" @click="generate(shot.prompt, shot.id, '', 'image')">
            <Glyph name="media" />
            生成分镜参考图
          </button>
        </div>
        <div class="actions">
          <button class="soft" @click="generate(shot.prompt, shot.id, '', 'video')">
            <Glyph name="spark" />
            生成分镜视频
          </button>
          <button class="outline" :disabled="!shot.assetId" @click="append">
            <Glyph name="plus" />
            加入剪辑
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
