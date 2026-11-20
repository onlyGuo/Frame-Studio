<script setup vapor>
import { computed, ref, shallowRef, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { doc, asset, media, ui } from '../../store.js'
import { trackLabels } from '../../../shared/timeline-tracks.mjs'
import { onFrame, timecode } from '../../editor/timecode.mjs'
import { clipDrop } from '../../editor/timeline-drag.mjs'
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
  'drag-start',
  'drop-clip',
  'trim-clip',
  'split',
  'remove',
  'add-track',
  'delete-track',
  'insert-on-track',
  'move-selection'
])
const scroll = ref(null)
const heads = ref(null)
const railElement = ref(null)
const ruler = ref(null)
const viewport = ref(540)
const scrollLeft = ref(0)
const requestedZoom = ref(null)
const extension = ref(0)
const magnet = ref(true)
const dragPreview = shallowRef(null)
const trackIcons = { visual: 'film', caption: 'captions', audio: 'audio' }
const span = computed(() => Math.max(props.total, 1))
const zoom = computed(() => {
  if (requestedZoom.value === 'fit') return Math.min(180, Math.max(1, viewport.value - 1) / span.value)
  return requestedZoom.value ?? Math.max(32, Math.min(180, viewport.value / 24))
})
const scale = computed(() => Math.min(zoom.value, 8000000 / span.value))
const width = computed(() =>
  Math.max(
    viewport.value,
    Math.ceil(span.value * scale.value) +
      extension.value +
      1 +
      (requestedZoom.value === 'fit' ? 0 : Math.min(190, viewport.value * 0.28))
  )
)
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

/** 重叠片段在同一轨道内错行展示，音频仍按原时间同时播放。 */
const lanes = computed(() => {
  const groups = new Map()
  for (const row of props.rows) {
    if (!groups.has(row.trackId)) groups.set(row.trackId, [])
    groups.get(row.trackId).push(row)
  }
  let top = 0
  return props.tracks.map((track) => {
    const ends = []
    const slotHeight = track.kind === 'visual' ? 40 : 32
    const items = (groups.get(track.id) || [])
      .sort((a, b) => a.clip.start - b.clip.start)
      .map((item) => {
        const slot = ends.findIndex((end) => end <= item.clip.start + 0.00001)
        const at = slot < 0 ? ends.length : slot
        ends[at] = item.clip.start + item.clip.duration
        return { ...item, top: at * slotHeight + 4, height: slotHeight - 3 }
      })
    const height = Math.max(1, ends.length) * slotHeight + 6
    const lane = { track, items, top, height }
    top += height
    return lane
  })
})
const usedHeight = computed(() => {
  const last = lanes.value.at(-1)
  return last ? last.top + last.height : 0
})
const dragSource = computed(() => dragPreview.value?.item)
const activeTrack = computed(() => dragPreview.value?.target.track?.id)
const clipLabel = (item) =>
  item.kind === 'caption' ? item.clip.caption : asset(item.clip.assetId)?.name || '素材缺失'
