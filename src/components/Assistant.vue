<script setup vapor>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  api,
  ui,
  doc,
  episode,
  chat,
  cancelAgent,
  answerAgentApproval,
  openProject,
  openSettings
} from '../store.js'
import Glyph from './Glyph.vue'
import AgentSteps from './assistant/AgentSteps.vue'
import CommandApproval from './assistant/CommandApproval.vue'
import { groupTurns } from './assistant/transcript.mjs'
import { describeRun } from '../../shared/agent-trace.mjs'
import './assistant/console.css'

const scroll = ref(null),
  composer = ref(null)
const scope = ref('task'),
  historyOpen = ref(false),
  focusMode = ref(false),
  following = ref(true),
  submitting = ref(false)
const drafts = reactive(new Map()),
  positions = new Map()
// 即使当前查看另一个工程，任务仍保留提交时的项目、分集和模型。
const task = computed(() => ui.agentTask)
const separate = computed(() => !!task.value && !!ui.root && task.value.root !== ui.root)
const showTask = computed(() => !!task.value && (!separate.value || scope.value === 'task'))
const viewingElsewhere = computed(() => showTask.value && task.value.root !== ui.root)
const displayedRun = computed(() => showTask.value && ui.agentRunning)
const viewRoot = computed(() => (viewingElsewhere.value ? task.value.root : ui.root))
const hasContext = computed(() => !!viewRoot.value)
const title = computed(() => (viewingElsewhere.value ? task.value.title : doc.value?.title))
const episodeTitle = computed(() =>
  showTask.value && (ui.agentRunning || viewingElsewhere.value)
    ? task.value.episodeTitle
    : episode.value?.title
)
const profile = computed(() => ui.config?.profiles?.[ui.config.llm])
const model = computed(() =>
  showTask.value && (ui.agentRunning || viewingElsewhere.value)
    ? task.value.model || profile.value?.model
    : profile.value?.model
)
const draft = computed({
  get: () => drafts.get(viewRoot.value) || '',
  set: (value) => drafts.set(viewRoot.value, value)
})
const pageTitle = computed(
  () =>
    ({
      overview: '项目总览',
      story: '剧本写作',
      cards: '资产',
      shots: '分镜工作台',
      edit: '剪辑台',
      media: '素材库'
    })[ui.page] || '项目工作台'
)
const suggestions = computed(() =>
  episode.value?.script?.trim()
    ? [
        ['shots', '拆解本集分镜', '把本集剧本拆解成可拍摄的分镜，并写入当前分集。'],
        ['cards', '提取角色设定', '从本集剧本整理主要角色和场景，并建立设定卡。']
      ]
    : [
        ['pen', '构思分集剧本', '为当前分集构思一段短剧。先和我确认题材、主要角色和时长。'],
        ['cards', '建立角色设定', '帮我设计本剧的主要角色，先了解人物关系与视觉风格。']
      ]
)

/** 工作中的用户提交即时展示；完成后使用工程确认保存的消息，避免重复显示。 */
const turns = computed(() => {
  if (!showTask.value) return groupTurns(doc.value?.messages)
  const source = task.value
  const currentTurn = { id: source.id, question: source.question, replies: [] }
  // 配置或凭据校验可能在保存提问前失败，仍把错误显示在此次提问下面。
  const unsaved = source.error && source.finalMessages?.length === source.messages?.length
  if (displayedRun.value || unsaved) return [...groupTurns(source.messages), currentTurn]
  if (!viewingElsewhere.value) return groupTurns(doc.value?.messages)
  if (source.finalMessages?.length) return groupTurns(source.finalMessages)
  return [...groupTurns(source.messages), currentTurn]
})
const mediaSession = computed(() => (viewingElsewhere.value ? task.value.session : ui.session))
const live = computed(() => (showTask.value ? task.value : null))
const events = computed(() => live.value?.events || [])
const liveSummary = computed(() => (live.value ? describeRun(live.value) : null))
const historyRows = ref([])
const historySession = ref('')
const historyById = computed(
  () =>
    new Map(
      (historySession.value === mediaSession.value ? historyRows.value : []).map((row) => [row.id, row])
    )
)
const historyError = ref('')
const approval = computed(() => (displayedRun.value ? task.value.approval : null))

