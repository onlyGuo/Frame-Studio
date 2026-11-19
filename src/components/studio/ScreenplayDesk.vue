<script setup vapor>
import { computed, nextTick, ref, watch } from 'vue'
import { doc, ui, episode, edit, editEpisode } from '../../store.js'
import { screenplayOutline } from '../../editor/screenplay.mjs'
import Glyph from '../Glyph.vue'

defineEmits(['addEpisode'])
const editor = ref(null)
const cursor = ref(0)
const outlinePage = ref(0)
const outline = computed(() => screenplayOutline(episode.value.script))
const count = computed(() => episode.value.script.replace(/\s/g, '').length)
const currentEpisode = computed(() => doc.value.episodes.findIndex((e) => e.id === episode.value.id))
const pageSize = 40
const pageCount = computed(() => Math.max(1, Math.ceil(outline.value.rows.length / pageSize)))
const page = computed(() => Math.min(pageCount.value - 1, outlinePage.value))
const items = computed(() => outline.value.rows.slice(page.value * pageSize, (page.value + 1) * pageSize))
const active = computed(() => outline.value.rows.findLast((entry) => entry.offset <= cursor.value))

/** 同步人工撰写的正文与工程，智能体和撤销操作也更新同一份文本。 */
function write(text) {
  return editEpisode((part) => {
    part.script = text
  })
}
function updateScript(e) {
  write(e.target.value)
  cursor.value = e.target.selectionStart
}
function rename(input) {
  if (
    !editEpisode((part) => {
      part.title = input.value.trim()
    })
  )
    input.value = episode.value.title
}
/** 保留真实换行与自动折行的位置，使长剧本的导航也能滚动到正确场景。 */
function goTo(offset, end = offset) {
  const el = editor.value
  if (!el) return
  el.focus({ preventScroll: true })
  el.setSelectionRange(offset, end)
  const mirror = document.createElement('div'),
    style = getComputedStyle(el)
  Object.assign(mirror.style, {
    position: 'fixed',
    visibility: 'hidden',
    inset: '0 auto auto 0',
    width: el.clientWidth + 'px',
    boxSizing: 'border-box',
    padding: style.padding,
    font: style.font,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word'
  })
  mirror.textContent = el.value.slice(0, offset) + '\u200b'
  document.body.append(mirror)
  el.scrollTop = Math.max(0, mirror.offsetHeight - el.clientHeight * 0.35)
  mirror.remove()
  cursor.value = offset
}
/** 在光标所在段落后创建新场记，保留已有动作与对白。 */
async function insertScene() {
  const body = episode.value.script,
    start = Math.min(cursor.value, body.length)
  const rest = body.slice(start)
  const boundary = rest.search(/\n\s*\n/)
  const at = boundary < 0 ? body.length : start + boundary
  const left = body.slice(0, at).trimEnd(),
    right = body.slice(at).trimStart()
  const number = (outline.value.label === '场景' ? outline.value.rows.length : 0) + 1
  const title = '第' + number + '场 · ',
    placeholder = '场景地点'
  const prefix = left + (left ? '\n\n' : '') + title
  if (!write(prefix + placeholder + '\n\n' + right)) return
  await nextTick()
  goTo(prefix.length, prefix.length + placeholder.length)
  const index = outline.value.rows.findIndex((entry) => entry.offset === prefix.length - title.length)
  if (index >= 0) outlinePage.value = Math.floor(index / pageSize)
}
/** 分集排序直接写入工程清单，切换剧本时按 ID 保留正确分集。 */
function reorder(offset) {
  const from = currentEpisode.value,
    to = from + offset
  if (to < 0 || to >= doc.value.episodes.length) return
  edit((d) => d.episodes.splice(to, 0, d.episodes.splice(from, 1)[0]))
}
function remove() {
  const index = currentEpisode.value
  if (doc.value.episodes.length < 2) return
  if (edit((d) => d.episodes.splice(index, 1))) ui.episodeId = doc.value.episodes[Math.max(0, index - 1)].id
}
watch(
  () => episode.value.id,
  () => {
    cursor.value = 0
    outlinePage.value = 0
    if (editor.value) editor.value.scrollTop = 0
  }
)
</script>
<template>
  <header class="studio-page-title">
    <div>
      <div class="studio-breadcrumb">{{ doc.title }}</div>
      <h1>剧本写作</h1>
    </div>
    <button class="primary" @click="$emit('addEpisode')">
      <Glyph name="plus" />
      添加分集
    </button>
  </header>
  <div class="screenplay-desk">
    <nav class="production-panel script-nav" aria-label="剧本导航">
      <header>
        <h2>
          分集目录
          <small>{{ doc.episodes.length }}</small>
        </h2>
      </header>
      <div class="writing-episodes">
        <button
          v-for="(part, i) in doc.episodes"
          :key="part.id"
          :aria-current="part.id === episode.id ? 'true' : undefined"
          @click="ui.episodeId = part.id"
        >
          <small>{{ String(i + 1).padStart(2, '0') }}</small>
          <span>{{ part.title }}</span>
        </button>
      </div>
      <header>
        <h2>
          本集大纲
          <small>{{ outline.rows.length }}</small>
        </h2>
      </header>
      <div v-if="items.length" class="writing-outline">
        <button
          v-for="item in items"
          :key="item.offset"
          :aria-current="active?.offset === item.offset ? 'location' : undefined"
          :title="item.title"
          @click="goTo(item.offset)"
        >
          <span>{{ item.title }}</span>
          <small>L{{ item.line }}</small>
        </button>
      </div>
      <p v-else class="writing-hint">写下正文后，这里会列出场景或段落。</p>
      <div v-if="pageCount > 1" class="outline-pages">
        <button class="icon" title="上一页大纲" :disabled="!page" @click="outlinePage = page - 1">
          <Glyph name="back" :size="14" />
        </button>
        <span>{{ page + 1 }} / {{ pageCount }}</span>
        <button
          class="icon"
          title="下一页大纲"
          :disabled="page + 1 >= pageCount"
          @click="outlinePage = page + 1"
        >
          <Glyph name="chevron" :size="14" />
        </button>
      </div>
    </nav>
    <section class="production-panel script-paper">
      <header>
        <h2>
          <Glyph name="pen" :size="16" />
          剧本文稿
        </h2>
        <details class="writing-tools">
          <summary>分集管理</summary>
          <div>
            <button :disabled="!currentEpisode" @click="reorder(-1)">分集前移</button>
            <button :disabled="currentEpisode === doc.episodes.length - 1" @click="reorder(1)">
              分集后移
            </button>
            <button :disabled="doc.episodes.length === 1" @click="remove">移除分集</button>
          </div>
        </details>
      </header>
      <div class="manuscript">
        <label class="manuscript-name">
          <span>分集名称</span>
          <input :value="episode.title" maxlength="200" @change="rename($event.target)" />
        </label>
        <div class="script-rule"></div>
        <div class="writing-toolbar">
          <label for="episode-script">剧本正文</label>
          <button class="text-btn" @click="insertScene">
            <Glyph name="plus" :size="13" />
            插入场景
          </button>
        </div>
        <textarea
          ref="editor"
          id="episode-script"
          class="script-text"
          maxlength="500000"
          :value="episode.script"
          placeholder="写下场景、动作与对白…"
          @input="updateScript"
          @select="cursor = $event.target.selectionStart"
          @click="cursor = $event.target.selectionStart"
          @keyup="cursor = $event.target.selectionStart"
        ></textarea>
      </div>
      <footer>
        <span>
          {{ count }} 字 · {{ outline.rows.length }} {{ outline.label === '场景' ? '个场景' : '段' }}
        </span>
        <button class="text-btn" @click="ui.page = 'shots'">
          进入分镜工作台
          <Glyph name="arrow" :size="13" />
        </button>
      </footer>
    </section>
  </div>
</template>
