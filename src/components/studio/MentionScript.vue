<script setup vapor>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId, watch } from 'vue'
import { mentionToken, parseMentions } from '../../../shared/mentions.mjs'
import { roleOutfits, roleOutfit, settingImage } from '../../../shared/outfits.mjs'
import {
  chipToken,
  mentionName,
  paintScript,
  scriptFromDom,
  scriptSelection,
  setScriptSelection
} from '../../editor/mention-dom.mjs'
import './mention-script.css'

const props = defineProps({
  modelValue: { type: String, required: true },
  cards: { type: Array, required: true },
  imageUrl: Function,
  label: { type: String, default: '分镜脚本' },
  detail: { type: String, default: '画面与运镜' },
  manageLabel: { type: String, default: '管理设定卡' },
  kinds: { type: Array, default: () => ['角色', '场景', '道具'] },
  toolbar: { type: Boolean, default: true }
})
const emit = defineEmits(['update:modelValue', 'manage', 'history'])
const editor = ref(null),
  menu = ref(null),
  trigger = ref(null),
  active = ref(0)
const menuStyle = ref({})
const fieldId = useId()
const validation = ref('')
const maxScriptLength = 80000
const kinds = computed(() => props.kinds)
const index = computed(() => new Map(props.cards.map((card) => [card.id, card])))
const matches = computed(() => {
  const query = trigger.value?.query?.trim().toLowerCase() || ''
  return props.cards
    .filter((card) => !trigger.value?.kind || card.type === trigger.value.kind)
    .flatMap((card) => {
      const item = (outfit, explicit) => ({
        id: card.id,
        outfitId: explicit ? outfit.id : undefined,
        name: outfit
          ? card.name + ' · ' + (explicit ? outfit.name : '默认服饰（' + outfit.name + '）')
          : card.name,
        type: card.type,
        assetId: explicit ? outfit.assetId : settingImage(card),
        notes: outfit?.notes || card.notes
      })
      return [
        item(card.outfits ? roleOutfit(card) : undefined, false),
        ...(card.outfits ? roleOutfits(card).map((outfit) => item(outfit, true)) : [])
      ]
    })
    .filter((entry) => (entry.name + ' ' + entry.type).toLowerCase().includes(query))
})
let composing = false
let savedSelection = null
let rendered = ''
let displayedCards = ''

/** 当前光标两侧都使用模型坐标。点击类型入口时保留选中的文本范围。 */
function remember() {
  const selection = editor.value && scriptSelection(editor.value)
  if (selection) savedSelection = selection
  return selection
}
function dismiss() {
  trigger.value = null
}
function displayKey(text) {
  return JSON.stringify(
    parseMentions(text)
      .filter((p) => p.type === 'card')
      .map((p) => {
        const card = index.value.get(p.id)
        return [p.id, card?.type, mentionName(p, card)]
      })
  )
}
/** 外部改名、智能体写入、撤销都会刷新标签。普通连续输入保留原生 DOM 与选区。 */
function render(text, selection) {
  const el = editor.value
  if (!el || composing) return
  const key = displayKey(text)
  if (rendered === text && displayedCards === key && scriptFromDom(el) === text) return
  if (selection === undefined && document.activeElement === el) selection = remember()
  paintScript(el, text, index.value)
  rendered = text
  displayedCards = key
  if (selection) setScriptSelection(el, selection.start, selection.end)
}
watch([() => props.modelValue, () => props.cards], () => render(props.modelValue))
function accepts(text) {
  validation.value = text.length > maxScriptLength ? '分镜脚本最多可写 80,000 字符（含引用标记）。' : ''
  return !validation.value
}
function update(value) {
  if (value !== props.modelValue) emit('update:modelValue', value)
}
/** 显式换行、选择资产、粘贴和删除标签共用一次选区替换。 */
function replace(start, end, insertion) {
  const el = editor.value
  const current = scriptFromDom(el)
  const next = current.slice(0, start) + insertion + current.slice(end)
  if (!accepts(next)) return
  dismiss()
  el.focus({ preventScroll: true })
  const caret = start + insertion.length
  paintScript(el, next, index.value)
  rendered = next
  displayedCards = displayKey(next)
  setScriptSelection(el, caret)
  savedSelection = { start: caret, end: caret }
  update(next)
}

