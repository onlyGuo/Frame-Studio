<script setup vapor>
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import Glyph from './Glyph.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  modelValue: [String, Number],
  options: { type: Array, required: true },
  placeholder: { type: String, default: '请选择' },
  disabled: Boolean,
  icon: String
})
const emit = defineEmits(['update:modelValue'])
const id = useId()
const anchor = '--select-' + id
const trigger = ref(null)
const menu = ref(null)
const opened = ref(false)
const active = ref(-1)
const items = computed(() =>
  props.options.map((item) => (typeof item === 'object' ? item : { value: item, label: String(item) }))
)
const selected = computed(() => items.value.findIndex((item) => item.value === props.modelValue))
let search = ''
let searchTime = 0

function highlight(index) {
  active.value = index
  nextTick(() => {
    if (opened.value) menu.value?.children[index]?.scrollIntoView({ block: 'nearest', container: 'nearest' })
  })
}
function outside(event) {
  if (!trigger.value?.contains(event.target) && !menu.value?.contains(event.target)) close()
}
function close() {
  if (!opened.value) return
  menu.value?.hidePopover()
  opened.value = false
  search = ''
  document.removeEventListener('pointerdown', outside, true)
}
/** 弹层与触发按钮留在同一对话框内，避免受滚动区域裁切。 */
function open(direction = 1) {
  if (props.disabled || !items.value.some((item) => !item.disabled)) return
  menu.value.showPopover()
  opened.value = true
  document.addEventListener('pointerdown', outside, true)
  const index = selected.value
  highlight(
    index >= 0 && !items.value[index].disabled
      ? index
      : nextEnabled(direction > 0 ? -1 : items.value.length, direction)
  )
}
function nextEnabled(from, direction) {
  for (let index = from + direction; index >= 0 && index < items.value.length; index += direction) {
    if (!items.value[index].disabled) return index
  }
  return active.value
}
function choose(index) {
  const item = items.value[index]
  if (!item || item.disabled) return
  close()
  emit('update:modelValue', item.value)
}
/** 键盘焦点留在触发按钮，方向键只移动列表的活动选项。 */
function key(event) {
  const { key } = event
  if (key === 'Tab') {
    close()
    return
  }
  if (key === 'Escape' && opened.value) {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    event.preventDefault()
    const direction = key === 'ArrowUp' || key === 'End' ? -1 : 1
    if (!opened.value) open(direction)
    else
      highlight(
        nextEnabled(key === 'Home' ? -1 : key === 'End' ? items.value.length : active.value, direction)
      )
  } else if (key === 'Enter' || key === ' ') {
    event.preventDefault()
    if (opened.value) choose(active.value)
    else open()
  } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    if (!opened.value) open()
    const now = Date.now()
    search = (now - searchTime > 600 ? '' : search) + key.toLocaleLowerCase()
    searchTime = now
    const index = items.value.findIndex(
      (item) => !item.disabled && item.label.toLocaleLowerCase().startsWith(search)
    )
    if (index >= 0) highlight(index)
  }
}
onBeforeUnmount(close)
</script>
<template>
  <button
    v-bind="$attrs"
    ref="trigger"
    class="studio-select"
    type="button"
    role="combobox"
    :disabled="disabled || !items.some((item) => !item.disabled)"
    :style="{ anchorName: anchor }"
    :data-value="modelValue"
    :aria-controls="id"
    :aria-expanded="opened"
    :aria-activedescendant="opened && active >= 0 ? id + '-' + active : undefined"
    @click="opened ? close() : open()"
    @keydown="key"
    @blur="close"
  >
    <Glyph v-if="icon" :name="icon" :size="15" />
    <span>{{ items[selected]?.label ?? placeholder }}</span>
    <Glyph class="studio-select-arrow" name="down" :size="13" />
  </button>
  <div
    :id="id"
    ref="menu"
    class="studio-select-menu"
    :style="{ positionAnchor: anchor }"
    popover="manual"
    role="listbox"
    @mousedown.prevent
  >
    <div
      v-for="(item, index) in items"
      :id="id + '-' + index"
      :key="item.value"
      role="option"
      :aria-selected="index === selected"
      :aria-disabled="item.disabled || undefined"
      :class="{ active: index === active }"
      :data-value="item.value"
      @pointermove="!item.disabled && (active = index)"
      @click.prevent.stop="choose(index)"
    >
      <Glyph name="check" :size="13" />
      <span>{{ item.label }}</span>
    </div>
  </div>
</template>