let observer
let rightHeld = false
let zoomedAt = -Infinity
function fit() {
  extension.value = 0
  requestedZoom.value = 'fit'
  scroll.value.scrollLeft = 0
}
function wheel(event) {
  if (!rightHeld || gesture || !event.deltaY) return
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
function scrollPlayhead() {
  if (!scroll.value || gesture?.active) return
  const x = props.pos * scale.value
  if (x < scroll.value.scrollLeft || x > scroll.value.scrollLeft + viewport.value - 2)
    scroll.value.scrollLeft = Math.max(0, x - viewport.value * 0.2)
}

let gesture = null
let dragFrame = 0
let suppressClick = false

function pressClip(event, item) {
  if (event.button !== 0 || !event.isPrimary || gesture || ui.modal || ui.busy) return
  suppressClick = false
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  const button = event.currentTarget
  button.getAnimations().forEach((animation) => animation.cancel())
  gesture = {
    edge: event.target.dataset.trim,
    scroll: scroll.value.scrollLeft,
    pointer: event.pointerId,
    button,
    item,
    x: event.clientX,
    y: event.clientY,
    originX: event.clientX,
    originY: event.clientY,
    offset: event.clientX - button.getBoundingClientRect().left,
    active: false
  }
  button.setPointerCapture(event.pointerId)
}
function clickClip(event, item) {
  if (event.detail && suppressClick) {
    suppressClick = false
    return
  }
  emit('select', item, event)
}
function movePointer(event) {
  if (gesture?.pointer !== event.pointerId) return
  gesture.x = event.clientX
  gesture.y = event.clientY
  if (!gesture.active) {
    if (Math.hypot(gesture.x - gesture.originX, gesture.y - gesture.originY) < 5) return
    gesture.active = true
    suppressClick = true
    emit('drag-start')
  }
  if (!dragFrame) dragFrame = requestAnimationFrame(updateDrag)
}

/** 不兼容轨道按指针所在的半行决定插入位置，轨道接缝也可建立新轨道。 */
function dropTarget(kind, y) {
  const index = lanes.value.findIndex((lane) => y < lane.top + lane.height)
  if (index < 0) return { beforeTrackId: null, line: usedHeight.value }
  const lane = lanes.value[index]
  const offset = y - lane.top
  if (lane.track.kind === kind && offset >= 4 && offset < lane.height - 4)
    return { track: lane.track, top: lane.top }
  if (offset < lane.height / 2) return { beforeTrackId: lane.track.id, line: lane.top }
  return { beforeTrackId: lanes.value[index + 1]?.track.id || null, line: lane.top + lane.height }
}

/** 用最终落点绘制拖影，变动只在放手后写回工程。 */
function previewAt(bounds) {
  const { item, x, y, offset } = gesture
  const rulerRect = ruler.value.getBoundingClientRect()
  if (x < bounds.left || x >= bounds.right || y < rulerRect.bottom || y >= bounds.bottom) return null
  const railRect = railElement.value.getBoundingClientRect()
  const base = ruler.value.offsetHeight
  const target = gesture.edge
    ? {
        track: props.tracks.find((t) => t.id === item.trackId),
        top: lanes.value.find((l) => l.track.id === item.trackId).top
      }
    : dropTarget(item.kind, y - railRect.top - base)
  const blocked = !target.track && props.tracks.length >= 64
  const overHeads = x < heads.value.getBoundingClientRect().right
  const desired = overHeads ? item.clip.start : Math.max(0, (x - railRect.left - offset) / scale.value)
  let placement = { start: item.clip.start }
  if (!overHeads && Math.abs(desired - item.clip.start) * scale.value >= 1) {
    const points = []
    if (magnet.value && !blocked) {
      points.push({ time: props.pos, label: '播放头' }, { time: 0, label: '时间线起点' })
      const edges = new Set()
      for (const row of props.rows) {
        if (row.key === item.key) continue
        edges.add(row.clip.start)
        edges.add(row.clip.start + row.clip.duration)
      }
      for (const time of edges) points.push({ time, label: '片段边缘' })
    }
    placement = clipDrop(desired, item.clip.duration, scale.value, doc.value.fps, points)
  }
  if (gesture.edge) {
    const clip = item.clip
    const delta = onFrame(
      (x - gesture.originX + scroll.value.scrollLeft - gesture.scroll) / scale.value,
      doc.value.fps
    )
    const media = asset(clip.assetId)
    const sourceBound = media && media.kind !== 'image'
    const minimum = Math.ceil(0.04 * doc.value.fps) / doc.value.fps
    if (gesture.edge === 'start') {
      const change = Math.max(
        -clip.start,
        sourceBound ? -clip.trim : -clip.start,
        Math.min(clip.duration - minimum, delta)
      )
      placement = {
        start: clip.start + change,
        duration: clip.duration - change,
        trim: sourceBound ? clip.trim + change : clip.trim
      }
    } else {
      placement = {
        start: clip.start,
        duration: Math.max(
          minimum,
          Math.min(sourceBound ? media.duration - clip.trim : 86400, clip.duration + delta)
        ),
        trim: clip.trim
      }
    }
  }
  return {
    item,
    target,
    blocked,
    placement,
    top: base + (target.track ? target.top : target.line) + 5,
    line: target.track ? null : base + target.line,
    status: gesture.edge
      ? '裁切片段'
      : target.track
        ? target.track.id === item.trackId
          ? '移动片段'
          : '移入 ' + target.track.label
        : blocked
          ? '轨道数量已达上限'
          : '新建' + trackLabels[item.kind] + '轨道'
  }
}
function scrollSpeed(distance) {
  return Math.ceil(Math.max(0, 24 - distance) / 2)
}
function updateDrag() {
  dragFrame = 0
  if (!gesture?.active) return
  const { x, y } = gesture
  const pane = scroll.value
  const bounds = pane.getBoundingClientRect()
  const left = heads.value.getBoundingClientRect().right
  const top = ruler.value.getBoundingClientRect().bottom
  const previousX = pane.scrollLeft
  const previousY = pane.scrollTop
  if (
    x >= bounds.right - 24 &&
    x < bounds.right &&
    y >= top &&
    y < bounds.bottom &&
    pane.scrollLeft + pane.clientWidth >= pane.scrollWidth - 24 &&
    width.value < 8000000
  ) {
    extension.value += 120
    dragFrame = requestAnimationFrame(updateDrag)
  }
  if (x >= left && x < bounds.right && y >= top && y < bounds.bottom)
    pane.scrollLeft += scrollSpeed(bounds.right - x) - scrollSpeed(x - left)
  if (x >= bounds.left && x < bounds.right && y >= top && y < bounds.bottom)
    pane.scrollTop += scrollSpeed(bounds.bottom - y) - scrollSpeed(y - top)
  dragPreview.value = previewAt(bounds)
  if (previousX !== pane.scrollLeft || previousY !== pane.scrollTop)
    dragFrame = requestAnimationFrame(updateDrag)
}
function cancelDrag() {
  if (!gesture) return
  const { button, pointer } = gesture
  gesture = null
  cancelAnimationFrame(dragFrame)
  dragFrame = 0
  dragPreview.value = null
  if (button.hasPointerCapture(pointer)) button.releasePointerCapture(pointer)
}
function captureLost(event) {
  if (gesture?.pointer === event.pointerId) cancelDrag()
}
function dragKey(event) {
  if (!gesture || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  cancelDrag()
}
function endDrag(event) {
  if (gesture?.pointer !== event.pointerId) return
  if (!gesture.active) return cancelDrag()
  gesture.x = event.clientX
  gesture.y = event.clientY
  const preview = previewAt(scroll.value.getBoundingClientRect())
  const trimming = gesture.edge
  cancelDrag()
  if (trimming && preview) {
    emit('trim-clip', preview)
    return
  }
  if (!preview || preview.blocked || ui.modal || ui.busy) return
  const { item, target, placement, top } = preview
  if (!changesPosition(item, placement) && target.track?.id === item.trackId) return
  const startRect = railElement.value.getBoundingClientRect()
  const x = startRect.left + placement.start * scale.value
  const y = startRect.top + top
  emit('drop-clip', { item, target, placement })
  nextTick(() => {
    const button = railElement.value?.querySelector('[data-clip-key="' + item.key + '"]')
    if (!button || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const rect = button.getBoundingClientRect()
    const motion = { duration: 205, easing: 'cubic-bezier(.2,.75,.22,1)' }
    const lane = button.closest('.lane')
    if (!target.track && lane.dataset.trackId !== item.trackId) {
      const head = heads.value.querySelector('[data-track-id="' + lane.dataset.trackId + '"]')
      for (const row of [lane, head]) {
        row?.animate(
          [
            { opacity: 0.5, boxShadow: 'inset 0 1px var(--track-tone)' },
            { opacity: 1, boxShadow: 'inset 0 1px transparent' }
          ],
          motion
        )
      }
    }
    button.animate(
      [
        {
          transform: 'translate(' + (x - rect.left) + 'px, ' + (y - rect.top) + 'px)',
          filter: 'brightness(1.2)'
        },
        { transform: 'translate(0, 0)', filter: 'brightness(1)' }
      ],
      motion
    )
  })
}
function changesPosition(item, placement) {
  return Math.abs(item.clip.start - placement.start) > 0.000001
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
  () => {
    extension.value = 0
  }
)
watch(() => [ui.episodeId, ui.modal, ui.busy], closeOnBlur)
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
  window.addEventListener('keydown', dragKey, true)
})
function closeOnBlur() {
  rightHeld = false
  cancelDrag()
  closeMenu(false)
}
onBeforeUnmount(() => {
  cancelDrag()
  observer?.disconnect()
  window.removeEventListener('pointerdown', clickOutside)
  window.removeEventListener('pointerup', rightRelease)
  window.removeEventListener('pointercancel', closeOnBlur)
  window.removeEventListener('wheel', wheel, true)
  window.removeEventListener('blur', closeOnBlur)
  window.removeEventListener('keydown', dragKey, true)
})
</script>

<template>
  <section class="cut-timeline" aria-label="时间线">
    <header class="cut-tools">
      <div>
        <Glyph name="edit" :size="15" />
        <h2>时间线</h2>
        <span v-if="dragPreview" class="cut-drag-status" aria-live="polite">
          {{ dragPreview.status }} · {{ timecode(dragPreview.placement.start, doc.fps) }}
        </span>
        <span v-else>
          {{ selected.length ? '已选 ' + selected.length + ' 项' : rows.length + ' 个片段' }}
        </span>
      </div>
      <div>
        <button
          class="cut-magnet"
          :aria-pressed="magnet"
          title="吸附到播放头与片段边缘"
          @click="magnet = !magnet"
        >
          <Glyph name="magnet" :size="14" />
          吸附
        </button>
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
      :class="{ 'is-dragging': dragPreview }"
      tabindex="0"
      aria-label="轨道区域"
      @scroll="scrollLeft = $event.target.scrollLeft"
      @pointerdown="rightPress"
      @pointermove="movePointer"
      @pointerup="endDrag"
      @contextmenu.prevent="viewportMenu"
    >
      <div class="track-layout" :data-preview-kind="dragSource?.kind">
        <div ref="heads" class="track-heads">
          <div class="track-clock">
            <Glyph name="layers" :size="13" />
            <span>轨道列表</span>
          </div>
          <button
            v-for="{ track, items, height } in lanes"
            :key="track.id"
            class="track-head"
            :class="{ 'drop-active': activeTrack === track.id }"
            :data-track-kind="track.kind"
            :data-track-id="track.id"
            :style="{ height: height + 'px' }"
            :aria-label="track.label + ' ' + trackLabels[track.kind] + '轨道选项'"
            data-timeline-menu
            @click="trackMenu($event, track)"
            @contextmenu.prevent.stop="trackMenu($event, track)"
          >
            <span class="track-icon"><Glyph :name="trackIcons[track.kind]" :size="15" /></span>
            <span class="track-name">
              <strong>{{ trackLabels[track.kind] }}</strong>
              <b>{{ track.label }}</b>
            </span>
            <span class="track-count" :title="items.length + ' 个片段'">{{ items.length }}</span>
            <Glyph class="track-options" name="more" :size="13" />
          </button>
        </div>
        <div
          ref="railElement"
          class="rail"
          :style="{
            width: width + 'px',
            '--tick-gap': interval * scale + 'px',
            '--visible-left': scrollLeft + 'px'
          }"
        >
          <div ref="ruler" class="ruler" @pointerdown="scrub" @pointermove="scrub">
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
            :class="{ 'drop-active': activeTrack === track.id }"
            :data-track-kind="track.kind"
            :data-track-id="track.id"
            :style="{ height: height + 'px' }"
            data-timeline-menu
            @contextmenu.prevent.stop="trackMenu($event, track)"
          >
            <button
              v-for="item in items"
              :key="item.key"
              class="timeline-clip"
              :class="{
                selected: selectedKeys.has(item.key),
                'drag-source': dragSource?.key === item.key
              }"
              :data-clip-key="item.key"
              :aria-pressed="selectedKeys.has(item.key)"
              :style="{
                left: item.clip.start * scale + 'px',
                width: item.clip.duration * scale + 'px',
                top: item.top + 'px',
                height: item.height + 'px'
              }"
              :title="clipLabel(item)"
              @pointerdown="pressClip($event, item)"
              @lostpointercapture="captureLost"
              @click="clickClip($event, item)"
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
                draggable="false"
                alt=""
              />
              <span>{{ clipLabel(item) }}</span>
              <i
                v-if="item.clip.duration * scale >= 24"
                class="clip-trim clip-trim-start"
                data-trim="start"
                title="拖动裁切入点"
              />
              <i
                v-if="item.clip.duration * scale >= 24"
                class="clip-trim clip-trim-end"
                data-trim="end"
                title="拖动裁切出点"
              />
            </button>
          </div>
          <div class="track-tail" />
          <div class="playhead" :style="{ left: pos * scale + 'px' }" />
          <template v-if="dragPreview">
            <div
              v-if="dragPreview.line !== null && !dragPreview.blocked"
              class="track-insert-preview"
              :style="{ top: dragPreview.line + 'px' }"
              aria-hidden="true"
            >
              <span>
                <Glyph name="plus" :size="12" />
                {{ dragPreview.status }}
              </span>
            </div>
            <div
              v-if="!dragPreview.blocked"
              class="clip-ghost"
              :style="{
                left: dragPreview.placement.start * scale + 'px',
                top: dragPreview.top + 'px',
                width: (dragPreview.placement.duration ?? dragPreview.item.clip.duration) * scale + 'px',
                height: dragPreview.item.height + 'px'
              }"
              aria-hidden="true"
            >
              <Glyph :name="trackIcons[dragPreview.item.kind]" :size="14" />
              <span>{{ clipLabel(dragPreview.item) }}</span>
            </div>
            <div
              v-if="dragPreview.placement.snap"
              class="snap-guide"
              :style="{ left: dragPreview.placement.snap.time * scale + 'px' }"
              aria-hidden="true"
            >
              <span>
                <Glyph name="magnet" :size="11" />
                {{ dragPreview.placement.snap.label }}
              </span>
            </div>
          </template>
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
