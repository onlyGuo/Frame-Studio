<script setup vapor>
import { computed } from 'vue'
import { edit, importMedia, media } from '../../store.js'
import { availableImages } from '../../editor/shot-assets.mjs'
import Glyph from '../Glyph.vue'
import { bindSettingImage } from '../../../shared/outfits.mjs'
import './shot-asset-review.css'

const props = defineProps({
  report: { type: Object, required: true },
  modelIssue: { type: String, default: '' },
  canConfirm: { type: Boolean, default: true },
  canOpenCard: Boolean
})
const emit = defineEmits(['confirm', 'open-card', 'reference'])
const canDeclareNone = computed(
  () => !props.report.cards.length && props.report.issues.every((issue) => issue.code === 'unreviewed')
)
const status = computed(() => {
  const report = props.report
  if (report.state === 'none' && report.ready) return '已确认无出场资产'
  if (report.cards.length) {
    const count = report.cards.filter((item) => item.hasImage).length
    return count + ' / ' + report.cards.length + ' 项已配图'
  }
  return '待核对'
})

/** 只更新所选设定卡，在本工程所有出场镜头中共用同一张参考图。 */
function bind({ cardId, outfitId }, assetId) {
  edit((draft) => {
    const card = draft.cards.find((item) => item.id === cardId)
    if (assetId) bindSettingImage(card, assetId, outfitId)
  })
}
/** 单张新图直接绑定；一次导入多张图时交由创作者选择。 */
async function importReference(item) {
  const added = await importMedia('image')
  const imported = added?.filter((item) => item.kind === 'image')
  if (imported?.length === 1) bind(item, imported[0].id)
}
</script>
<template>
  <section class="shot-asset-review" aria-label="出场资产核对">
    <div class="asset-review-heading">
      <strong>
        <Glyph name="cards" :size="15" />
        出场资产
      </strong>
      <span :class="report.ready ? 'asset-review-pass' : 'asset-review-pending'">{{ status }}</span>
    </div>
    <ul v-if="report.cards.length" class="asset-review-list">
      <li
        v-for="item in report.cards"
        :key="item.cardId + ':' + (item.outfitId || '')"
        class="asset-review-row"
      >
        <img v-if="item.hasImage" :src="media(item.assetId)" alt="" loading="lazy" />
        <span v-else class="asset-review-empty-thumb"><Glyph name="media" :size="17" /></span>
        <div class="asset-review-name">
          <small>{{ item.type }}</small>
          <strong>{{ item.name }}</strong>
        </div>
        <button v-if="canOpenCard" type="button" class="text-btn" @click="emit('open-card', item.cardId)">
          查看设定
        </button>
        <div v-if="!item.hasImage" class="asset-review-repair">
          <select
            v-if="availableImages.length"
            :aria-label="'为' + item.name + '绑定参考图'"
            value=""
            @change="bind(item, $event.target.value)"
          >
            <option value="" disabled>从素材库绑定参考图…</option>
            <option v-for="image in availableImages" :key="image.id" :value="image.id">
              {{ image.name }}
            </option>
          </select>
          <button
            type="button"
            class="text-btn"
            :aria-label="'为' + item.name + '导入参考图'"
            @click="importReference(item)"
          >
            导入图片
          </button>
        </div>
      </li>
    </ul>
    <ul v-if="report.issues.some((issue) => issue.code !== 'unreviewed')" class="asset-review-issues">
      <template
        v-for="issue in report.issues"
        :key="issue.code + (issue.cardId || issue.message) + (issue.outfitId || '')"
      >
        <li v-if="issue.code !== 'unreviewed'">
          {{ issue.message }}
          <button
            v-if="issue.code === 'unlinked_card'"
            type="button"
            class="text-btn"
            @click="emit('reference', issue.cardId)"
          >
            引用此资产
          </button>
        </li>
      </template>
    </ul>
    <p v-if="canDeclareNone && report.state !== 'none'">用 @ 标记镜头中出场的角色、场景和道具。</p>
    <label v-if="canDeclareNone" class="asset-review-confirm">
      <input
        type="checkbox"
        :disabled="!canConfirm"
        :checked="report.state === 'none'"
        @change="emit('confirm', $event.target.checked)"
      />
      此镜头无需出场资产
    </label>
    <p v-if="modelIssue" class="asset-review-issues">{{ modelIssue }}</p>
  </section>
</template>
