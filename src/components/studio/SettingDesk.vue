<script setup vapor>
import { computed, ref, onMounted, nextTick } from 'vue'
import { doc, ui, edit, generate, media, uploadVoice } from '../../store.js'
import { makeCard, uid, validateVoiceSample } from '../../../shared/model.mjs'
import {
  bindSettingImage,
  defaultOutfit,
  roleOutfit,
  roleOutfits,
  settingImage
} from '../../../shared/outfits.mjs'
import { removeSettingCard, indexShotMentions } from '../../../shared/mentions.mjs'
import { availableImages, previewImage } from '../../editor/shot-assets.mjs'
import Glyph from '../Glyph.vue'
import './setting-desk.css'

const kinds = ['全部', '角色', '场景', '道具']
const filter = ref('全部')
const highlight = ref('')
const outfitSelection = ref({})
const pane = ref(null)
const cards = computed(() => doc.value.cards)
const voiceSamples = computed(() =>
  doc.value.assets.filter((asset) => {
    if (asset.kind !== 'audio') return false
    try {
      validateVoiceSample(asset)
      return true
    } catch {
      return false
    }
  })
)
const usage = computed(() => indexShotMentions(doc.value.episodes))
const visible = computed(() =>
  filter.value === '全部' ? cards.value : cards.value.filter((c) => c.type === filter.value)
)
/** 在同类页直接创建对应类型；全部页沿用角色卡默认值。 */
function createCard() {
  const card = makeCard()
  if (filter.value !== '全部') {
    card.type = filter.value
    card.name = '新' + filter.value
  }
  if (edit((d) => d.cards.push(card))) locate(card.id, true)
}
/** 从分镜传来的目标置为当前分类并滚动到具体卡片。 */
async function locate(id, editing = false) {
  if (!cards.value.some((card) => card.id === id)) return
  highlight.value = id
  await nextTick()
  const el = pane.value?.querySelector('[data-setting-card="' + CSS.escape(id) + '"]')
  el?.scrollIntoView({ block: 'nearest' })
  const target = editing ? el?.querySelector('input[aria-label="名称"]') : el
  target?.focus({ preventScroll: true })
  if (editing) target?.select()
}
/** 修改指定设定卡的单个属性。 */
function patchCard(id, key, value) {
  edit((d) => {
    const card = d.cards.find((c) => c.id === id)
    if (!card) return
    if (key === 'type' && value !== '角色' && card.outfits) {
      card.assetId = settingImage(card)
      delete card.outfits
      delete card.defaultOutfitId
    }
    if (key === 'type' && value !== '角色') delete card.voiceAssetId
    card[key] = value
  })
}
function selectedOutfit(card) {
  return roleOutfit(card, outfitSelection.value[card.id]) || roleOutfit(card)
}
/** 首次编辑衣橱时把旧参考图移到默认服饰，保持旧镜头的引用有效。 */
function editOutfits(id, change) {
  return edit((draft) => {
    const card = draft.cards.find((item) => item.id === id)
    if (card?.type !== '角色') return
    if (!card.outfits) {
      card.outfits = roleOutfits(card)
      card.defaultOutfitId = defaultOutfit(card)
      card.assetId = ''
    }
    change(card)
  })
}
function addOutfit(id) {
  const outfit = { id: uid(), name: '新服饰', notes: '', assetId: '' }
  if (editOutfits(id, (card) => card.outfits.push(outfit))) outfitSelection.value[id] = outfit.id
}
function changeOutfit(id, outfitId, field, value) {
  editOutfits(id, (card) => {
    roleOutfit(card, outfitId)[field] = value
  })
}
function removeOutfit(id, outfitId) {
  editOutfits(id, (card) => {
    if (outfitId !== card.defaultOutfitId) card.outfits = card.outfits.filter((item) => item.id !== outfitId)
  })
}
function bind(id, assetId, outfitId) {
  edit((draft) =>
    bindSettingImage(
      draft.cards.find((card) => card.id === id),
      assetId,
      outfitId
    )
  )
}
/** 删除设定后保留镜头中的缺失标签，可在下一次生成前替换。 */
function removeCard(id) {
  edit((d) => removeSettingCard(d, id))
}
/** 镜头定位同时更新目标分集和工作台的选择。 */
function openShot(use) {
  ui.episodeId = use.episodeId
  ui.shotId = use.shotId
  ui.page = 'shots'
}
onMounted(() => {
  const card = cards.value.find((c) => c.id === ui.focusCardId)
  ui.focusCardId = ''
  if (card) {
    filter.value = card.type
    locate(card.id)
  }
})
</script>
<template>
  <section ref="pane" class="setting-desk">
    <header class="studio-page-title">
      <div>
        <div class="studio-breadcrumb">{{ doc.title }}</div>
        <h1>角色与设定</h1>
      </div>
      <button type="button" class="primary" @click="createCard">
        <Glyph name="plus" />
        {{ filter === '全部' ? '新建设定卡' : '新建' + filter }}
      </button>
    </header>
    <div class="setting-filters" aria-label="设定类型筛选">
      <button v-for="type in kinds" :key="type" :aria-pressed="filter === type" @click="filter = type">
        {{ type }}
        <small>{{ type === '全部' ? cards.length : cards.filter((c) => c.type === type).length }}</small>
      </button>
    </div>
    <div v-if="!visible.length" class="empty">
      <Glyph name="cards" :size="32" />
      <h3>{{ filter === '全部' ? '建立第一张设定卡' : '暂无' + filter + '设定' }}</h3>
      <p>记录外观与视觉设定后，可在分镜脚本中输入 @ 引用。</p>
    </div>
    <article
      v-for="c in visible"
      :key="c.id"
      class="record setting-record"
      :data-setting-card="c.id"
      :class="{ located: highlight === c.id }"
      tabindex="-1"
      :aria-label="c.type + '设定：' + c.name"
    >
      <div class="thumb">
        <img
          v-if="previewImage(selectedOutfit(c)?.assetId || (c.type !== '角色' ? c.assetId : ''))"
          :src="previewImage(c.type === '角色' ? selectedOutfit(c)?.assetId : c.assetId)"
          :alt="c.name + '参考图'"
        />
        <Glyph v-else name="cards" :size="34" />
      </div>
      <div class="grow form-stack">
        <div class="fields">
          <label>
            类型
            <select aria-label="类型" :value="c.type" @change="patchCard(c.id, 'type', $event.target.value)">
              <option v-for="v in ['角色', '场景', '道具']" :key="v">{{ v }}</option>
            </select>
          </label>
          <label>
            名称
            <input aria-label="名称" :value="c.name" @change="patchCard(c.id, 'name', $event.target.value)" />
          </label>
        </div>
        <label>
          设定描述
          <textarea
            :value="c.notes"
            @input="patchCard(c.id, 'notes', $event.target.value)"
            placeholder="外观、性格、空间与光线…"
          />
        </label>
        <div v-if="c.type === '角色'" class="outfit-editor form-stack">
          <div class="actions">
            <label>
              服饰
              <select :value="selectedOutfit(c).id" @change="outfitSelection[c.id] = $event.target.value">
                <option v-for="outfit in roleOutfits(c)" :key="outfit.id" :value="outfit.id">
                  {{ outfit.name }}{{ outfit.id === defaultOutfit(c) ? ' · 默认' : '' }}
                </option>
              </select>
            </label>
            <button type="button" class="outline" @click="addOutfit(c.id)">添加服饰</button>
            <template v-if="selectedOutfit(c).id !== defaultOutfit(c)">
              <button
                type="button"
                class="text-btn"
                @click="editOutfits(c.id, (card) => (card.defaultOutfitId = selectedOutfit(c).id))"
              >
                设为默认
              </button>
              <button type="button" class="text-btn" @click="removeOutfit(c.id, selectedOutfit(c).id)">
                移除服饰
              </button>
            </template>
          </div>
          <label>
            服饰名称
            <input
              maxlength="200"
              :value="selectedOutfit(c).name"
              @change="
                changeOutfit(
                  c.id,
                  selectedOutfit(c).id,
                  'name',
                  $event.target.value.trim() || selectedOutfit(c).name
                )
              "
            />
          </label>
          <label>
            服饰细节
            <textarea
              rows="2"
              :value="selectedOutfit(c).notes"
              placeholder="款式、材质、颜色与穿戴配件…"
              @change="changeOutfit(c.id, selectedOutfit(c).id, 'notes', $event.target.value)"
            />
          </label>
          <small>参考图包含上身、全身、脸部特写、左侧和右侧五个视图。</small>
        </div>
        <div class="actions">
          <select
            aria-label="绑定参考图"
            :value="c.type === '角色' ? selectedOutfit(c).assetId : c.assetId"
            @change="bind(c.id, $event.target.value, selectedOutfit(c)?.id)"
          >
            <option value="">选择参考图</option>
            <option
              v-if="
                (selectedOutfit(c)?.assetId || c.assetId) &&
                !previewImage(selectedOutfit(c)?.assetId || c.assetId)
              "
              :value="selectedOutfit(c)?.assetId || c.assetId"
              disabled
            >
              原参考图不可用
            </option>
            <option v-for="a in availableImages" :key="a.id" :value="a.id">
              {{ a.name }}
            </option>
          </select>
          <button class="outline" @click="generate('', '', c.id, 'image', selectedOutfit(c)?.id)">
            <Glyph name="spark" />
            {{ c.type === '角色' ? '生成五视图' : '生成参考图' }}
          </button>
          <button class="icon" title="移除设定卡" @click="removeCard(c.id)">
            <Glyph name="trash" />
          </button>
        </div>
        <div v-if="c.type === '角色'" class="voice-editor form-stack">
          <label>
            角色声音样本
            <select
              :value="c.voiceAssetId || ''"
              @change="patchCard(c.id, 'voiceAssetId', $event.target.value)"
            >
              <option value="">未绑定样音</option>
              <option v-for="sample in voiceSamples" :key="sample.id" :value="sample.id">
                {{ sample.name }}
              </option>
            </select>
          </label>
          <audio
            v-if="c.voiceAssetId"
            :key="c.voiceAssetId"
            :src="media(c.voiceAssetId)"
            controls
            preload="none"
          />
          <div class="actions">
            <button type="button" class="outline" @click="generate('', '', c.id, 'audio')">
              <Glyph name="spark" />
              生成样音
            </button>
            <button type="button" class="outline" @click="uploadVoice(c.id)">上传样音</button>
          </div>
          <small>同一角色的所有服饰共用样音。使用 2–15 秒的单人 WAV 或 MP3。</small>
        </div>
        <details v-if="usage.get(c.id)?.length" class="setting-uses" :open="highlight === c.id">
          <summary>引用镜头 · {{ usage.get(c.id).length }}</summary>
          <div>
            <button
              v-for="use in usage.get(c.id)"
              :key="use.episodeId + use.shotId"
              type="button"
              @click="openShot(use)"
            >
              <Glyph name="shots" :size="13" />
              {{ use.episodeTitle }} · 镜头 {{ use.number }} · {{ use.shotTitle }}
              <Glyph name="chevron" :size="12" />
            </button>
          </div>
        </details>
      </div>
    </article>
  </section>
</template>
