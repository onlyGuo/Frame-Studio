<script setup vapor>
import { computed, ref } from 'vue'
import { api, asset, doc, episode, ui, flush, errorMessage } from '../../store.js'
import { inspectVisibleShot, videoModelIssue } from '../../editor/shot-assets.mjs'
import Glyph from '../Glyph.vue'
const dialog = ref(null),
  opened = ref(false),
  selected = ref([]),
  skill = ref(''),
  starting = ref(false),
  submissionError = ref('')
const missing = computed(() => episode.value?.shots.filter((s) => asset(s.assetId)?.kind !== 'video') || [])
const choices = computed(() =>
  ui.skills.filter(
    (s) =>
      s.kind === 'video' && s.enabled && s.command && (!s.provider || ui.config.profiles[s.provider]?.ready)
  )
)
const items = computed(() =>
  (opened.value ? missing.value : []).map((shot) => {
    const report = inspectVisibleShot(doc.value, shot)
    const service = choices.value.find((item) => item.id === skill.value)
    const issue = !shot.prompt.trim()
      ? '待填写分镜脚本'
      : report.issues[0]?.message || videoModelIssue(doc.value, shot, report, service, ui.config)
    return { shot, report, issue }
  })
)
const selectedIds = computed(() =>
  items.value
    .filter(({ shot, issue }) => !issue && selected.value.includes(shot.id))
    .map(({ shot }) => shot.id)
)
/** 预选已有脚本且通过出场资产和服务核对的镜头。 */
function review() {
  submissionError.value = ''
  opened.value = true
  skill.value =
    choices.value.find((s) => s.id === ui.config.mediaDefaults.video)?.id ||
    (choices.value.length === 1 ? choices.value[0].id : '')
  selected.value = items.value.filter((item) => !item.issue).map((item) => item.shot.id)
  dialog.value.showModal()
}
/** 收起批量选择，定位到未通过核对的分镜并保留当前分集。 */
function openShot(id) {
  dialog.value.close()
  ui.shotId = id
}
function toggle(id) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
}
function settings() {
  dialog.value.close()
  ui.modal = 'settings'
}
async function start() {
  if (starting.value || !selectedIds.value.length || !skill.value) return
  const shotIds = [...selectedIds.value]
  starting.value = true
  submissionError.value = ''
  try {
    await flush()
    await api.startVideoBatch({
      session: ui.session,
      episodeId: episode.value.id,
      shotIds,
      skillId: skill.value
    })
    dialog.value.close()
  } catch (err) {
    submissionError.value = errorMessage(err)
  } finally {
    starting.value = false
  }
}
</script>
<template>
  <button class="outline" :disabled="!missing.length || ui.videoBatch?.status === 'running'" @click="review">
    <Glyph name="play" :size="14" />
    生成缺失视频
  </button>
  <dialog ref="dialog" class="batch-dialog" aria-label="批量生成分镜视频" @close="opened = false">
    <header>
      <div>
        <small>{{ episode?.title }}</small>
        <h2>生成分镜视频</h2>
      </div>
      <button class="icon" aria-label="关闭批量生成" @click="dialog.close()"><Glyph name="x" /></button>
    </header>
    <p class="muted">按镜头顺序生成并绑定视频，已完成的镜头会保留。</p>
    <div class="batch-items">
      <div v-for="item in items" :key="item.shot.id" class="batch-entry">
        <label class="batch-row">
          <input
            type="checkbox"
            :disabled="Boolean(item.issue)"
            :checked="selectedIds.includes(item.shot.id)"
            @change="toggle(item.shot.id)"
          />
          <span>{{ item.shot.title }}</span>
          <small>{{ item.shot.duration }} 秒</small>
        </label>
        <div class="batch-asset-note">
          <small v-if="item.report.cards.length">
            {{ item.report.cards.map((card) => card.type + ' · ' + card.name).join(' / ') }}
          </small>
          <small v-else-if="item.report.state === 'none'">已确认无出场资产</small>
          <div v-if="item.issue" class="batch-issue">
            <small>{{ item.issue }}</small>
            <button type="button" class="text-btn" @click="openShot(item.shot.id)">核对分镜</button>
          </div>
        </div>
      </div>
    </div>
    <label>
      视频生成服务
      <select v-model="skill">
        <option value="" disabled>选择已配置的视频服务</option>
        <option v-for="s in choices" :key="s.id" :value="s.id">
          {{ s.name }}{{ s.provider ? ' · ' + ui.config.profiles[s.provider]?.model : '' }}
        </option>
      </select>
    </label>
    <p v-if="submissionError" class="asset-review-issues" role="alert">{{ submissionError }}</p>
    <footer>
      <button v-if="!choices.length" class="text-btn" @click="settings">配置视频模型</button>
      <button class="primary" :disabled="starting || !selectedIds.length || !skill" @click="start">
        生成 {{ selectedIds.length }} 个镜头
      </button>
    </footer>
  </dialog>
</template>