/** 会话切换时仅请求小型回执；工具参数在展开所选轮次时读取。 */
watch(
  [mediaSession, () => ui.agent, () => task.value?.status],
  async ([session, visible], _, cleanup) => {
    let current = true
    cleanup(() => {
      current = false
    })
    if (!session || !visible) return
    historyError.value = ''
    try {
      const rows = await api.agentHistory({ session })
      if (current) {
        historyRows.value = rows
        historySession.value = session
      }
    } catch {
      if (current) historyError.value = '历史步骤暂时无法读取'
    }
  },
  { immediate: true }
)
const viewport = ref(window.innerWidth),
  width = ref(420)
const minWidth = 288
const maxWidth = computed(() => Math.max(minWidth, Math.min(780, viewport.value - 440)))
const actualWidth = computed(() => Math.max(minWidth, Math.min(maxWidth.value, width.value)))
/** 窗口尺寸改变后收敛到可用宽度，保留工作区空间。 */
function syncViewport() {
  viewport.value = window.innerWidth
}
let drag
/** 通过指针捕获支持拖出分隔线后继续改变面板宽度。 */
function beginResize(event) {
  if (event.button !== 0) return
  drag = { x: event.clientX, width: actualWidth.value }
  event.currentTarget.setPointerCapture(event.pointerId)
  event.preventDefault()
}
/** 根据拖动起点计算宽度，避免累积位置偏差。 */
function resize(event) {
  if (drag) width.value = Math.max(minWidth, Math.min(maxWidth.value, drag.width + drag.x - event.clientX))
}
/** 松开鼠标、触笔或失去捕获时结束本次拖动。 */
function endResize() {
  drag = null
}
/** 方向键微调宽度，Home 与 End 分别跳到允许的两端。 */
function keyboardResize(event) {
  const target = {
    ArrowLeft: actualWidth.value + 24,
    ArrowRight: actualWidth.value - 24,
    Home: minWidth,
    End: maxWidth.value
  }[event.key]
  if (target === undefined) return
  event.preventDefault()
  width.value = Math.max(minWidth, Math.min(maxWidth.value, target))
}

