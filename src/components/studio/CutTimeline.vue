<script setup vapor>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { doc, asset, media, ui } from '../../store.js'
import { trackLabels } from '../../../shared/timeline-tracks.mjs'
import { onFrame, timecode } from '../../editor/timecode.mjs'
import Glyph from '../Glyph.vue'

const props = defineProps({
  rail: Array,
  rows: Array,
  tracks: Array,
  total: Number,
  pos: Number,
  selected: Array
})
const emit = defineEmits([
  'seek',
  'select',
  'select-all',
  'move',
  'split',
  'remove',
  'add-track',
  'delete-track',
  'insert-on-track',
  'move-selection'
])
const scroll = ref(null)
const heads = ref(null)
const viewport = ref(540)
const scrollLeft = ref(0)
const requestedZoom = ref(null)
const span = computed(() => Math.max(props.total, 1))
const zoom = computed(() => {
  if (requestedZoom.value === 'fit') return Math.min(180, Math.max(1, viewport.value - 1) / span.value)
  return requestedZoom.value ?? Math.max(32, Math.min(180, viewport.value / 24))
})
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
const selectedKeys = computed(() => new Set(props.selected.map((item) => item.key)))
const canSplit = (items) =>
  items.some(({ clip }) => {
    const offset = onFrame(props.pos - clip.start, doc.value.fps)
    return offset >= 0.04 && clip.duration - offset >= 0.04
  })
const canSplitSelected = computed(() => canSplit(props.selected))
const canSplitAll = computed(() => canSplit(props.rows))

/** 重叠音频在同一轨道内错行展示，仍按原时间同时播放。 */
const lanes = computed(() => {
  const groups = new Map()
  for (const row of props.rows) {
    if (!groups.has(row.trackId)) groups.set(row.trackId, [])
    groups.get(row.trackId).push(row)
  }
  return props.tracks.map((track) => {
    const ends = []
    const slotHeight = track.kind === 'visual' ? 38 : 29
    const items = (groups.get(track.id) || [])
      .sort((a, b) => a.clip.start - b.clip.start)
      .map((item) => {
        const slot = ends.findIndex((end) => end <= item.clip.start + 0.00001)
        const at = slot < 0 ? ends.length : slot
        ends[at] = item.clip.start + item.clip.duration
        return { ...item, top: at * slotHeight + 4, height: slotHeight - 3 }
      })
    return { track, items, height: Math.max(1, ends.length) * slotHeight + 6 }
  })
})
let observer
let rightHeld = false
let zoomedAt = -Infinity
function fit() {
  requestedZoom.value = 'fit'
  scroll.value.scrollLeft = 0
}
function wheel(event) {
  if (!rightHeld || !event.deltaY) return
  event.preventDefault()
  closeMenu(false)
  zoomedAt = performance.now()
  const x = Math.max(0, event.clientX - heads.value.getBoundingClientRect().right)
  const sec = (scroll.value.scrollLeft + x) / scale.value
  const direction = event.deltaY < 0 ? 1.18 : 1 / 1.18
  requestedZoom.value = Math.max(1, Math.min(180, zoom.value * direction))
  const next = sec * scale.value - x
  nextTick(() => {
    if (scroll.value) scroll.value.scrollLeft = Math.max(0, next)
  })
}
function scrub(e) {
  const el = e.currentTarget
  if (e.type === 'pointerdown') {
    if (e.button !== 0 || e.target.closest('.playhead-handle')) return
    el.setPointerCapture(e.pointerId)
  } else if (!el.hasPointerCapture(e.pointerId)) return
  emit('seek', (e.clientX - el.getBoundingClientRect().left) / scale.value)
}
function drag(e, clip) {
  e.dataTransfer.setData('application/x-frame-clip', clip.id)
  e.dataTransfer.effectAllowed = 'move'
}
function drop(e, target) {
  const id = e.dataTransfer.getData('application/x-frame-clip')
  const from = props.rail.findIndex((c) => c.id === id)
  const to = props.rail.findIndex((c) => c.id === target.id)
  if (from >= 0 && to >= 0 && from !== to) emit('move', from, to)
}
function scrollPlayhead() {
  if (!scroll.value) return
  const x = props.pos * scale.value
  if (x < scroll.value.scrollLeft || x > scroll.value.scrollLeft + viewport.value - 2)
    scroll.value.scrollLeft = Math.max(0, x - viewport.value * 0.2)
}

