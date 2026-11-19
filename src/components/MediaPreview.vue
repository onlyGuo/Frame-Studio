<script setup vapor>
import { computed, ref, watch } from 'vue'
import Glyph from './Glyph.vue'

const props = defineProps({
  kind: { type: String, default: 'video' },
  src: { type: String, required: true },
  label: String,
  preload: { type: String, default: 'metadata' }
})
const emit = defineEmits(['loadedmetadata'])
const player = ref(null)
const frame = ref(null)
const position = ref(0)
const duration = ref(0)
const paused = ref(true)
const muted = ref(false)
const failed = ref(false)
const timestamp = computed(() => clock(position.value) + ' / ' + clock(duration.value))

function clock(seconds) {
  const minutes = Math.floor(seconds / 60)
  return minutes + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')
}
/** 播放状态直接读媒体元素，支持外部暂停、结束及重新加载。 */
function sync(event) {
  const media = event.currentTarget
  position.value = media.currentTime
  duration.value = Number.isFinite(media.duration) ? media.duration : 0
  paused.value = media.paused || media.ended
  muted.value = media.muted
  if (event.type === 'loadedmetadata') emit('loadedmetadata', media)
}
watch(
  () => props.src,
  () => {
    failed.value = false
    position.value = duration.value = 0
    paused.value = true
  }
)
async function playback() {
  if (!player.value.paused) return player.value.pause()
  try {
    await player.value.play()
    failed.value = false
  } catch (error) {
    if (error.name !== 'AbortError') failed.value = true
  }
}
function seek(event) {
  player.value.currentTime = event.target.valueAsNumber
  sync({ currentTarget: player.value })
}
async function fullscreen() {
  if (document.fullscreenElement === frame.value) await document.exitFullscreen()
  else await frame.value.requestFullscreen()
}
</script>
<template>
  <div
    ref="frame"
    class="media-preview"
    :class="{ 'media-preview-video': kind === 'video' }"
    :aria-label="label"
    role="group"
  >
    <component
      :is="kind"
      ref="player"
      :src="src"
      :preload="preload"
      playsinline
      @loadedmetadata="sync"
      @durationchange="sync"
      @timeupdate="sync"
      @play="sync"
      @pause="sync"
      @ended="sync"
      @volumechange="sync"
      @error="failed = true"
    />
    <div class="media-preview-controls">
      <button
        type="button"
        class="icon"
        :aria-label="paused ? '播放' : '暂停'"
        :title="paused ? '播放' : '暂停'"
        @click="playback"
      >
        <Glyph :name="paused ? 'play' : 'pause'" :size="14" />
      </button>
      <input
        type="range"
        min="0"
        :max="duration || 1"
        step="0.01"
        :value="position"
        :disabled="!duration"
        aria-label="播放进度"
        :aria-valuetext="timestamp"
        @input="seek"
      />
      <span class="media-preview-time">{{ timestamp }}</span>
      <button
        type="button"
        class="icon"
        :aria-label="muted ? '取消静音' : '静音'"
        :title="muted ? '取消静音' : '静音'"
        @click="player.muted = !muted"
      >
        <Glyph :name="muted ? 'mute' : 'volume'" :size="15" />
      </button>
      <button
        v-if="kind === 'video'"
        type="button"
        class="icon"
        aria-label="切换全屏"
        title="切换全屏"
        @click="fullscreen"
      >
        <Glyph name="expand" :size="14" />
      </button>
    </div>
    <small v-if="failed" class="media-preview-error" role="status">无法播放此素材</small>
  </div>
</template>
