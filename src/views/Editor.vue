<script setup vapor>
import { computed, ref, onBeforeUnmount, watch, nextTick, onMounted } from 'vue'
import { ui, doc, episode, asset, media, editEpisode, api, perform, importMedia, notify } from '../store.js'
import { makeAudio, makeClip, sequence, uid } from '../../shared/model.mjs'
import { assignDefaultTracks, clipTrack, removeTrack, timelineTracks } from '../../shared/timeline-tracks.mjs'
import { roughCut } from '../../shared/rough-cut.mjs'
import {
  materializeTimeline,
  timelineCaptions,
  timelineEnd,
  pictureAt,
  captionsAt
} from '../../shared/timeline.mjs'
import { captionImage } from '../captions.js'
import Glyph from '../components/Glyph.vue'
import DockDivider from '../components/studio/DockDivider.vue'
import StudioSelect from '../components/StudioSelect.vue'
import CutTimeline from '../components/studio/CutTimeline.vue'
import { timecode, parseTimecode, onFrame } from '../editor/timecode.mjs'
import { outputSize } from '../../shared/model.mjs'
import '../studio.css'
const pos = ref(0),
  playing = ref(false),
  selected = ref([]),
  anchor = ref(null),
  targetTrack = ref(''),
  source = ref(''),
  stage = ref(null),
  tab = ref('properties'),
  mediaSearch = ref(''),
  safeArea = ref(false)
