import {
  inspectShotAssets,
  setShotAssetFree,
  shotReferenceImages,
  applyUnavailableImages
} from '../../shared/shot-assets.mjs'
import { validateVideoInputs } from '../core/video-inputs.mjs'
import { decodeReferenceImage, hasImageHeader } from './media.mjs'
import { resolveMentions } from '../../shared/mentions.mjs'

/** 只接受工程内可读的普通图片文件，验证文件签名，避免将扩展名当作实图。 */
export function hasProjectImage(project, asset) {
  if (asset?.kind !== 'image') return false
  try {
    return hasImageHeader(project.assetPath(asset), asset.ext)
  } catch {
    return false
  }
}

/** 把磁盘上丢失、损坏或不可读的图回报给具体设定卡，保持诊断与工程路径解耦。 */
export function inspectProjectShotAssets(project, shot, extraPrompt = '') {
  const doc = project.data
  const report = inspectShotAssets(doc, shot, extraPrompt)
  const assets = new Map(doc.assets.map((a) => [a.id, a]))
  const unavailable = new Set(
    shotReferenceImages(doc, shot, report)
      .filter((ref) => !hasProjectImage(project, assets.get(ref.assetId)))
      .map((ref) => ref.assetId)
  )
  return applyUnavailableImages(doc, shot, report, unavailable)
}

/** 原始命令、内置及扩展 Skill 共用的制片输入，仅从目标镜头取画面与对白。 */
export function prepareVideoInput(project, target, input, skill) {
  const doc = project.data
  let shot =
    target.newShot ||
    doc.episodes.find((e) => e.id === target.episodeId)?.shots.find((s) => s.id === target.shotId)
  if (target.library) {
    shot = { prompt: input.prompt || '', title: input.shotTitle || '独立素材', dialogue: '' }
    if (input.assetFree === true) setShotAssetFree(shot, true)
  }
  if (!shot) throw Error('找不到待审核的分镜')
  if (
    !target.library &&
    !target.newShot &&
    input.prompt?.trim() &&
    input.prompt.trim() !== shot.prompt.trim()
  )
    throw Error('现有分镜只使用已保存的画面和对白。请将修改写入这个分镜后再生成。')
  const report = inspectProjectShotAssets(project, shot)
  if (!report.ready)
    throw Object.assign(Error(report.issues.map((issue) => issue.message).join('\n')), {
      issues: report.issues
    })
  const references = shotReferenceImages(doc, shot, report)
  if (skill.custom && references.length > (skill.maxReferenceImages || 0)) {
    const issue = {
      code: 'reference_limit',
      message:
        '该自定义视频 Skill 声明可提交 ' +
        (skill.maxReferenceImages || 0) +
        ' 张参考图，本镜需要 ' +
        references.length +
        ' 张。请选择支持全部参考图的 Skill。'
    }
    throw Object.assign(Error(issue.message), { issues: [issue] })
  }
  if (skill.provider && !skill.custom) {
    try {
      validateVideoInputs(skill.provider, skill.model, references)
    } catch (err) {
      throw Object.assign(err, { issues: [{ code: err.code, message: err.message }] })
    }
  }
  const visual = resolveMentions(shot.prompt.trim(), doc.cards, {
    includeNotes: false,
    labelOutfits: true
  }).text
  const dialogue = resolveMentions((shot.dialogue || '').trim(), doc.cards, { includeNotes: false }).text
  const prompt = [
    '生成一段连续画面，遵照本镜画面脚本。参考图只用于锁定标明的外观和场景，角色多视图属于同一角色。',
    '本镜画面：\n' + visual,
    dialogue
      ? '本镜对白／旁白（唯一允许的口语内容，保持说话人、语言、原文和顺序；不补写、不改写）：\n' + dialogue
      : '本镜无对白或旁白。仅可有画面所需的非语言环境音和动作声。'
  ].join('\n\n')
  return {
    prompt,
    visual,
    dialogue,
    references: references.map((r) => ({
      ...r,
      path: project.assetPath(doc.assets.find((a) => a.id === r.assetId))
    }))
  }
}

/** 实际解码每份待提交图片，截断文件不能借有效的图片头通过检查。 */
export async function verifyVideoFiles(references, signal) {
  for (const reference of references) {
    try {
      await decodeReferenceImage(reference.path, signal)
    } catch {
      signal?.throwIfAborted()
      const owners = [...(reference.subjects || [])]
      if (reference.type === '分镜参考' || !owners.length) owners.unshift(reference)
      const issues = owners.map(({ cardId, outfitId, type, name }) => ({
        code: 'missing_file',
        assetId: reference.assetId,
        ...(cardId ? { cardId } : {}),
        ...(outfitId ? { outfitId } : {}),
        message: type + '「' + name + '」的图片无法完整解码。请重新导入或生成参考图。'
      }))
      throw Object.assign(Error(issues.map((issue) => issue.message).join('\n')), { issues })
    }
  }
}
