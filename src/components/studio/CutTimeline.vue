<script setup vapor>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { doc, episode, asset, media } from '../../store.js'
import { timecode } from '../../editor/timecode.mjs'
import Glyph from '../Glyph.vue'
const props = defineProps({ rail: Array, total: Number, pos: Number, selected: String })
const emit = defineEmits(['seek', 'select', 'move', 'split'])
const scroll = ref(null),
  viewport = ref(540),
  scrollLeft = ref(0),
  zoom = ref(48)
const span = computed(() => Math.max(props.total, ...episode.value.audio.map((c) => c.start + c.duration), 1))
const scale = computed(() => Math.min(zoom.value, 8000000 / span.value))
const width = computed(() => Math.max(viewport.value, Math.ceil(span.value * scale.value) + 1))
const interval = computed(
  () =>
    [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600, 10800, 43200, 86400].find(
      (n) => n * scale.value >= 75
    ) || 86400
)
/** 只绘制可见的时间标尺，长分集缩放时保持流畅。 */
const ticks = computed(() => {
  const first = Math.floor(scrollLeft.value / scale.value / interval.value)
  const count = Math.ceil(viewport.value / scale.value / interval.value) + 2
  return Array.from({ length: Math.min(100, count) }, (_, i) => (i + first) * interval.value).filter(
    (t) => t * scale.value < width.value
  )
})
const labels = computed(() =>
  episode.value.audio.length ? episode.value.audio.map((c, i) => 'A' + (i + 1)) : ['A1']
)
const captions = computed(() => props.rail.filter((c) => c.caption))
let observer
function fit() {
  zoom.value = Math.min(180, (viewport.value - 1) / span.value)
}
function scrub(e) {
  const el = e.currentTarget
  if (e.type === 'pointerdown') el.setPointerCapture(e.pointerId)
  else if (!el.hasPointerCapture(e.pointerId)) return
  emit('seek', (e.clientX - el.getBoundingClientRect().left) / scale.value)
}
function drag(e, c) {
  e.dataTransfer.setData('application/x-frame-clip', c.id)
  e.dataTransfer.effectAllowed = 'move'
}
function drop(e, target) {
  const id = e.dataTransfer.getData('application/x-frame-clip')
  const from = props.rail.findIndex((c) => c.id === id)
  if (from >= 0 && from !== target) emit('move', from, target)
}
function scrollPlayhead() {
  if (!scroll.value) return
  const x = props.pos * scale.value
  if (x < scroll.value.scrollLeft || x > scroll.value.scrollLeft + viewport.value - 2)
    scroll.value.scrollLeft = Math.max(0, x - viewport.value * 0.2)
}
watch(() => props.pos, scrollPlayhead)
watch(scale, () => nextTick(scrollPlayhead))
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (scroll.value) viewport.value = scroll.value.clientWidth
  })
  observer.observe(scroll.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <section class="cut-timeline">
    <header class="cut-tools">
      <div>
        <Glyph name="edit" :size="16" />
        <h2>时间线</h2>
        <span>{{ rail.length }} 个画面片段</span>
      </div>
      <div>
        <button :disabled="!total" @click="$emit('split')" title="在播放头处分割（S）">
          <Glyph name="split" :size="15" />
          分割
        </button>
        <label class="inline cut-zoom">
          缩放
          <input type="range" min="2" max="180" :value="zoom" @input="zoom = $event.target.valueAsNumber" />
        </label>
        <button title="适配整条时间线" @click="fit">适配</button>
      </div>
    </header>
    <div class="track-layout">
      <div class="track-heads">
        <div class="track-clock">轨道</div>
        <div class="track-head visual">
          <b>V1</b>
          <span>画面</span>
        </div>
        <div class="track-head subtitle">
          <b>T1</b>
          <span>字幕</span>
        </div>
        <div v-for="l in labels" :key="l" class="track-head audio">
          <b>{{ l }}</b>
          <span>音频</span>
        </div>
      </div>
      <div class="track-scroll" ref="scroll" @scroll="scrollLeft = $event.target.scrollLeft">
        <div class="rail" :style="{ width: width + 'px', '--tick-gap': interval * scale + 'px' }">
          <div class="ruler" title="拖动播放头" @pointerdown="scrub" @pointermove="scrub">
            <span v-for="t in ticks" :key="t" :style="{ left: t * scale + 'px' }">
              {{ timecode(t, doc.fps).slice(t >= 3600 ? 0 : 3) }}
            </span>
          </div>
          <div class="lane visual-lane">
            <button
              v-for="(c, i) in rail"
              :key="c.id"
              draggable="true"
              @dragstart="drag($event, c)"
              @dragover.prevent
              @drop.prevent="drop($event, i)"
              :class="{ selected: c.id === selected }"
              :style="{ left: c.start * scale + 'px', width: c.duration * scale + 'px' }"
              :title="asset(c.assetId)?.name"
              @click="$emit('select', c)"
            >
              <img
                v-if="asset(c.assetId)?.kind === 'image' && c.duration * scale > 76"
                :src="media(c.assetId)"
                loading="lazy"
              />
              <span>{{ asset(c.assetId)?.name }}</span>
            </button>
          </div>
          <div class="lane caption-lane">
            <button
              v-for="c in captions"
              :key="c.id"
              :class="{ selected: c.id === selected }"
              :style="{ left: c.start * scale + 'px', width: c.duration * scale + 'px' }"
              @click="$emit('select', c)"
            >
              {{ c.caption }}
            </button>
          </div>
          <div class="lane sound" v-for="a in episode.audio" :key="a.id">
            <button
              :class="{ selected: a.id === selected }"
              :style="{ left: a.start * scale + 'px', width: a.duration * scale + 'px' }"
              @click="$emit('select', a)"
            >
              {{ asset(a.assetId)?.name }}
            </button>
          </div>
          <div v-if="!episode.audio.length" class="lane sound"></div>
          <div class="playhead" :style="{ left: pos * scale + 'px' }" />
        </div>
      </div>
    </div>
  </section>
</template>