const rail = computed(() => sequence(episode.value.clips))
const total = computed(() => timelineEnd(episode.value))
const current = computed(() => pictureAt(episode.value, pos.value))
const tracks = computed(() =>
  timelineTracks(episode.value).map((track, index, list) => ({
    ...track,
    label:
      { visual: 'V', caption: 'T', audio: 'A' }[track.kind] +
      list.slice(0, index + 1).filter((item) => item.kind === track.kind).length
  }))
)
const rows = computed(() => [
  ...rail.value.map((clip) => item('visual', clip)),
  ...timelineCaptions(episode.value).map((clip) => item('caption', clip)),
  ...episode.value.audio.map((clip) => item('audio', clip))
])
function item(kind, clip) {
  return { kind, clip, key: kind + ':' + clip.id, trackId: clipTrack(tracks.value, kind, clip) }
}
const selection = computed(() => {
  const keys = new Set(selected.value)
  return rows.value.filter((item) => keys.has(item.key))
})
const pickedItem = computed(() => (selection.value.length === 1 ? selection.value[0] : null))
const row = computed(() => pickedItem.value?.clip)
const isAudio = computed(() => pickedItem.value?.kind === 'audio')
const isCaption = computed(() => pickedItem.value?.kind === 'caption')
const caption = computed(() =>
  captionImage(captionsAt(episode.value, pos.value), doc.value.ratio, doc.value.quality)
)
const picked = computed(() => asset(row.value?.assetId))
const position = row
const captionTracks = computed(() =>
  tracks.value
    .filter((t) => t.kind === 'caption')
    .map((t) => ({
      value: t.id,
      label: t.label + ' · 字幕'
    }))
)
const destination = computed(() => tracks.value.find((track) => track.id === targetTrack.value))
const insertable = computed(() => {
  const a = asset(source.value)
  return a && (!destination.value || destination.value.kind === (a.kind === 'audio' ? 'audio' : 'visual'))
})
const workbench = ref(null)
const consolePane = ref(null)
const timelinePane = ref(null)
const inspectorWidth = ref(null)
const timelineHeight = ref(null)
function resizeInspector(delta) {
  const width = consolePane.value.clientWidth
  const current = consolePane.value.querySelector('.cut-inspector').offsetWidth
  inspectorWidth.value = Math.max(188, Math.min(width - 260, current + delta))
}
function resizeTimeline(delta) {
  const max = Math.max(130, workbench.value.clientHeight - 300)
  timelineHeight.value = Math.max(130, Math.min(max, timelinePane.value.offsetHeight + delta))
}
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
const sequenceIndex = computed(() => rail.value.findIndex((c) => c.id === row.value?.id))
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
    selected.value = []
    anchor.value = null
    targetTrack.value = ''
    pos.value = 0
    source.value = ''
    tab.value = 'properties'
  }
)
watch(total, (t) => {
  if (pos.value > t) seek(t)
})
onBeforeUnmount(stop)
/** 多选保留播放头，普通点选仍定位到片段开头。 */
function select(entry, event) {
  if (!entry) return
  tab.value = 'properties'
  targetTrack.value = ''
  const toggle = event?.type !== 'contextmenu' && (event?.metaKey || event?.ctrlKey)
  const lane = rows.value
    .filter((row) => row.trackId === entry.trackId)
    .sort((a, b) => a.clip.start - b.clip.start)
  const first = lane.findIndex((item) => item.key === anchor.value)
  const last = lane.findIndex((item) => item.key === entry.key)
  if (event?.type !== 'contextmenu' && event?.shiftKey && first >= 0 && last >= 0) {
    const between = lane.slice(Math.min(first, last), Math.max(first, last) + 1).map((item) => item.key)
    selected.value = toggle ? [...new Set([...selected.value, ...between])] : between
  } else if (toggle) {
    selected.value = selected.value.includes(entry.key)
      ? selected.value.filter((key) => key !== entry.key)
      : [...selected.value, entry.key]
    anchor.value = entry.key
  } else {
    selected.value = [entry.key]
    anchor.value = entry.key
    if (!event || event.type !== 'contextmenu') {
      stop()
      seek(entry.clip.start)
    }
  }
}
function selectAll() {
  tab.value = 'properties'
  selected.value = rows.value.map((row) => row.key)
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
  const collection = isCaption.value ? 'captions' : isAudio.value ? 'audio' : 'clips'
  const id = row.value.id,
    delta = cutOffset.value
  const aligned = editEpisode((e) => {
    materializeTimeline(e)
    const clip = e[collection].find((c) => c.id === id)
    if (trimStart) {
      clip.duration -= delta
      if (clip.assetId && asset(clip.assetId).kind !== 'image') clip.trim += delta
      if ('start' in clip) clip.start += delta
    } else clip.duration = delta
  })
  if (aligned && position.value)
    seek(trimStart ? position.value.start : position.value.start + row.value.duration)
}
function patch(key, value) {
  if (!row.value) return
  stop()
  const collection = isCaption.value ? 'captions' : isAudio.value ? 'audio' : 'clips'
  const id = row.value.id
  editEpisode((e) => {
    materializeTimeline(e)
    const c = e[collection].find((c) => c.id === id)
    c[key] = value
    if (key === 'caption' && value) assignDefaultTracks(e)
  })
}
function add() {
  const a = asset(source.value)
  if (!insertable.value) return
  const audio = a.kind === 'audio'
  const clip = {
    ...(audio ? makeAudio(a.id, a.duration) : makeClip(a.id, a.duration || 5)),
    start: pos.value
  }
  if (destination.value) clip.trackId = destination.value.id
  if (
    editEpisode((e) => {
      materializeTimeline(e)
      ;(audio ? e.audio : e.clips).push(clip)
    })
  )
    select(rows.value.find((row) => row.clip.id === clip.id))
}
function addCaption() {
  const id = uid()
  editEpisode((e) => {
    materializeTimeline(e)
    let track = timelineTracks(e).find((t) => t.kind === 'caption')
    if (!track) {
      if (timelineTracks(e).length >= 64) throw Error('轨道数量已达上限')
      assignDefaultTracks(e)
      track = { id: uid(), kind: 'caption' }
      e.tracks.push(track)
    }
    e.captions.push({ id, caption: '新字幕', start: pos.value, duration: 3, trackId: track.id })
  })
  select(rows.value.find((r) => r.key === 'caption:' + id))
}
function addTrack(kind, below) {
  if (tracks.value.length >= 64) return
  const track = { kind, id: uid() }
  editEpisode((e) => {
    assignDefaultTracks(e)
    const index = below ? e.tracks.findIndex((track) => track.id === below) + 1 : e.tracks.length
    e.tracks.splice(index, 0, track)
  })
}
function deleteTrack(track) {
  stop()
  editEpisode((e) => {
    materializeTimeline(e)
    removeTrack(e, track)
  })
}
function insertOnTrack(track) {
  targetTrack.value = track.id
  tab.value = 'media'
}
function moveSelectionTo(track) {
  const ids = new Set(selection.value.filter((row) => row.kind === track.kind).map((row) => row.clip.id))
  if (!ids.size) return
  editEpisode((e) => {
    materializeTimeline(e)
    assignDefaultTracks(e)
    for (const clip of track.kind === 'caption' ? e.captions : track.kind === 'audio' ? e.audio : e.clips)
      if (ids.has(clip.id)) clip.trackId = track.id
  })
}
/** 片段换轨、轨道创建和时间变化共用一次工程提交与撤销。 */
function dropClip({ item, target, placement }) {
  const entry = rows.value.find((row) => row.key === item.key)
  if (!entry) return
  const { kind, clip } = entry
  const destination = target.track && tracks.value.find((track) => track.id === target.track.id)
  if (target.track && destination?.kind !== kind) return
  if (!destination && tracks.value.length >= 64) return
  const created = destination ? null : { id: uid(), kind }
  const trackId = destination?.id || created.id
  stop()
  const changed = editEpisode((e) => {
    materializeTimeline(e)
    if (created) {
      assignDefaultTracks(e)
      const index = e.tracks.findIndex((track) => track.id === target.beforeTrackId)
      e.tracks.splice(index < 0 ? e.tracks.length : index, 0, created)
    }
    const collection = kind === 'caption' ? e.captions : kind === 'audio' ? e.audio : e.clips
    const source = collection.find((c) => c.id === clip.id)
    source.trackId = trackId
    source.start = placement.start
  })
  if (changed) {
    selected.value = [entry.key]
    anchor.value = entry.key
    targetTrack.value = ''
    tab.value = 'properties'
  }
}
function trimClip({ item, placement }) {
  stop()
  editEpisode((e) => {
    materializeTimeline(e)
    const collection = item.kind === 'caption' ? e.captions : item.kind === 'audio' ? e.audio : e.clips
    const clip = collection.find((c) => c.id === item.clip.id)
    if (!clip) return
    clip.start = placement.start
    clip.duration = placement.duration
    if (item.kind !== 'caption') clip.trim = placement.trim
  })
}
/** 只切命中的独立片段，所有选中项共用一个撤销步骤。 */
function split(scope = 'selected') {
  const targets = scope === 'all' ? rows.value : selection.value
  const cuts = { audio: new Map(), clips: new Map(), captions: new Map() }
  const cutsFor = (kind) => (kind === 'caption' ? cuts.captions : kind === 'audio' ? cuts.audio : cuts.clips)
  for (const { kind, clip } of targets) {
    const offset = onFrame(pos.value - clip.start, doc.value.fps)
    const changes = cutsFor(kind)
    if (!changes.has(clip.id) && offset >= 0.04 && clip.duration - offset >= 0.04)
      changes.set(clip.id, { offset, right: uid() })
  }
  if (!cuts.audio.size && !cuts.clips.size && !cuts.captions.size)
    return notify('请把播放头移到要分割的片段内部')
  stop()
  if (
    !editEpisode((e) => {
      materializeTimeline(e)
      function divide(clip, changes) {
        const cut = changes.get(clip.id)
        if (!cut) return [clip]
        const right = { ...clip, id: cut.right, duration: clip.duration - cut.offset }
        if (clip.assetId && asset(clip.assetId).kind !== 'image') right.trim += cut.offset
        if ('start' in right) right.start += cut.offset
        return [{ ...clip, duration: cut.offset }, right]
      }
      e.clips = e.clips.flatMap((clip) => divide(clip, cuts.clips))
      e.audio = e.audio.flatMap((clip) => divide(clip, cuts.audio))
      e.captions = e.captions.flatMap((clip) => divide(clip, cuts.captions))
    })
  )
    return
  selected.value = targets
    .filter((row) => cutsFor(row.kind).has(row.clip.id))
    .map((row) => row.kind + ':' + cutsFor(row.kind).get(row.clip.id).right)
  tab.value = 'properties'
}
function remove() {
  if (!selection.value.length) return
  const keys = new Set(selection.value.map((row) => row.key))
  stop()
  if (
    editEpisode((e) => {
      materializeTimeline(e)
      e.clips = e.clips.filter((c) => !keys.has('visual:' + c.id))
      e.audio = e.audio.filter((c) => !keys.has('audio:' + c.id))
      e.captions = e.captions.filter((c) => !keys.has('caption:' + c.id))
    })
  )
    selected.value = []
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
    e.defaultPrevented ||
    ui.modal ||
    ui.busy ||
    e.altKey ||
    e.target.closest('input,textarea,[role=combobox],[contenteditable=true],aside,header.toolbar,[role=menu]')
  )
    return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && e.target.closest('.cut-room')) {
    e.preventDefault()
    selectAll()
    return
  }
  if (e.ctrlKey || e.metaKey) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selection.value.length) return
    e.preventDefault()
    if (!e.repeat) remove()
    return
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault()
    step(e.code === 'ArrowLeft' ? -1 : 1)
    return
  }
  if (e.code === 'KeyS' && !e.repeat) {
    e.preventDefault()
    split(selection.value.length ? 'selected' : 'all')
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
  <div
    ref="workbench"
    class="page studio-work cut-room"
    :style="{
      '--inspector-width': inspectorWidth && inspectorWidth + 'px',
      '--timeline-height': timelineHeight && timelineHeight + 'px'
    }"
  >
    <header class="studio-page-title">
      <h1>剪辑台</h1>
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
        <button class="outline" @click="addCaption">添加字幕</button>
        <button class="primary" :disabled="!total" @click="render">
          <Glyph name="download" />
          导出 MP4
        </button>
      </div>
    </header>
    <div ref="consolePane" class="cut-console">
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
            </template>
            <div v-else-if="!total" class="monitor-empty">
              <Glyph name="film" :size="30" />
              <span>时间线暂无画面</span>
              <button @click="tab = 'media'">
                选择素材
                <Glyph name="arrow" :size="12" />
              </button>
            </div>
            <img v-if="caption" class="caption" :src="caption" />
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
      <DockDivider axis="x" label="调整成片监看与片段属性的宽度" @resize="resizeInspector" />
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
            <span>
              {{
                isAudio
                  ? '音频片段'
                  : isCaption
                    ? '字幕片段'
                    : '画面片段 ' + String(sequenceIndex + 1).padStart(2, '0')
              }}
            </span>
            <strong>{{ isCaption ? '字幕' : picked?.name }}</strong>
          </div>
          <div class="cut-range">
            <span>时间线范围</span>
            <b>
              {{ timecode(position.start, doc.fps) }} — {{ timecode(position.start + row.duration, doc.fps) }}
            </b>
          </div>
          <div class="fields">
            <label v-if="!isCaption">
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
          <label>
            轨道起点（秒）
            <input
              type="number"
              min="0"
              step="any"
              :value="row.start"
              @change="patch('start', $event.target.valueAsNumber)"
            />
          </label>
          <label v-if="!isCaption && picked?.kind !== 'image'">
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
          <label v-if="isCaption">
            片段字幕
            <textarea :value="row.caption" maxlength="500" @change="patch('caption', $event.target.value)" />
          </label>
          <label v-if="isCaption && captionTracks.length > 1">
            字幕轨道
            <StudioSelect
              :options="captionTracks"
              :model-value="clipTrack(tracks, 'caption', row)"
              @update:model-value="patch('trackId', $event)"
            />
          </label>
          <div class="inspect-actions">
            <button class="icon" title="删除选中片段" @click="remove">
              <Glyph name="trash" :size="15" />
            </button>
          </div>
        </div>
        <div v-else-if="tab === 'properties'" class="inspect-empty" role="tabpanel">
          <Glyph name="sliders" :size="30" />
          <strong>{{ selection.length ? '已选中 ' + selection.length + ' 项' : '选择片段' }}</strong>
          <button v-if="selection.length" class="outline" @click="remove">删除选中项</button>
          <span v-else>点选时间线片段，查看裁切、声音和字幕属性。</span>
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
            :disabled="!insertable || !bin.some((a) => a.id === source)"
            @click="add"
          >
            <Glyph name="plus" :size="15" />
            {{ destination ? '插入至 ' + destination.label : '插入片段' }}
          </button>
        </div>
      </aside>
    </div>
    <DockDivider axis="y" label="调整时间线高度" @resize="resizeTimeline" />
    <div ref="timelinePane" class="timeline-dock">
      <CutTimeline
        :rail="rail"
        :rows="rows"
        :tracks="tracks"
        :total="total"
        :pos="pos"
        :selected="selection"
        @seek="locateFrame"
        @select="select"
        @select-all="selectAll"
        @drag-start="stop"
        @drop-clip="dropClip"
        @trim-clip="trimClip"
        @split="split"
        @remove="remove"
        @add-track="addTrack"
        @delete-track="deleteTrack"
        @insert-on-track="insertOnTrack"
        @move-selection="moveSelectionTo"
      />
    </div>
  </div>
</template>
