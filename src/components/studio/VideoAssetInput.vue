<script setup vapor>
import StudioSelect from '../StudioSelect.vue'
import { computed, ref, watch } from 'vue'
import { setShotAssetFree, shotReferenceImages, shotVoiceReferences } from '../../../shared/shot-assets.mjs'
import { supportsReferenceAudio } from '../../../resources/skills/_lib/video-inputs.mjs'
import { makeCard } from '../../../shared/model.mjs'
import { mentionToken } from '../../../shared/mentions.mjs'
import { doc, edit, ui } from '../../store.js'
import {
  withShotReference,
  videoModelIssue,
  inspectVisibleShot,
  previewImage
} from '../../editor/shot-assets.mjs'
import MentionScript from './MentionScript.vue'
import ShotAssetReview from './ShotAssetReview.vue'

const props = defineProps({
  modelValue: { type: String, required: true },
  shot: Object,
  episodeId: String,
  service: Object,
  destination: String
})
const emit = defineEmits(['update:modelValue', 'review'])
const confirmed = ref(false)
const creating = ref(false),
  cardName = ref(''),
  cardType = ref('角色'),
  insertAt = ref(null)
const past = [],
  future = []
const subject = computed(() => {
  if (props.shot) return props.shot
  const draft = { prompt: props.modelValue, dialogue: '' }
  setShotAssetFree(draft, confirmed.value)
  return draft
})
const report = computed(() => inspectVisibleShot(doc.value, subject.value))
const modelIssue = computed(() =>
  videoModelIssue(doc.value, subject.value, report.value, props.service, ui.config)
)
const voices = computed(() => shotVoiceReferences(doc.value, subject.value))
const supportsVoices = computed(
  () =>
    props.service?.builtin &&
    supportsReferenceAudio(props.service.provider, ui.config.profiles[props.service.provider]?.model)
)
const looseFirstFrame = computed(() => {
  const images = shotReferenceImages(doc.value, subject.value, report.value)
  return images.length === 1 && images[0].type === '分镜参考'
})
watch(
  [() => props.modelValue, () => props.destination],
  () => {
    confirmed.value = false
  },
  { flush: 'sync' }
)
watch([() => props.shot?.id, () => props.destination], () => {
  past.length = future.length = 0
  creating.value = false
})
const ready = computed(
  () => (props.shot?.prompt.trim() || props.modelValue.trim()) && report.value.ready && !modelIssue.value
)
watch([ready, confirmed], ([ok, free]) => emit('review', Boolean(ok), free), { immediate: true })

/** 当前镜头的声明和文字实时进入工程快照，独立视频使用本次输入的临时声明。 */
function updateShot(change) {
  edit((draft) => {
    const shot = draft.episodes
      .find((ep) => ep.id === props.episodeId)
      ?.shots.find((item) => item.id === props.shot.id)
    if (shot) change(shot)
  })
}
function confirm(value) {
  if (props.shot) updateShot((shot) => setShotAssetFree(shot, value))
  else confirmed.value = value
}
/** 在表单内撤销或重做草稿输入，避免影响项目中的其他操作。 */
function input(value) {
  past.push(props.modelValue)
  if (past.length > 60) past.shift()
  future.length = 0
  emit('update:modelValue', value)
}
function history(forward) {
  const from = forward ? future : past,
    to = forward ? past : future
  if (!from.length) return
  to.push(props.modelValue)
  emit('update:modelValue', from.pop())
}
function reference(id) {
  const cards = doc.value.cards
  if (!cards.some((card) => card.id === id)) return
  if (props.shot)
    updateShot((shot) => {
      shot.prompt = withShotReference(shot.prompt, cards, id)
    })
  else input(withShotReference(props.modelValue, cards, id))
}
/** 沿用 @ 检索词和选中的资产类型，让创建操作顺着当前写作位置进行。 */
function beginCreate(request) {
  insertAt.value = request
  cardName.value = request.query || ''
  cardType.value = request.kind || '角色'
  creating.value = true
}
/** 就地新建设定并插入引用，保留尚未提交的生成草稿。 */
function createCard() {
  if (!cardName.value.trim()) return
  const card = { ...makeCard(), type: cardType.value, name: cardName.value.trim() }
  if (edit((draft) => draft.cards.push(card))) {
    const range = insertAt.value
    if (range?.source === props.modelValue) {
      const text = props.modelValue
      input(text.slice(0, range.start) + mentionToken(card.id) + text.slice(range.end))
      if (props.shot) reference(card.id)
    } else reference(card.id)
    cardName.value = ''
    creating.value = false
  }
}
</script>
<template>
  <MentionScript
    v-if="!shot"
    :model-value="modelValue"
    :cards="doc.cards"
    :image-url="previewImage"
    label="视频画面与运镜"
    manage-label="新建设定卡"
    @update:model-value="input"
    @history="history"
    @manage="beginCreate"
  />
  <div v-if="creating" class="video-new-card">
    <label>
      设定类型
      <StudioSelect v-model="cardType" aria-label="设定类型" :options="['角色', '场景', '道具']" />
    </label>
    <label>
      设定名称
      <input v-model="cardName" maxlength="200" @keydown.enter.prevent="createCard" />
    </label>
    <button type="button" class="soft" :disabled="!cardName.trim()" @click="createCard">新建并引用</button>
    <button type="button" class="text-btn" @click="creating = false">取消</button>
  </div>
  <ShotAssetReview
    :report="report"
    :model-issue="modelIssue"
    :can-confirm="Boolean(subject.prompt.trim())"
    @confirm="confirm"
    @reference="reference"
  />
  <p v-if="voices.length && supportsVoices" class="hint">
    参考音色 · {{ voices.flatMap((ref) => ref.speakers.map((speaker) => speaker.name)).join('、') }}
    <template v-if="looseFirstFrame">。带样音时，底图作为画面参考。</template>
  </p>
  <p v-else-if="voices.length && service" class="hint">
    当前视频服务会直接生成对白。选择支持参考音频的型号可使用角色样音。
  </p>
</template>