const menu = ref(null)
const menuItems = ref([])
let trigger = null
function closeMenu(restore = true) {
  if (!menu.value?.matches(':popover-open')) return
  menu.value.hidePopover()
  if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true })
  trigger = null
}
function openMenu(event, items) {
  if (performance.now() - zoomedAt < 330 || ui.modal || ui.busy) return
  closeMenu(false)
  trigger = event.currentTarget
  const anchor = trigger.getBoundingClientRect()
  const x = event.clientX || anchor.left + 8
  const y = event.clientY || anchor.bottom
  menuItems.value = items
  nextTick(() => {
    if (!menu.value?.isConnected) return
    menu.value.showPopover()
    menu.value.style.left = Math.max(4, Math.min(x, innerWidth - menu.value.offsetWidth - 4)) + 'px'
    menu.value.style.top = Math.max(4, Math.min(y, innerHeight - menu.value.offsetHeight - 4)) + 'px'
    ;(menu.value.querySelector('button:enabled') || menu.value).focus({ preventScroll: true })
  })
}
function viewportMenu(e) {
  if (e.target.closest('[data-timeline-menu]')) return
  trackMenu(e)
}
function trackMenu(e, track) {
  const items = Object.entries(trackLabels).map(([kind, label]) => ({
    label: '在下方新增' + label + '轨道',
    off: props.tracks.length >= 64,
    action: () => emit('add-track', kind, track?.id)
  }))
  if (track) {
    if (track.kind !== 'caption')
      items.push({
        label: '从素材库插入到 ' + track.label,
        action: () => emit('insert-on-track', track)
      })
    items.push(
      {
        label: '移动选中项到 ' + track.label,
        off: !props.selected.some((item) => item.kind === track.kind && item.trackId !== track.id),
        action: () => emit('move-selection', track)
      },
      {
        label: '删除轨道 ' + track.label,
        danger: true,
        action: () => emit('delete-track', track)
      }
    )
  }
  openMenu(e, items)
}
function splitMenu(e) {
  openMenu(e, [
    { label: '分割全部', off: !canSplitAll.value, action: () => emit('split', 'all') },
    { label: '分割选中项', off: !canSplitSelected.value, action: () => emit('split', 'selected') }
  ])
}
function clipMenu(e, item) {
  if (performance.now() - zoomedAt < 330) return
  const items = selectedKeys.value.has(item.key) ? props.selected : [item]
  if (!selectedKeys.value.has(item.key)) emit('select', item, e)
  openMenu(e, [
    { label: '定位到片段开头', action: () => emit('seek', item.clip.start) },
    { label: '分割选中项', off: !canSplit(items), action: () => emit('split', 'selected') },
    { label: '全选片段', action: () => emit('select-all') },
    { label: '删除选中项', danger: true, action: () => emit('remove') }
  ])
}
function menuKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu()
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault()
    const nodes = [...menu.value.querySelectorAll('button:enabled')]
    if (!nodes.length) return
    const index = nodes.indexOf(document.activeElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : (index + nodes.length + step) % nodes.length
    nodes[next].focus()
  }
}
function menuAction(item) {
  closeMenu()
  item.action()
}
function clickOutside(e) {
  if (!menu.value?.contains(e.target)) closeMenu(false)
}
function rightPress(e) {
  if (e.button !== 2) return
  rightHeld = true
  zoomedAt = -Infinity
}
function rightRelease(e) {
  if (e.button === 2) rightHeld = false
}
watch(() => props.pos, scrollPlayhead)
watch(
  () => ui.episodeId,
  () => closeMenu(false)
)
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (scroll.value && heads.value)
      viewport.value = Math.max(1, scroll.value.clientWidth - heads.value.offsetWidth)
  })
  observer.observe(scroll.value)
  observer.observe(heads.value)
  window.addEventListener('pointerdown', clickOutside)
  window.addEventListener('pointerup', rightRelease)
  window.addEventListener('pointercancel', closeOnBlur)
  window.addEventListener('wheel', wheel, { passive: false, capture: true })
  window.addEventListener('blur', closeOnBlur)
})
function closeOnBlur() {
  rightHeld = false
  closeMenu(false)
}
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointerdown', clickOutside)
  window.removeEventListener('pointerup', rightRelease)
  window.removeEventListener('pointercancel', closeOnBlur)
  window.removeEventListener('wheel', wheel, true)
  window.removeEventListener('blur', closeOnBlur)
})
</script>