/** 主动返回底部，同时恢复跟随流式输出。 */
function toBottom() {
  if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight
  following.value = true
}
/** 保存各工程的阅读位置；上翻时暂停自动滚动。 */
function trackScroll() {
  const el = scroll.value
  if (!el || !ui.agent) return
  following.value = el.scrollHeight - el.clientHeight - el.scrollTop < 48
  positions.set(viewRoot.value, { y: el.scrollTop, follow: following.value })
}
/** 切换工程或重新展开助手时恢复该会话的滚动策略。 */
function restorePosition() {
  const point = positions.get(viewRoot.value)
  if (!point || point.follow) {
    toBottom()
    return
  }
  if (scroll.value) scroll.value.scrollTop = point.y
  following.value = false
}
/** 从历史目录定位到提问，保持主编辑区原有位置。 */
async function jump(index) {
  historyOpen.value = false
  await nextTick()
  const el = scroll.value?.querySelector('[data-turn="' + index + '"]')
  if (el && scroll.value)
    scroll.value.scrollTop += el.getBoundingClientRect().top - scroll.value.getBoundingClientRect().top - 10
  trackScroll()
}
/** 将模板放入可编辑草稿，由用户决定何时发送。 */
function chooseSuggestion(text) {
  draft.value = text
  composer.value?.focus()
}
/** 提交草稿到全局任务调度，提交期间也允许继续编辑。 */
async function send() {
  const value = draft.value.trim()
  if (!value || !doc.value || viewingElsewhere.value || ui.agentRunning || ui.busy || submitting.value) return
  const root = viewRoot.value
  const previousId = task.value?.id
  submitting.value = true
  historyOpen.value = false
  following.value = true
  scope.value = 'task'
  try {
    await chat(value)
    // 调度失败时保留原稿；确认开始后仅清空此次实际提交的文本。
    if (task.value?.id !== previousId && drafts.get(root)?.trim() === value) drafts.delete(root)
  } finally {
    submitting.value = false
  }
}
/** 中文输入法确认和 Shift+Enter 换行保留文本框的原生行为。 */
function composerKey(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  send()
}
/** 在当前工作区与后台工程之间切换，不向执行器发出控制信号。 */
function viewScope(value) {
  scope.value = value
  historyOpen.value = false
}
function toggleHistory() {
  historyOpen.value = !historyOpen.value
}
/** 优先关闭会话历史，保留外层快捷键收起整个面板的行为。 */
function localEscape(event) {
  if (event.key !== 'Escape' || (!historyOpen.value && !focusMode.value)) return
  event.preventDefault()
  event.stopPropagation()
  if (historyOpen.value) historyOpen.value = false
  else focusMode.value = false
}
watch([() => task.value?.id, () => ui.root], () => {
  scope.value = !doc.value || ui.agentRunning ? 'task' : 'workspace'
  historyOpen.value = false
})
watch(
  () => ui.page,
  () => {
    focusMode.value = false
  }
)
watch([viewRoot, () => ui.agent], () => {
  if (ui.agent) nextTick(restorePosition)
})
watch(
  [
    () => turns.value.length,
    () => events.value.length,
    () => events.value.at(-1)?.text,
    () => ui.agentRunning
  ],
  () => {
    if (following.value && ui.agent) nextTick(toBottom)
  },
  { flush: 'post' }
)
onMounted(() => {
  window.addEventListener('resize', syncViewport)
  nextTick(restorePosition)
})
onBeforeUnmount(() => window.removeEventListener('resize', syncViewport))
</script>
<template>
  <aside
    class="assistant agent-console"
    :class="{ 'ac-focus': focusMode }"
    :style="focusMode ? undefined : { width: actualWidth + 'px' }"
    aria-label="创作助手会话面板"
    @keydown="localEscape"
  >
    <div
      v-if="!focusMode"
      class="ac-resize"
      tabindex="0"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整助手面板宽度"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      :aria-valuenow="actualWidth"
      @pointerdown="beginResize"
      @pointermove="resize"
      @pointerup="endResize"
      @lostpointercapture="endResize"
      @keydown="keyboardResize"
    />
    <header class="ac-head">
      <span class="ac-symbol"><Glyph name="spark" :size="18" /></span>
      <div class="ac-heading">
        <h2>创作助手</h2>
        <span v-if="focusMode && title">{{ [title, episodeTitle].filter(Boolean).join(' / ') }}</span>
        <span v-else-if="model">{{ model }}</span>
      </div>
      <button
        class="ac-icon"
        :class="{ chosen: historyOpen }"
        :aria-expanded="historyOpen"
        title="对话历史"
        aria-label="对话历史"
        @click="toggleHistory"
      >
        <Glyph name="clock" :size="16" />
      </button>
      <button
        class="ac-icon"
        :aria-label="focusMode ? '还原侧栏' : '展开对话窗口'"
        :title="focusMode ? '还原侧栏' : '展开对话窗口'"
        :aria-pressed="focusMode"
        @click="focusMode = !focusMode"
      >
        <Glyph :name="focusMode ? 'shrink' : 'expand'" :size="16" />
      </button>
      <button class="ac-icon" title="收起助手" aria-label="关闭助手" @click="ui.agent = false">
        <Glyph name="x" :size="16" />
      </button>
    </header>
    <div v-if="separate" class="ac-switch" aria-label="会话范围">
      <button :aria-pressed="scope === 'workspace'" @click="viewScope('workspace')">当前工程</button>
      <button :aria-pressed="scope === 'task'" @click="viewScope('task')">
        <i v-if="ui.agentRunning" class="ac-dot live" />
        {{ task.approval ? '后台任务待授权' : ui.agentRunning ? '后台任务' : '最近任务' }}
      </button>
    </div>
    <div v-if="hasContext && !focusMode" class="ac-context">
      <Glyph name="folder" :size="14" />
      <strong :title="viewRoot">{{ title }}</strong>
      <span v-if="episodeTitle" class="ac-context-episode">/ {{ episodeTitle }}</span>
      <span v-if="displayedRun" class="ac-context-status">
        <i class="ac-dot live" />
        {{ approval ? '待授权' : '执行中' }}
      </span>
    </div>
    <section v-if="historyOpen" class="ac-history" aria-label="对话历史">
      <div>
        <strong>对话历史</strong>
        <small>{{ turns.length }} 条请求</small>
      </div>
      <p v-if="!turns.length">此工程还没有对话。</p>
      <button v-for="(turn, i) in [...turns].reverse()" :key="turn.id" @click="jump(turns.length - 1 - i)">
        <Glyph name="chat" :size="14" />
        <span>{{ turn.question || '助手回复' }}</span>
        <Glyph name="chevron" :size="11" />
      </button>
    </section>
    <div ref="scroll" class="ac-scroll" @scroll.passive="trackScroll">
      <div v-if="!hasContext" class="ac-empty">
        <div class="ac-orbit"><Glyph name="folder" :size="27" /></div>
        <h3>选择工作工程</h3>
        <p>打开工程后，助手可以读取剧本、分镜和素材，与你一起制作。</p>
        <button class="ac-open" @click="openProject('open')">
          <Glyph name="folder" :size="14" />
          打开工程
        </button>
      </div>
      <div v-else-if="!turns.length" class="ac-empty">
        <div class="ac-orbit"><Glyph name="spark" :size="27" /></div>
        <h3>从哪里开始创作？</h3>
        <p>你可以从一个想法开始，也可以直接描述要修改的镜头。</p>
        <div class="ac-starters">
          <button v-for="s in suggestions" :key="s[0]" @click="chooseSuggestion(s[2])">
            <Glyph :name="s[0]" :size="15" />
            <span>{{ s[1] }}</span>
            <Glyph name="arrow" :size="13" />
          </button>
        </div>
      </div>
      <article v-for="(turn, index) in turns" :key="viewRoot + turn.id" :data-turn="index" class="ac-turn">
        <div v-if="turn.question" class="ac-user">{{ turn.question }}</div>
        <AgentSteps
          :turn="turn"
          :summary="live?.id === turn.id ? liveSummary : historyById.get(turn.id)"
          :events="live?.id === turn.id ? events : undefined"
          :running="displayedRun && live?.id === turn.id"
          :approval="!!approval && live?.id === turn.id"
          :active-project="!viewingElsewhere"
          :media-session="mediaSession"
        />
      </article>
      <p v-if="historyError" class="ac-progress" role="status">{{ historyError }}</p>
    </div>
    <button v-if="!following && turns.length" class="ac-latest" @click="toBottom">
      <Glyph name="download" :size="12" />
      最新消息
    </button>
    <CommandApproval
      v-if="approval"
      :approval="approval"
      :project-title="title"
      @answer="answerAgentApproval"
    />
    <footer class="ac-footer">
      <div v-if="viewingElsewhere" class="ac-background">
        <div>
          <b>{{ displayedRun ? '任务在后台执行' : '上一次任务' }}</b>
          <small>{{ title }}</small>
        </div>
        <button v-if="displayedRun" class="ac-stop" @click="cancelAgent">
          <i />
          停止执行
        </button>
        <button v-else class="ac-open" @click="openProject('recent', { root: task.root })">返回工程</button>
      </div>
      <div v-else class="ac-composer">
        <textarea
          ref="composer"
          v-model="draft"
          rows="3"
          maxlength="20000"
          :disabled="!hasContext"
          :placeholder="!hasContext ? '先打开一个工程…' : '描述想创作或修改的内容…'"
          aria-label="创作请求"
          @keydown="composerKey"
        />
        <div class="ac-compose-bar">
          <button class="ac-model" @click="openSettings()" title="模型配置">
            <Glyph name="settings" :size="13" />
            <span>{{ profile?.model || '模型配置' }}</span>
          </button>
          <button v-if="displayedRun" class="ac-stop" @click="cancelAgent">
            <i />
            停止执行
          </button>
          <button
            v-else
            class="ac-send"
            aria-label="发送"
            title="发送请求"
            :disabled="!hasContext || !draft.trim() || ui.agentRunning || submitting || !!ui.busy"
            @click="send"
          >
            <Glyph name="arrowUp" :size="15" />
          </button>
        </div>
      </div>
      <div v-if="!viewingElsewhere" class="ac-compose-note">
        <span>{{ ui.agentRunning && !displayedRun ? '另一个工程正在执行任务' : pageTitle }}</span>
        <span>Enter 发送 · Shift + Enter 换行</span>
      </div>
    </footer>
  </aside>
</template>
