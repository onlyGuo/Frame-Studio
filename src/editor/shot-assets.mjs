import { mentionToken } from '../../shared/mentions.mjs'
import { computed } from 'vue'
import { doc as project, ui, media } from '../store.js'
import {
  applyUnavailableImages,
  inspectShotAssets,
  linkNamedCard,
  shotReferenceImages
} from '../../shared/shot-assets.mjs'
import { validateVideoInputs } from '../../resources/skills/_lib/video-inputs.mjs'

const offline = computed(() => new Set(ui.offlineImageIds))
/** 绑定选择器只列出本工程中可用的图片。 */
export const availableImages = computed(
  () => project.value?.assets.filter((asset) => asset.kind === 'image' && !offline.value.has(asset.id)) || []
)
/** 丢失的图由面板显示补图操作，避免发送注定失败的缩略图请求。 */
export function previewImage(id) {
  return id && !offline.value.has(id) ? media(id) : ''
}
/** 生成弹窗、分镜清单及批量预审均叠加主进程核实的本地磁盘状态。 */
export function inspectVisibleShot(doc, shot, extraPrompt = '') {
  const report = inspectShotAssets(doc, shot, extraPrompt)
  return applyUnavailableImages(doc, shot, report, offline.value)
}

/** 预检已选服务能否接收全部参考图片，单镜与批量使用相同的能力约束。 */
export function videoModelIssue(doc, shot, report, skill, config) {
  if (!report.ready || !skill) return ''
  const refs = shotReferenceImages(doc, shot, report)
  if (!skill.builtin) {
    const limit = skill.maxReferenceImages || 0
    return refs.length > limit
      ? '本镜需要 ' + refs.length + ' 张参考图，此 Skill 可接收 ' + limit + ' 张。请选择合适的视频服务。'
      : ''
  }
  if (!skill.provider) return ''
  try {
    validateVideoInputs(skill.provider, config.profiles[skill.provider]?.model, refs)
    return ''
  } catch (error) {
    return error.message
  }
}

/** 将漏标的资产落实到画面脚本，保留对白或补充要求中对应的出场关系。 */
export function withShotReference(text, cards, cardId) {
  const updated = linkNamedCard(text, cards, cardId)
  return updated !== text ? updated : (text + ' ' + mentionToken(cardId)).trim()
}
