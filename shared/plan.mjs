import { bindShotMedia } from './shot-media.mjs'
import { removeSettingCard } from './mentions.mjs'
import { setShotAssetFree } from './shot-assets.mjs'
import { makeAudio, makeCard, makeClip, makeEpisode, makeShot, validateProject } from './model.mjs'
import { bindSettingImage, settingImage } from './outfits.mjs'

/** 白名单限制智能体能够修改的创作字段；文件路径、凭据和执行命令均在协议之外。 */
const specs = {
  project: ['title', 'ratio', 'quality', 'fps', 'synopsis'],
  cards: ['name', 'type', 'notes', 'assetId', 'outfits', 'defaultOutfitId'],
  episodes: ['title', 'script'],
  shots: ['title', 'prompt', 'dialogue', 'duration', 'assetId', 'referenceId', 'assetFree'],
  clips: ['assetId', 'trim', 'duration', 'volume', 'caption', 'sourceShotId'],
  audio: ['assetId', 'start', 'trim', 'duration', 'volume']
}
const factories = {
  cards: makeCard,
  episodes: makeEpisode,
  shots: makeShot,
  clips: () => makeClip(''),
  audio: () => makeAudio('')
}

/** 先应用正式脚本、对白与媒体，再根据最终画面记录无资产确认。 */
function editShot(shot, fields, assets) {
  const { assetFree, assetId, ...changes } = fields
  if (Object.hasOwn(fields, 'assetId')) {
    const asset = assets.find((a) => a.id === assetId)
    if (assetId !== '' && !asset) throw Error('关联素材缺失')
    bindShotMedia(shot, asset, assets)
  }
  Object.assign(shot, changes)
  if (Object.hasOwn(fields, 'assetFree')) setShotAssetFree(shot, assetFree)
}

/** 旧工具写入的角色参考图仍然更新默认服饰；切到场景或道具时保留当前图。 */
function editCard(card, fields) {
  const { assetId, ...changes } = fields
  if (card.outfits && changes.type && changes.type !== '角色') {
    card.assetId = settingImage(card)
    delete card.outfits
    delete card.defaultOutfitId
  }
  Object.assign(card, changes)
  if (Object.hasOwn(fields, 'assetId')) bindSettingImage(card, assetId)
}

/** 在独立副本上一次性验证全部操作，失败时原稿不变。 */
export function applyPlan(source, actions) {
  if (!Array.isArray(actions) || actions.length > 200) throw Error('变更条数无效')
  const draft = structuredClone(source)
  for (const { op, target, id, episodeId, fields = {}, index } of actions) {
    if (
      !Object.hasOwn(specs, target) ||
      !fields ||
      typeof fields !== 'object' ||
      Object.keys(fields).some((k) => !specs[target].includes(k))
    )
      throw Error('变更包含不支持的字段')
    if (target === 'project' && op === 'update') {
      Object.assign(draft, fields)
      continue
    }
    const parent = ['cards', 'episodes'].includes(target)
      ? draft
      : draft.episodes.find((e) => e.id === episodeId)
    const rows = parent?.[target]
    if (!Array.isArray(rows)) throw Error('找不到变更所属的分集')
    const pos = rows.findIndex((row) => row.id === id)
    if (op === 'add') {
      const item = factories[target]()
      if (target === 'shots') editShot(item, fields, draft.assets)
      else if (target === 'cards') editCard(item, fields)
      else Object.assign(item, fields)
      if (id) item.id = id
      rows.splice(index ?? rows.length, 0, item)
    } else {
      if (pos < 0) throw Error('变更对象已不存在')
      if (op === 'remove' && target === 'cards') removeSettingCard(draft, id)
      else if (op === 'remove') rows.splice(pos, 1)
      else if (op === 'update' && target === 'shots') editShot(rows[pos], fields, draft.assets)
      else if (op === 'update' && target === 'cards') editCard(rows[pos], fields)
      else if (op === 'update') Object.assign(rows[pos], fields)
      else if (op === 'move' && Number.isInteger(index) && index >= 0 && index < rows.length)
        rows.splice(index, 0, rows.splice(pos, 1)[0])
      else throw Error('无法识别变更操作')
    }
  }
  return validateProject(draft)
}
export const planFields = specs
