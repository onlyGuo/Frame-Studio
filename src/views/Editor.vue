<script setup vapor>
import { computed, ref, onBeforeUnmount, watch, nextTick, onMounted } from 'vue'
import { ui, doc, episode, asset, media, editEpisode, api, perform, importMedia, notify } from '../store.js'
import { makeAudio, makeClip, sequence, uid } from '../../shared/model.mjs'
import { roughCut } from '../../shared/rough-cut.mjs'
import { captionImage } from '../captions.js'
import Glyph from '../components/Glyph.vue'
import CutTimeline from '../components/studio/CutTimeline.vue'
import { timecode, parseTimecode, onFrame } from '../editor/timecode.mjs'
import { outputSize } from '../../shared/model.mjs'
import '../studio.css'
const pos = ref(0),
  playing = ref(false),
  selected = ref(''),
  source = ref(''),
  stage = ref(null),
  tab = ref('properties'),
  mediaSearch = ref(''),
  safeArea = ref(false)
const rail = computed(() => sequence(episode.value.clips))
const total = computed(() => rail.value.at(-1)?.end || 0)
const current = computed(
  () =>
    rail.value.find((c) => pos.value >= c.start && pos.value < c.end) ||
    (pos.value >= total.value ? rail.value.at(-1) : null)
)
const row = computed(() =>
  [...episode.value.clips, ...episode.value.audio].find((c) => c.id === selected.value)
)
const isAudio = computed(() => row.value && 'start' in row.value)
const caption = computed(() => captionImage(current.value?.caption, doc.value.ratio, doc.value.quality))
const picked = computed(() => asset(row.value?.assetId))
const position = computed(() => (isAudio.value ? row.value : rail.value.find((c) => c.id === selected.value)))
const format = computed(() => outputSize(doc.value.ratio, doc.value.quality).join(' × '))
const bin = computed(() =>
  doc.value.assets.filter((a) => a.name.toLowerCase().includes(mediaSearch.value.toLowerCase()))
)
const frameStep = computed(() => 1 / doc.value.fps)
const cutOffset = computed(() =>
  position.value ? onFrame(pos.value - position.value.start, doc.value.fps) : 0
)
const interior = computed(
  () => row.value && cutOffset.value >= 0.04 && row.value.duration - cutOffset.value >= 0.04
)
const sequenceIndex = computed(() => rail.value.findIndex((c) => c.id === selected.value))
let frame = 0,
  last = 0
