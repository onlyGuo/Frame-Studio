<script setup vapor>
import { ref } from 'vue'

const props = defineProps({ axis: String, label: String })
const emit = defineEmits(['resize'])
const dragging = ref(false)
let previous = 0

function position(event) {
  return props.axis === 'x' ? event.clientX : event.clientY
}
function start(event) {
  if (event.button !== 0) return
  previous = position(event)
  dragging.value = true
  event.currentTarget.focus()
  event.currentTarget.setPointerCapture(event.pointerId)
  event.preventDefault()
}
function move(event) {
  if (!dragging.value || !event.currentTarget.hasPointerCapture(event.pointerId)) return
  const next = position(event)
  emit('resize', previous - next)
  previous = next
}
function key(event) {
  const [before, after] = props.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  if (event.key !== before && event.key !== after) return
  event.preventDefault()
  emit('resize', event.key === before ? 24 : -24)
}
</script>

<template>
  <div
    class="dock-divider"
    :class="['dock-divider-' + axis, { dragging }]"
    role="separator"
    :aria-orientation="axis === 'x' ? 'vertical' : 'horizontal'"
    :aria-label="label"
    :title="label"
    tabindex="0"
    @pointerdown="start"
    @pointermove="move"
    @lostpointercapture="dragging = false"
    @keydown="key"
  />
</template>
