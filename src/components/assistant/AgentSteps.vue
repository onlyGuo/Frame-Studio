<script setup vapor>
import MediaPreview from '../MediaPreview.vue'
import { computed, ref, watch } from 'vue'
import { api, asset, media } from '../../store.js'
import Glyph from '../Glyph.vue'
import AgentReply from './AgentReply.vue'
import ActivityGroup from './ActivityGroup.vue'
import { splitSteps, elapsedText } from './transcript.mjs'

const props = defineProps({
  turn: Object,
  summary: Object,
  events: Array,
  running: Boolean,
  approval: Boolean,
  activeProject: Boolean,
  mediaSession: String
})
const expanded = ref(props.running),
  savedEvents = ref(null),
  loading = ref(false),
  loadError = ref(false)
const now = ref(Date.now())
const status = computed(() =>
  props.running ? 'running' : props.summary?.status === 'running' ? 'interrupted' : props.summary?.status
)
const timed = computed(() =>
  elapsedText(props.summary?.startedAt, props.running ? now.value : props.summary?.endedAt)
)
const parsed = computed(() => splitSteps(props.events || savedEvents.value || [], status.value))
const fallbackReplies = computed(() => props.turn.replies.slice(0, -1))
const hasSteps = computed(
  () =>
    props.running ||
    props.summary?.hasSteps ||
    fallbackReplies.value.length ||
    ['interrupted', 'cancelled', 'failed'].includes(status.value)
)
const lastRound = computed(() => parsed.value.rounds.at(-1))
const pendingCall = computed(() => lastRound.value?.calls.find((c) => c.state === 'running'))
const stateLabel = computed(() => {
  if (props.approval) return '等待命令授权'
  if (lastRound.value?.compaction === 'started') return '正在压缩上下文'
  if (pendingCall.value) return pendingCall.value.name === 'run_command' ? '正在执行命令' : '正在执行工具'
  return lastRound.value?.streaming ? '正在撰写' : '正在思考'
})
const error = computed(
  () => props.summary?.error || (status.value === 'interrupted' ? '上次执行已中断。' : '')
)
const finalText = computed(() => {
  if (parsed.value.finalText) return parsed.value.finalText
  if (props.running || ['interrupted', 'cancelled', 'failed'].includes(status.value)) return ''
  const text = props.turn.replies.at(-1)
  return text && text !== error.value ? text : ''
})
const outcomes = computed(() => props.summary?.outputs || [])
const exports = computed(() => (props.summary?.files || []).filter((file) => /^[\w-]+\.mp4$/.test(file)))
const compressionLabels = {
  started: '正在压缩上下文',
  completed: '上下文已自动压缩',
  failed: '上下文压缩失败',
  interrupted: '上下文压缩已中断'
}
const tokens = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const fallbackProcess = computed(
  () =>
    !parsed.value.rounds.length && !loading.value && (!props.summary || savedEvents.value || loadError.value)
)

/** 用户可以中途收合步骤；结束时统一收合，并保持答复与成品可见。 */
watch(
  () => props.running,
  (running) => {
    expanded.value = running
  }
)
watch(
  () => props.running,
  (running, _, cleanup) => {
    if (running) {
      now.value = Date.now()
      const id = setInterval(() => (now.value = Date.now()), 1000)
      cleanup(() => clearInterval(id))
    }
  },
  { immediate: true }
)
/** 历史记录较大，只在第一次展开这一轮时通过工程会话读取。 */
watch(
  [expanded, () => props.summary?.id, () => props.mediaSession],
  async ([open, id, session], _, cleanup) => {
    let current = true
    cleanup(() => {
      current = false
    })
    if (!open || !id || !session || props.events || savedEvents.value) return
    loading.value = true
    loadError.value = false
    try {
      const rows = await api.agentTrace({ id, session })
      if (current) savedEvents.value = rows
    } catch {
      if (current) loadError.value = true
    } finally {
      if (current) loading.value = false
    }
  },
  { immediate: true }
)
</script>
<template>
  <div class="ac-answer">
    <button
      v-if="hasSteps"
      class="ac-duration"
      :aria-expanded="expanded"
      :aria-label="(expanded ? '收起' : '展开') + '执行过程'"
      @click="expanded = !expanded"
    >
      <i v-if="running" class="ac-dot live" />
      <span>
        {{
          running
            ? '执行中'
            : status === 'cancelled'
              ? '已停止'
              : status === 'failed'
                ? '执行失败'
                : status === 'interrupted'
                  ? '执行中断'
                  : timed
                    ? '用时'
                    : '执行过程'
        }}
      </span>
      <span v-if="timed">{{ timed }}</span>
      <Glyph name="chevron" :size="12" />
    </button>
    <div v-if="expanded" class="ac-process" aria-label="执行步骤">
      <p v-if="loading" class="ac-progress">正在读取步骤…</p>
      <p v-if="loadError" class="ac-progress">暂时无法读取操作记录。</p>
      <AgentReply v-if="fallbackProcess" v-for="(text, i) in fallbackReplies" :key="i" :text="text" />
      <template v-for="round in parsed.rounds" :key="round.key">
        <div v-if="round.compaction" class="ac-compaction" :data-state="round.compaction">
          <Glyph name="compress" :size="15" />
          <span>{{ compressionLabels[round.compaction] }}</span>
          <small v-if="round.beforeTokens && round.afterTokens">
            {{ tokens.format(round.beforeTokens) }} → {{ tokens.format(round.afterTokens) }} tokens
          </small>
        </div>
        <AgentReply v-if="round.text" :text="round.text" />
        <ActivityGroup v-if="round.calls.length" :calls="round.calls" />
        <p v-if="round.progress" class="ac-progress">{{ round.progress }}</p>
      </template>
      <div v-if="running" class="ac-working" role="status">
        <i class="ac-dot live" />
        {{ stateLabel }}
      </div>
    </div>
    <AgentReply v-if="finalText" :text="finalText" />
    <div v-if="error" class="ac-failure" role="status">{{ error }}</div>
    <figure v-for="output in outcomes" :key="output.id" class="ac-output">
      <template v-if="mediaSession && (!activeProject || asset(output.id))">
        <img
          v-if="output.kind === 'image'"
          :src="media(output.id, mediaSession)"
          :alt="output.name || '生成的分镜图'"
          loading="lazy"
        />
        <MediaPreview          v-else-if="output.kind === 'video'"
          :src="media(output.id, mediaSession)"
          :label="output.name"
        />
        <MediaPreview kind="audio"          v-else
          :src="media(output.id, mediaSession)"
          :label="output.name"
        />
      </template>
      <figcaption>
        <strong>{{ output.name || '已生成素材' }}</strong>
        <small v-if="output.model || output.skill">
          {{ [output.skill, output.model].filter(Boolean).join(' · ') }}
        </small>
      </figcaption>
    </figure>
    <figure v-for="file in exports" :key="file" class="ac-output">
      <MediaPreview        v-if="mediaSession"
        :src="media('exports/' + file, mediaSession)"
        label="导出的分集视频"
      />
      <figcaption><strong>分集成片</strong></figcaption>
    </figure>
  </div>
</template>