function stop() {
  playing.value = false
  cancelAnimationFrame(frame)
  stage.value?.querySelectorAll('video,audio').forEach((el) => el.pause())
}
/** 播放头统一驱动画面、字幕和独立音频剪辑，拖动时同步媒体源时间。 */
function sync() {
  if (!stage.value) return
  for (const el of stage.value.querySelectorAll('video,audio')) {
    const visual = el.tagName === 'VIDEO',
      clip = visual ? current.value : episode.value.audio.find((a) => a.id === el.dataset.id)
    if (!clip) continue
    const local = pos.value - clip.start
    const audible = local >= 0 && local < clip.duration
    el.volume = clip.volume
    const t = clip.trim + Math.max(0, Math.min(local, clip.duration))
    if (el.readyState >= 1 && Math.abs(el.currentTime - t) > (playing.value ? 0.18 : 0.015))
      el.currentTime = t
    if (playing.value && audible) {
      if (el.paused) el.play().catch(() => {})
    } else el.pause()
  }
}
function tick(now) {
  pos.value = Math.min(total.value, pos.value + (now - last) / 1000)
  last = now
  if (pos.value >= total.value) stop()
  else frame = requestAnimationFrame(tick)
}
function toggle() {
  if (playing.value) return stop()
  if (!total.value) return
  if (pos.value >= total.value) pos.value = 0
  playing.value = true
  last = performance.now()
  sync()
  frame = requestAnimationFrame(tick)
}
function seek(t) {
  pos.value = Math.max(0, Math.min(total.value, t))
  nextTick(sync)
}
watch(
  () => [pos.value, current.value?.id, row.value, playing.value],
  () => nextTick(sync),
  { flush: 'post' }
)
watch(
  () => episode.value.id,
  () => {
    stop()
    selected.value = ''
    pos.value = 0
    source.value = ''
    tab.value = 'properties'
  }
)
watch(total, (t) => {
  if (pos.value > t) seek(t)
})
onBeforeUnmount(stop)
function select(c) {
  if (!c) return
  tab.value = 'properties'
  selected.value = c.id
  seek(c.start ?? 0)
}
function locate(input) {
  const sec = parseTimecode(input.value, doc.value.fps)
  input.value = timecode(pos.value, doc.value.fps)
  if (sec === null) return notify('时间码格式为 时:分:秒:帧，也可输入秒数')
  locateFrame(sec)
}
function locateFrame(t) {
  stop()
  seek(onFrame(t, doc.value.fps))
}
function step(n) {
  locateFrame(onFrame(pos.value, doc.value.fps) + n * frameStep.value)
}
/** 在当前播放帧裁短所选片段，独立音轨的裁头同时移动其轨道起点。 */
function trimToHead(trimStart) {
  if (!interior.value) return
  stop()
  const id = row.value.id,
    delta = cutOffset.value
  const aligned = editEpisode((e) => {
    const clip = [...e.clips, ...e.audio].find((c) => c.id === id)
    if (trimStart) {
      clip.duration -= delta
      if (asset(clip.assetId).kind !== 'image') clip.trim += delta
      if ('start' in clip) clip.start += delta
    } else clip.duration = delta
  })
  if (aligned && position.value)
    seek(trimStart ? position.value.start : position.value.start + row.value.duration)
}
function patch(key, value) {
  if (!row.value) return
  stop()
  const id = row.value.id
  editEpisode((e) => {
    const c = [...e.clips, ...e.audio].find((c) => c.id === id)
    c[key] = value
  })
}
function add() {
  const a = asset(source.value)
  if (!a) return
  const audio = a.kind === 'audio'
  const c = audio ? { ...makeAudio(a.id, a.duration), start: pos.value } : makeClip(a.id, a.duration || 5)
  const success = editEpisode((e) => {
    if (audio) e.audio.push(c)
    else e.clips.push(c)
  })
  if (success) select(audio ? c : rail.value.at(-1))
}
function move(index, to) {
  if (to < 0 || to >= rail.value.length || index < 0) return
  stop()
  editEpisode((e) => e.clips.splice(to, 0, e.clips.splice(index, 1)[0]))
}
function split() {
  const target = isAudio.value ? position.value : current.value
  if (!target) return
  const cut = onFrame(pos.value - target.start, doc.value.fps)
  if (cut < 0.04 || target.duration - cut < 0.04) return notify('请把播放头移到片段内部')
  stop()
  const rightId = uid()
  if (
    editEpisode((e) => {
      const rows = isAudio.value ? e.audio : e.clips
      const i = rows.findIndex((c) => c.id === target.id),
        item = rows[i]
      const right = { ...item, id: rightId, duration: item.duration - cut }
      if (asset(item.assetId).kind !== 'image') right.trim += cut
      if ('start' in right) right.start += cut
      rows.splice(i, 1, { ...item, duration: cut }, right)
    })
  ) {
    selected.value = rightId
    tab.value = 'properties'
  }
}
function remove() {
  stop()
  editEpisode((e) => {
    e.clips = e.clips.filter((c) => c.id !== selected.value)
    e.audio = e.audio.filter((c) => c.id !== selected.value)
  })
  selected.value = ''
}
/** 将本集已经成片的分镜补入主画面轨道，原有手工剪辑继续保留。 */
function assemble() {
  stop()
  const cut = roughCut(episode.value, doc.value.assets, doc.value.cards)
  if (cut.added || cut.linked)
    if (
      !editEpisode((e) => {
        e.clips = cut.clips
      })
    )
      return
  const detail = [cut.added ? '已补入 ' + cut.added + ' 个镜头' : '没有需要补入的成镜']
  if (cut.pending) detail.push(cut.pending + ' 个镜头待制作')
  if (cut.subtitlesShortened) detail.push(cut.subtitlesShortened + ' 条对白已摘取前 500 字作为字幕')
  notify(detail.join(' · '))
}
async function render() {
  stop()
  await perform(
    '准备导出成片',
    async () => {
      ui.exported = await api.render({ session: ui.session, episodeId: episode.value.id })
      ui.modal = 'exported'
    },
    true
  )
}
function key(e) {
  if (
    ui.modal ||
    ui.busy ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target.closest('input,textarea,[role=combobox],[contenteditable=true],aside,header.toolbar')
  )
    return
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault()
    step(e.code === 'ArrowLeft' ? -1 : 1)
    return
  }
  if (e.code === 'KeyS' && !e.repeat) {
    e.preventDefault()
    split()
    return
  }
  if (e.target.closest('button')) return
  if (e.code === 'Space') {
    e.preventDefault()
    toggle()
  }
}
onMounted(() => window.addEventListener('keydown', key))
onBeforeUnmount(() => window.removeEventListener('keydown', key))
</script>
<template>
  <div class="page studio-work cut-room">
    <header class="studio-page-title">
      <div>
        <div class="studio-breadcrumb">{{ episode.title }}</div>
        <h1>剪辑台</h1>
      </div>
      <div class="actions">
        <button
          class="outline"
          :disabled="!episode.shots.length"
          @click="assemble"
          title="按分镜顺序补入已制作的视频并带入对白字幕"
        >
          <Glyph name="shots" />
          按分镜粗剪
        </button>
        <button class="primary" :disabled="!total" @click="render">
          <Glyph name="download" />
          导出 MP4
        </button>
      </div>
    </header>
    <div class="cut-console">
      <section class="program-monitor">
        <header>
          <div>
            <i />
            成片监看
          </div>
          <span>{{ format }} · {{ doc.fps }} fps</span>
        </header>
        <div class="monitor-surface" ref="stage">
          <div
            class="frame"
            :style="{
              aspectRatio: doc.ratio.replace(':', '/'),
              '--program-ratio': doc.ratio.replace(':', ' / ')
            }"
          >
            <template v-if="current">
              <img v-if="asset(current.assetId)?.kind === 'image'" :src="media(current.assetId)" />
              <video
                v-else
                :key="current.assetId"
                :src="media(current.assetId)"
                @loadedmetadata="sync"
                playsinline
              />
              <img v-if="caption" class="caption" :src="caption" />
            </template>
            <div v-else class="monitor-empty">
              <Glyph name="film" :size="30" />
              <span>时间线暂无画面</span>
              <button @click="tab = 'media'">
                选择素材
                <Glyph name="arrow" :size="12" />
              </button>
            </div>
            <div v-if="safeArea" class="safe-area" aria-hidden="true"><i /></div>
          </div>
          <audio
            v-for="a in episode.audio"
            :key="a.id"
            :data-id="a.id"
            :src="media(a.assetId)"
            @loadedmetadata="sync"
          />
        </div>
        <div class="monitor-controls">
          <div class="monitor-time">
            <input
              aria-label="定位时间码"
              title="定位 时:分:秒:帧"
              :value="timecode(pos, doc.fps)"
              @focus="stop"
              @keydown.enter="$event.target.blur()"
              @change="locate($event.target)"
            />
            <span>/ {{ timecode(total, doc.fps) }}</span>
          </div>
          <div class="shuttle">
            <button class="icon" :disabled="!total" title="上一帧（←）" @click="step(-1)">
              <Glyph name="back" :size="14" />
            </button>
            <button
              class="icon monitor-play"
              :disabled="!total"
              :title="playing ? '暂停' : '播放'"
              @click="toggle"
            >
              <Glyph :name="playing ? 'pause' : 'play'" :size="15" />
            </button>
            <button class="icon" :disabled="!total" title="下一帧（→）" @click="step(1)">
              <Glyph name="chevron" :size="14" />
            </button>
          </div>
          <button
            class="monitor-safe"
            title="叠加画面与字幕安全区"
            :aria-pressed="safeArea"
            @click="safeArea = !safeArea"
          >
            安全框
          </button>
        </div>
      </section>
      <aside class="cut-inspector">
        <header role="tablist" aria-label="剪辑面板">
          <button role="tab" :aria-selected="tab === 'properties'" @click="tab = 'properties'">
            <Glyph name="sliders" :size="15" />
            片段属性
          </button>
          <button role="tab" :aria-selected="tab === 'media'" @click="tab = 'media'">
            <Glyph name="media" :size="15" />
            工程素材
          </button>
        </header>
        <div v-if="tab === 'properties' && row" class="inspect-form" role="tabpanel">
          <div class="inspect-title">
            <span>{{ isAudio ? '音频片段' : '画面片段 ' + String(sequenceIndex + 1).padStart(2, '0') }}</span>
            <strong>{{ picked?.name }}</strong>
          </div>
          <div class="cut-range">
            <span>时间线范围</span>
            <b>
              {{ timecode(position.start, doc.fps) }} — {{ timecode(position.start + row.duration, doc.fps) }}
            </b>
          </div>
          <div class="fields">
            <label>
              源入点（秒）
              <input
                type="number"
                min="0"
                step="any"
                :disabled="picked?.kind === 'image'"
                :value="row.trim"
                @change="patch('trim', $event.target.valueAsNumber)"
              />
            </label>
            <label>
              时长（秒）
              <input
                type="number"
                min=".04"
                step="any"
                :value="row.duration"
                @change="patch('duration', $event.target.valueAsNumber)"
              />
            </label>
          </div>
          <div class="trim-actions">
            <button :disabled="!interior" @click="trimToHead(true)">裁去播放头前</button>
            <button :disabled="!interior" @click="trimToHead(false)">裁去播放头后</button>
          </div>
          <label v-if="isAudio">
            轨道起点（秒）
            <input
              type="number"
              min="0"
              step="any"
              :value="row.start"
              @change="patch('start', $event.target.valueAsNumber)"
            />
          </label>
          <label v-if="picked?.kind !== 'image'">
            音量 · {{ Math.round(row.volume * 100) }}%
            <input
              type="range"
              min="0"
              max="1"
              step=".01"
              :value="row.volume"
              @change="patch('volume', $event.target.valueAsNumber)"
            />
          </label>
          <label v-if="!isAudio">
            片段字幕
            <textarea :value="row.caption" maxlength="500" @change="patch('caption', $event.target.value)" />
          </label>
          <div class="inspect-actions">
            <button
              v-if="!isAudio"
              class="icon"
              :disabled="sequenceIndex <= 0"
              title="片段左移"
              @click="move(sequenceIndex, sequenceIndex - 1)"
            >
              <Glyph name="back" :size="15" />
            </button>
            <button
              v-if="!isAudio"
              :disabled="sequenceIndex >= rail.length - 1"
              class="icon"
              title="片段右移"
              @click="move(sequenceIndex, sequenceIndex + 1)"
            >
              <Glyph name="chevron" :size="15" />
            </button>
            <button class="icon" title="删除选中片段" @click="remove">
              <Glyph name="trash" :size="15" />
            </button>
          </div>
        </div>
        <div v-else-if="tab === 'properties'" class="inspect-empty" role="tabpanel">
          <Glyph name="sliders" :size="30" />
          <strong>选择片段</strong>
          <span>点选时间线片段，查看裁切、声音和字幕属性。</span>
        </div>
        <div v-else class="cut-bin" role="tabpanel">
          <div class="bin-tools">
            <input type="search" placeholder="搜索工程素材" aria-label="搜索工程素材" v-model="mediaSearch" />
            <button class="icon" title="导入媒体" @click="importMedia"><Glyph name="up" :size="16" /></button>
          </div>
          <div v-if="!bin.length" class="inspect-empty">
            <span>{{ doc.assets.length ? '没有匹配的素材' : '此工程尚无媒体素材' }}</span>
            <button class="outline" @click="importMedia">导入媒体</button>
          </div>
          <button
            v-for="a in bin"
            :key="a.id"
            class="bin-item"
            :class="{ chosen: source === a.id }"
            @click="source = a.id"
            @dblclick="add"
          >
            <img v-if="a.kind === 'image'" :src="media(a.id)" loading="lazy" />
            <Glyph v-else :name="a.kind === 'video' ? 'film' : 'audio'" />
            <span>
              <strong>{{ a.name }}</strong>
              <small>
                {{ a.ext.slice(1).toUpperCase() }} · {{ a.duration ? timecode(a.duration, doc.fps) : '静帧' }}
              </small>
            </span>
          </button>
          <button
            v-if="bin.length"
            class="primary bin-insert"
            :disabled="!source || !bin.some((a) => a.id === source)"
            @click="add"
          >
            <Glyph name="plus" :size="15" />
            插入片段
          </button>
        </div>
      </aside>
    </div>
    <CutTimeline
      :rail="rail"
      :total="total"
      :pos="pos"
      :selected="selected"
      @seek="locateFrame"
      @select="select"
      @move="move"
      @split="split"
    />
  </div>
</template>