<template>
  <section class="cut-timeline" aria-label="时间线">
    <header class="cut-tools">
      <div>
        <Glyph name="edit" :size="15" />
        <h2>时间线</h2>
        <span>{{ selected.length ? '已选 ' + selected.length + ' 项' : rail.length + ' 个画面片段' }}</span>
      </div>
      <div>
        <button title="新增轨道" @click="trackMenu($event)">
          <Glyph name="plus" :size="14" />
          轨道
        </button>
        <button :disabled="!canSplitSelected && !canSplitAll" @click="splitMenu" title="在播放头处分割（S）">
          <Glyph name="split" :size="14" />
          分割
        </button>
        <label class="inline cut-zoom" title="在时间线按住右键并滚动可缩放">
          缩放
          <input
            type="range"
            min="1"
            max="180"
            :value="zoom"
            @input="requestedZoom = $event.target.valueAsNumber"
          />
        </label>
        <button title="适配整条时间线" @click="fit">适配</button>
      </div>
    </header>
    <div
      ref="scroll"
      class="track-scroll"
      tabindex="0"
      aria-label="轨道区域"
      @scroll="scrollLeft = $event.target.scrollLeft"
      @pointerdown="rightPress"
      @contextmenu.prevent="viewportMenu"
    >
      <div class="track-layout">
        <div ref="heads" class="track-heads">
          <div class="track-clock">轨道</div>
          <button
            v-for="{ track, height } in lanes"
            :key="track.id"
            class="track-head"
            :class="{
              visual: track.kind === 'visual',
              subtitle: track.kind === 'caption',
              audio: track.kind === 'audio'
            }"
            :style="{ height: height + 'px' }"
            :aria-label="track.label + ' ' + trackLabels[track.kind] + '轨道选项'"
            data-timeline-menu
            @click="trackMenu($event, track)"
            @contextmenu.prevent.stop="trackMenu($event, track)"
          >
            <b>{{ track.label }}</b>
            <span>{{ trackLabels[track.kind] }}</span>
          </button>
        </div>
        <div class="rail" :style="{ width: width + 'px', '--tick-gap': interval * scale + 'px' }">
          <div class="ruler" @pointerdown="scrub" @pointermove="scrub">
            <span v-for="t in ticks" :key="t" :style="{ left: t * scale + 'px' }">
              {{ timecode(t, doc.fps).slice(t >= 3600 ? 0 : 3) }}
            </span>
            <button
              class="playhead-handle"
              :style="{ left: pos * scale + 'px' }"
              title="播放头分割菜单"
              aria-label="播放头分割菜单"
              data-timeline-menu
              @click="splitMenu"
              @contextmenu.prevent.stop="splitMenu"
            />
          </div>
          <div
            v-for="{ track, items, height } in lanes"
            :key="track.id"
            class="lane"
            :class="{
              'visual-lane': track.kind === 'visual',
              'caption-lane': track.kind === 'caption',
              sound: track.kind === 'audio'
            }"
            :style="{ height: height + 'px' }"
            data-timeline-menu
            @contextmenu.prevent.stop="trackMenu($event, track)"
          >
            <button
              v-for="item in items"
              :key="item.key"
              :draggable="track.kind === 'visual'"
              @dragstart="drag($event, item.clip)"
              @dragover="track.kind === 'visual' && $event.preventDefault()"
              @drop="track.kind === 'visual' && drop($event, item.clip)"
              :class="{ selected: selectedKeys.has(item.key) }"
              :aria-pressed="selectedKeys.has(item.key)"
              :style="{
                left: item.clip.start * scale + 'px',
                width: item.clip.duration * scale + 'px',
                top: item.top + 'px',
                height: item.height + 'px'
              }"
              :title="track.kind === 'caption' ? item.clip.caption : asset(item.clip.assetId)?.name"
              @click="$emit('select', item, $event)"
              @contextmenu.prevent.stop="clipMenu($event, item)"
            >
              <img
                v-if="
                  track.kind === 'visual' &&
                  asset(item.clip.assetId)?.kind === 'image' &&
                  item.clip.duration * scale > 76
                "
                :src="media(item.clip.assetId)"
                loading="lazy"
                alt=""
              />
              <span>{{ track.kind === 'caption' ? item.clip.caption : asset(item.clip.assetId)?.name }}</span>
            </button>
          </div>
          <div class="playhead" :style="{ left: pos * scale + 'px' }" />
        </div>
      </div>
    </div>
    <div ref="menu" popover="manual" class="timeline-menu" role="menu" tabindex="-1" @keydown="menuKey">
      <button
        v-for="item in menuItems"
        :key="item.label"
        role="menuitem"
        :disabled="item.off"
        :class="{ 'menu-danger': item.danger }"
        @click="menuAction(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </section>
</template>
