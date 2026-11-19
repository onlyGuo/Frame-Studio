import { makeShot, validateVoiceSample } from './model.mjs'
import { setShotAssetFree, shotVoiceReferences } from './shot-assets.mjs'
import { mentionToken, parseMentions } from './mentions.mjs'
import { bindSettingImage, roleOutfit, settingImage } from './outfits.mjs'

/** 视频作为分镜主画面。参考图单独保留，并兼容早期以图片作为主画面的工程。 */
export function bindShotMedia(shot, asset, assets) {
  const previous = assets.find((a) => a.id === shot.assetId)
  if (previous?.kind === 'image' && !shot.referenceId) shot.referenceId = previous.id
  if (!asset) {
    shot.assetId = ''
    return
  }
  if (asset.kind === 'image') {
    shot.referenceId = asset.id
    if (previous?.kind !== 'video') shot.assetId = asset.id
  } else if (asset.kind === 'video') {
    shot.assetId = asset.id
  } else throw Error('分镜只接受图片或视频')
}

/** 找出某种生成结果将替换的绑定；图片和视频的并行生成各自独立。 */
function boundId(shot, kind, assets) {
  if (kind === 'image' && shot.referenceId) return shot.referenceId
  return assets.some((a) => a.id === shot.assetId && a.kind === kind) ? shot.assetId : ''
}

/** 视频请求在途时，只比较会影响该镜头画面的输入，允许其他镜头继续编辑。 */
function videoInputs(doc, shot) {
  const mentions = [shot.prompt, shot.dialogue].flatMap((text) =>
    parseMentions(text || '').filter((part) => part.type === 'card')
  )
  const cards = new Map(doc.cards.map((card) => [card.id, card]))
  const settings = mentions.map(({ id, outfitId }) => {
    const card = cards.get(id)
    const outfit = roleOutfit(card, outfitId)
    return [
      mentionToken(id, outfitId),
      card?.name,
      card?.type,
      outfit?.id,
      outfit?.name,
      settingImage(card, outfitId)
    ]
  })
  return JSON.stringify([
    doc.ratio,
    shot.prompt,
    shot.dialogue,
    shot.duration,
    shot.assetFreeFor,
    shot.referenceId || boundId(shot, 'image', doc.assets),
    settings,
    shotVoiceReferences(doc, shot)
  ])
}

/** 在读取文件后、启动供应商命令前复核请求是否仍对应当前镜头。 */
export function videoTargetChanged(doc, target) {
  if (!target?.visualInputs) return false
  const episode = doc.episodes.find((e) => e.id === target.episodeId)
  const shot = target.newShot || episode?.shots.find((s) => s.id === target.shotId)
  return !episode || !shot || target.visualInputs !== videoInputs(doc, shot)
}

/** 计费前确定并冻结本次生成的归属，不能把第一个未制作镜头当作任意提示的目标。 */
export function prepareMediaTarget(doc, kind, input) {
  const { shotId, cardId, outfitId, destination } = input
  if (outfitId && !cardId) throw Error('请同时指定服饰所属的角色卡')
  if (destination && !['shot', 'newShot', 'library'].includes(destination)) throw Error('未知的生成目标')
  if ((shotId && cardId) || ((shotId || cardId) && ['library', 'newShot'].includes(destination)))
    throw Error('请选择唯一的生成目标')
  if (cardId) {
    const card = doc.cards.find((c) => c.id === cardId)
    if (kind === 'audio') {
      if (card?.type !== '角色' || outfitId) throw Error('请选择声音样本所属的角色卡')
      return { cardId, expected: card.voiceAssetId || '', kind }
    }
    if (!card || kind !== 'image') throw Error('请选择现有设定卡并生成图像')
    const outfit = roleOutfit(card, outfitId)
    if (outfitId && !outfit) throw Error('目标服饰不存在，请重新选择')
    return { cardId, outfitId: outfit?.id, expected: settingImage(card, outfitId), kind }
  }
  if (destination === 'library' || (!shotId && !destination && kind !== 'video')) return { library: true }
  if (kind !== 'video' && kind !== 'image') throw Error('音频请保存到素材库')
  const episode = doc.episodes.find((e) => e.id === (input.episodeId || doc.episodes[0].id))
  if (!episode) throw Error('目标分集不存在，请读取工程后更新 episodeId')
  let shot = shotId && episode.shots.find((s) => s.id === shotId)
  if (shotId && !shot) throw Error('目标分镜不存在，请读取该分集的 shots 后更新 shotId')
  if (!shot && destination !== 'newShot') {
    const pending = episode.shots.filter((s) => !boundId(s, kind, doc.assets))
    if (pending.length > 1)
      throw Error(
        '有多个待制作分镜。请用 read_project 读取 shots 并指定 shotId；新增镜头请指定 destination=newShot'
      )
    shot = pending[0]
  }
  const existing = Boolean(shot)
  if (!existing) {
    shot = makeShot()
    shot.prompt = input.prompt || ''
    if (kind === 'video' && input.assetFree === true) setShotAssetFree(shot, true)
    shot.title = (
      input.shotTitle?.trim() || '镜头 ' + String(episode.shots.length + 1).padStart(2, '0')
    ).slice(0, 200)
  }
  return {
    episodeId: episode.id,
    shotId: shot.id,
    kind,
    ...(existing ? { expected: boundId(shot, kind, doc.assets) } : { newShot: shot }),
    ...(kind === 'video' ? { visualInputs: videoInputs(doc, shot) } : {})
  }
}

/** 素材与绑定在同一份待提交的工程副本中完成，保留生成期间创作者自行修改的归属。 */
export function commitMediaTarget(doc, asset, target) {
  if (target.library) return {}
  if (target.cardId) {
    const card = doc.cards.find((c) => c.id === target.cardId)
    if (target.kind === 'audio') {
      validateVoiceSample(asset)
      if (card?.type === '角色' && (card.voiceAssetId || '') === target.expected) {
        card.voiceAssetId = asset.id
        return { cardId: card.id }
      }
    } else {
      const outfit = roleOutfit(card, target.outfitId)
      if (card && (!target.outfitId || outfit) && settingImage(card, target.outfitId) === target.expected) {
        bindSettingImage(card, asset.id, target.outfitId)
        return { cardId: card.id, ...(target.outfitId ? { outfitId: target.outfitId } : {}) }
      }
    }
  } else {
    const ep = doc.episodes.find((e) => e.id === target.episodeId)
    const shot = target.newShot || ep?.shots.find((s) => s.id === target.shotId)
    if (ep && shot && (target.newShot || boundId(shot, target.kind, doc.assets) === target.expected)) {
      if (videoTargetChanged(doc, target)) {
        return { warning: '生成期间分镜脚本、画面设置或出场资产已更改。此版本已保留在素材库，请核对后绑定。' }
      }
      if (target.newShot) {
        if (asset.duration) shot.duration = asset.duration
        ep.shots.push(shot)
      }
      bindShotMedia(shot, asset, doc.assets)
      return { episodeId: ep.id, shotId: shot.id }
    }
  }
  return { warning: '生成期间目标已删除或重新绑定。成品已保留在素材库，可手动绑定。' }
}