/** 使用定位层避开属性面板裁切，选项在窗口边缘自动翻转。 */
function positionMenu() {
  if (!trigger.value || !editor.value) return
  const field = editor.value.getBoundingClientRect()
  const range = window.getSelection().rangeCount && window.getSelection().getRangeAt(0)
  const cursor =
    !trigger.value.kind &&
    range &&
    editor.value.contains(range.commonAncestorContainer) &&
    range.getBoundingClientRect()
  const rect = cursor?.height ? cursor : field
  const width = Math.min(336, window.innerWidth - 24)
  const room = window.innerHeight - rect.bottom - 12
  const above = room < 208 && rect.top > room
  menuStyle.value = {
    left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px',
    width: width + 'px',
    top: above ? 'auto' : rect.bottom + 5 + 'px',
    bottom: above ? window.innerHeight - rect.top + 5 + 'px' : 'auto',
    maxHeight: Math.max(120, Math.min(306, above ? rect.top - 14 : room)) + 'px'
  }
}
function open(range, query = '', kind = '') {
  trigger.value = { ...range, query, kind }
  active.value = 0
  positionMenu()
}
function detectQuery() {
  if (composing) return
  const sel = remember()
  if (!sel || sel.start !== sel.end) return dismiss()
  const head = scriptFromDom(editor.value).slice(0, sel.start)
  const match = /[@＠]([\p{L}\p{M}\p{N}_-]{0,80})$/u.exec(head)
  if (!match || /[a-zA-Z0-9._+%-]/.test(head[match.index - 1] || '')) return dismiss()
  open({ start: match.index, end: sel.end }, match[1])
}
function input() {
  if (composing) return
  const text = scriptFromDom(editor.value)
  const selection = remember()
  if (!accepts(text)) {
    render(props.modelValue, selection)
    dismiss()
    return
  }
  // 输入法或辅助技术可能插入块元素；恢复成编辑器统一的换行文本。
  const rawMarker = Array.from(editor.value.childNodes).some(
    (n) => n.nodeType === Node.TEXT_NODE && n.data.includes('@{card:')
  )
  if (rawMarker || editor.value.querySelector('div,p,br')) {
    paintScript(editor.value, text, index.value)
    if (selection) setScriptSelection(editor.value, selection.start, selection.end)
  }
  rendered = text
  displayedCards = displayKey(text)
  update(text)
  detectQuery()
}
function openToolbar(kind) {
  const sel = remember() || savedSelection || { start: props.modelValue.length, end: props.modelValue.length }
  editor.value.focus({ preventScroll: true })
  setScriptSelection(editor.value, sel.start, sel.end)
  open(sel, '', kind)
}
function pick(card) {
  if (card && trigger.value)
    replace(trigger.value.start, trigger.value.end, mentionToken(card.id, card.outfitId))
}
/** 将未匹配的输入交回宿主，以便在原光标位置插入新建的设定卡。 */
function manage() {
  const pending = { ...trigger.value, source: props.modelValue }
  dismiss()
  emit('manage', pending)
}
/** 点击已有标签可直接替换资产；删除按钮只移除此处出场。 */
function clickBody(event) {
  const chip = event.target.closest('[data-card-id]')
  if (!chip) return trigger.value ? detectQuery() : remember()
  const before = document.createRange()
  before.selectNodeContents(editor.value)
  before.setEndBefore(chip)
  const start = scriptFromDom(before.cloneContents()).length
  const end = start + chipToken(chip).length
  if (event.target.closest('[data-remove]')) return replace(start, end, '')
  setScriptSelection(editor.value, start, end)
  open({ start, end })
}
function beforeInput(event) {
  if (composing || event.isComposing) return
  if (['insertLineBreak', 'insertParagraph'].includes(event.inputType)) {
    event.preventDefault()
    const sel = remember()
    if (sel) replace(sel.start, sel.end, '\n')
  }
  if (['historyUndo', 'historyRedo'].includes(event.inputType)) {
    event.preventDefault()
    dismiss()
    emit('history', event.inputType === 'historyRedo')
  }
}
function keydown(event) {
  if (composing || event.isComposing || event.keyCode === 229) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.stopPropagation()
    dismiss()
    emit('history', event.shiftKey)
    return
  }
  if (trigger.value && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) {
    if (event.key === 'Tab') return dismiss()
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') return dismiss()
    if (event.key === 'Enter') return pick(matches.value[active.value])
    const count = matches.value.length
    if (count) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    nextTick(() => menu.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
    return
  }
  if (event.key !== 'Backspace' && event.key !== 'Delete') return
  const sel = remember()
  if (!sel || sel.start !== sel.end) return
  const text = scriptFromDom(editor.value)
  const matched =
    event.key === 'Backspace'
      ? /@\{card:[\w-]{1,80}(?::[\w-]{1,80})?\}$/.exec(text.slice(0, sel.start))
      : /^@\{card:[\w-]{1,80}(?::[\w-]{1,80})?\}/.exec(text.slice(sel.start))
  if (!matched) return
  event.preventDefault()
  replace(
    event.key === 'Backspace' ? sel.start - matched[0].length : sel.start,
    event.key === 'Delete' ? sel.end + matched[0].length : sel.end,
    ''
  )
}
/** 对外复制可读资产名，在工作室内附带原始标记以保留引用。 */
function copy(event) {
  const sel = remember()
  if (!sel || sel.start === sel.end) return
  const text = scriptFromDom(editor.value).slice(sel.start, sel.end)
  const plain = parseMentions(text)
    .map((p) => (p.type === 'text' ? p.text : '@' + mentionName(p, index.value.get(p.id))))
    .join('')
  event.preventDefault()
  event.clipboardData.setData('text/plain', plain)
  event.clipboardData.setData(
    'application/x-frame-shot-script',
    JSON.stringify({
      text,
      names: Object.fromEntries(
        parseMentions(text)
          .filter((p) => p.type === 'card')
          .map((p) => [mentionToken(p.id, p.outfitId), mentionName(p, index.value.get(p.id))])
      )
    })
  )
  if (event.type === 'cut') replace(sel.start, sel.end, '')
}
function paste(event) {
  event.preventDefault()
  const sel = remember()
  if (!sel) return
  let text = event.clipboardData.getData('text/plain')
  const privateData = event.clipboardData.getData('application/x-frame-shot-script')
  if (privateData) {
    try {
      const source = JSON.parse(privateData)
      if (typeof source.text === 'string')
        text = parseMentions(source.text)
          .map((p) => {
            if (p.type === 'text') return p.text
            const token = mentionToken(p.id, p.outfitId)
            const card = index.value.get(p.id)
            return card && (!p.outfitId || roleOutfit(card, p.outfitId))
              ? token
              : String(source.names?.[token] || source.names?.[p.id] || p.id)
          })
          .join('')
    } catch {
      /* 其他应用可能只提供普通剪贴板文本。 */
    }
  }
  replace(sel.start, sel.end, text.replace(/\r\n?/g, '\n'))
}
function compositionEnd() {
  composing = false
  input()
}
function outside(event) {
  if (
    trigger.value &&
    !editor.value?.parentElement?.contains(event.target) &&
    !menu.value?.contains(event.target)
  )
    dismiss()
}
onMounted(() => {
  render(props.modelValue)
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('resize', positionMenu)
  document.addEventListener('scroll', positionMenu, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('resize', positionMenu)
  document.removeEventListener('scroll', positionMenu, true)
})
</script>

<template>
  <div class="mention-script">
    <div class="mention-heading">
      <strong :id="fieldId + '-label'">
        {{ label }}
        <small v-if="detail">{{ detail }}</small>
      </strong>
      <div v-if="toolbar" class="mention-tools" aria-label="插入设定资产">
        <button
          v-for="kind in kinds"
          :key="kind"
          type="button"
          :aria-label="'插入' + kind"
          :title="'插入' + kind"
          @mousedown.prevent
          @click="openToolbar(kind)"
        >
          <span>@</span>
          {{ kind }}
        </button>
      </div>
    </div>
    <div
      ref="editor"
      class="mention-edit"
      role="textbox"
      aria-multiline="true"
      :aria-labelledby="fieldId + '-label'"
      aria-autocomplete="list"
      :aria-controls="trigger ? fieldId + '-menu' : undefined"
      :aria-activedescendant="trigger && matches[active] ? fieldId + '-' + active : undefined"
      contenteditable="true"
      data-placeholder="描述镜头里的动作、画面和运镜，输入 @ 引用资产…"
      @input="input"
      @beforeinput="beforeInput"
      @keydown="keydown"
      @keyup.left="detectQuery"
      @keyup.right="detectQuery"
      @click="clickBody"
      @blur="dismiss"
      @compositionstart="composing = true"
      @compositionend="compositionEnd"
      @copy="copy"
      @cut="copy"
      @paste="paste"
      @drop.prevent
    />
    <small v-if="validation" role="status" class="mention-validation">{{ validation }}</small>
    <Teleport to="body">
      <div v-if="trigger" ref="menu" class="mention-menu" :style="menuStyle" @mousedown.prevent>
        <header>
          <strong>{{ trigger.kind ? '插入' + trigger.kind : '插入设定资产' }}</strong>
          <span>{{ matches.length }} 项</span>
        </header>
        <div :id="fieldId + '-menu'" class="mention-choices" role="listbox" aria-label="设定资产">
          <button
            v-for="(card, i) in matches"
            :id="fieldId + '-' + i"
            :key="mentionToken(card.id, card.outfitId)"
            type="button"
            role="option"
            :aria-selected="i === active"
            @mousemove="active = i"
            @click="pick(card)"
          >
            <img
              v-if="imageUrl?.(card.assetId)"
              class="mention-thumb"
              :src="imageUrl(card.assetId)"
              alt=""
              loading="lazy"
            />
            <span class="mention-kind" :data-kind="card.type">{{ card.type }}</span>
            <span class="mention-choice-info">
              <strong>{{ card.name }}</strong>
              <small v-if="card.notes">{{ card.notes }}</small>
            </span>
            <span v-if="i === active" class="mention-enter" aria-hidden="true">↵</span>
          </button>
        </div>
        <div v-if="!matches.length" class="mention-empty">
          {{ cards.length ? '没有匹配的设定资产' : '工程中还没有设定资产' }}
          <button type="button" class="text-btn" @click="manage">{{ manageLabel }}</button>
        </div>
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            选择
          </span>
          <span>
            <kbd>Enter</kbd>
            插入
          </span>
          <span>
            <kbd>Esc</kbd>
            关闭
          </span>
        </footer>
      </div>
    </Teleport>
  </div>
</template>
