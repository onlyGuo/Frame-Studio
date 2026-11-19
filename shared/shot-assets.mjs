import { mentionToken, parseMentions } from './mentions.mjs'
import { roleOutfit, settingImage, settingLabel } from './outfits.mjs'

/** 从对白的说话人标签读取角色，台词里提到的名字不会带入样音。 */
export function shotSpeakers(doc, shot) {
  const speakers = new Map()
  const roles = doc.cards.filter((card) => card.type === '角色')
  for (const line of (shot.dialogue || '').split('\n')) {
    const cues = [
      ...line
        .trimStart()
        .matchAll(
          /(?:^|(?<=[。？！!?；;])\s*)(@\{card:[\w-]+(?::[\w-]+)?\}|[^：:。？！!?；;\s][^：:。？！!?；;]{0,79})\s*[：:]\s*/gu
        )
    ]
    if (cues[0]?.index !== 0) continue
    for (const [, label] of cues) {
      const marker = parseMentions(label)[0]
      const matches =
        marker?.type === 'card'
          ? roles.filter((card) => card.id === marker.id)
          : roles.filter((card) => card.name === label.trim())
      if (matches.length === 1) speakers.set(matches[0].id, matches[0])
    }
  }
  return [...speakers.values()]
}

/** 每个角色跨服饰复用同一份样音，同一文件只提交一次。 */
export function shotVoiceReferences(doc, shot) {
  const references = new Map()
  for (const { id, name, voiceAssetId } of shotSpeakers(doc, shot)) {
    if (!voiceAssetId) continue
    const asset = doc.assets.find((item) => item.id === voiceAssetId)
    if (!asset) continue
    if (!references.has(asset.id))
      references.set(asset.id, { assetId: asset.id, duration: asset.duration, speakers: [] })
    references.get(asset.id).speakers.push({ cardId: id, name })
  }
  return [...references.values()]
}

/** 按两个字段的原文记录审核版本；长度前缀可区分正文与对白的任意组合。 */
function scriptVersion(shot) {
  const prompt = shot.prompt || ''
  return prompt.length + ':' + prompt + (shot.dialogue || '')
}

/** 仅为此版本的脚本确认无出场资产，任何后续正文或对白修改都会使确认失效。 */
export function setShotAssetFree(shot, confirmed) {
  if (typeof confirmed !== 'boolean') throw Error('无资产确认必须是布尔值')
  if (confirmed) shot.assetFreeFor = scriptVersion(shot)
  else delete shot.assetFreeFor
}

/** 只有视觉正文出现的明文卡名才提示补引；对白中谈到某人不代表此人出镜。 */
function findNamedCards(textParts, cards) {
  const byName = new Map()
  for (const card of cards) {
    const name = card.name.trim()
    if (!name) continue
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(card)
  }
  if (!byName.size) return []
  // 较长名称优先，避免“火车站”中的“车站”被算成第二处出镜。
  const byInitial = new Map()
  for (const name of [...byName.keys()].sort((a, b) => b.length - a.length)) {
    if (!byInitial.has(name[0])) byInitial.set(name[0], [])
    byInitial.get(name[0]).push(name)
  }
  const word = /[a-zA-Z0-9_]/
  const found = new Map()
  for (const [index, part] of textParts.entries()) {
    if (part.type !== 'text') continue
    // 明确标出的声音段落仅持续到本句末尾；后续视觉动作仍需核对。
    const visual = part.text.replace(
      /(^|[\n，,。！？；;])\s*(?:画外音|旁白|画外对白|V\.?O\.?)\s*(?:[：:]|提到|提及|说道|传来)\s*(?:“[^”]*”|"[^"\n]*"|[^\n，,。！？；;]*)/giu,
      (line) => ' '.repeat(line.length)
    )
    for (let offset = 0; offset < visual.length; offset++) {
      const candidates = byInitial.get(visual[offset])
      if (!candidates || (word.test(visual[offset]) && word.test(visual[offset - 1] || ''))) continue
      const match = candidates.find(
        (name) =>
          visual.startsWith(name, offset) &&
          !(word.test(name.at(-1)) && word.test(visual[offset + name.length] || ''))
      )
      if (match) {
        if (!found.has(match))
          found.set(match, { cards: byName.get(match), index, start: offset, end: offset + match.length })
        offset += match.length - 1
      }
    }
  }
  return [...found.values()]
}

/** 仅用稳定引用替换此卡名称首次真正出场的位置，保留对白、同名片段及原有标签。 */
export function linkNamedCard(text, cards, cardId) {
  const parts = parseMentions(text)
  const match = findNamedCards(parts, cards).find((m) => m.cards.some((c) => c.id === cardId))
  if (!match) return text
  const part = parts[match.index]
  part.text = part.text.slice(0, match.start) + mentionToken(cardId) + part.text.slice(match.end)
  return parts.map((p) => (p.type === 'card' ? mentionToken(p.id, p.outfitId) : p.text)).join('')
}

/** 从稳定占位符推导视频清单。前端可预览，主进程在提交前按同一规则重新检查。 */
export function inspectShotAssets(doc, shot, extraPrompt = '') {
  const visual = parseMentions(shot.prompt || '')
  const dialogue = parseMentions(shot.dialogue || '')
  const supplemental =
    extraPrompt.trim() && extraPrompt.trim() !== (shot.prompt || '').trim() ? parseMentions(extraPrompt) : []
  const mentions = (parts) => parts.filter((part) => part.type === 'card')
  const cited = mentions([...visual, ...dialogue])
  const ids = new Set(cited.map((part) => part.id))
  const issues = []
  const cards = []
  const state = ids.size ? 'referenced' : shot.assetFreeFor === scriptVersion(shot) ? 'none' : 'unreviewed'
  if (!(shot.prompt || '').trim() && !extraPrompt.trim())
    issues.push({ code: 'empty_script', message: '请先填写分镜画面脚本。' })
  const cardIndex = new Map(doc.cards.map((card) => [card.id, card]))
  const imageIds = new Set(doc.assets.filter((asset) => asset.kind === 'image').map((asset) => asset.id))
  const seen = new Set()
  for (const { id: cardId, outfitId: choice } of cited) {
    const card = cardIndex.get(cardId)
    const outfit = roleOutfit(card, choice)
    const outfitId = outfit?.id || choice
    const token = mentionToken(cardId, outfitId)
    if (seen.has(token)) continue
    seen.add(token)
    if (!card) {
      issues.push({
        code: 'missing_card',
        cardId,
        message: '分镜引用的设定卡已缺失（' + cardId + '），请在脚本中重新选择出场资产。'
      })
      continue
    }
    if (choice && !outfit) {
      issues.push({
        code: 'missing_outfit',
        cardId,
        outfitId: choice,
        message: '角色「' + card.name + '」引用的服饰已移除，请在脚本中重新选择。'
      })
      continue
    }
    const { type } = card
    const name = settingLabel(card, choice || (card.outfits ? outfitId : undefined))
    const assetId = settingImage(card, outfitId)
    const owner = { cardId, ...(outfitId ? { outfitId } : {}) }
    const hasImage = imageIds.has(assetId)
    cards.push({ ...owner, name, type, assetId, hasImage })
    if (!hasImage)
      issues.push({
        code: 'missing_image',
        ...owner,
        message: type + '「' + name + '」缺少参考图，请为此设定卡生成或绑定图片。'
      })
  }
  if ([...visual, ...dialogue, ...supplemental].some((p) => p.type === 'text' && p.text.includes('@{card')))
    issues.push({ code: 'invalid_token', message: '脚本含有不完整的设定卡标记，请用 @ 重新插入。' })
  for (const cardId of new Set(mentions(supplemental).map((part) => part.id))) {
    if (!ids.has(cardId))
      issues.push({
        code: 'supplemental_reference',
        cardId,
        message: '补充提示中的出场资产尚未写入分镜脚本，请先保存对应的 @ 引用。'
      })
  }
  for (const { cards: matches } of findNamedCards([...visual, ...supplemental], doc.cards)) {
    if (matches.some((card) => ids.has(card.id))) continue
    for (const card of matches)
      issues.push({
        code: 'unlinked_card',
        cardId: card.id,
        message: '画面文字提到' + card.type + '「' + card.name + '」，请用 @ 引用出场资产。'
      })
  }
  if (state === 'unreviewed')
    issues.push({
      code: 'unreviewed',
      message:
        '尚未核对出场资产。请在分镜中 @ 引用出场角色、场景和道具；确实无需资产时，确认此镜头无出场资产。'
    })
  if (state === 'none' && supplemental.length)
    issues.push({
      code: 'changed_prompt',
      message: '补充提示超出了已确认的无资产脚本。请先保存到分镜并重新核对出场资产。'
    })
  return { state, ready: !issues.length, cards, issues }
}

/** 构造发送给模型的有序图片。相同素材只传一次，同时保留其对应的全部出场设定。 */
export function shotReferenceImages(doc, shot, inspection = inspectShotAssets(doc, shot)) {
  const references = new Map()
  const frameId = shot.referenceId || shot.assetId
  if (doc.assets.some((asset) => asset.id === frameId && asset.kind === 'image'))
    references.set(frameId, { assetId: frameId, type: '分镜参考', name: shot.title || '首帧', subjects: [] })
  for (const { cardId, name, type, assetId, outfitId, hasImage } of inspection.cards) {
    if (!hasImage) continue
    const subject = { cardId, type, name, ...(outfitId ? { outfitId } : {}) }
    if (references.has(assetId)) {
      const ref = references.get(assetId)
      ref.subjects.push(subject)
      ref.name += '、' + type + '「' + name + '」'
    } else references.set(assetId, { ...subject, assetId, subjects: [subject] })
  }
  return [...references.values()]
}

/** 将离线文件定位到用图的每个设定与首帧，界面和本地生成使用同一份修复清单。 */
export function applyUnavailableImages(doc, shot, report, unavailableIds) {
  const issues = [...report.issues]
  const unavailable = (type, name, cardId, outfitId) =>
    issues.push({
      code: 'missing_file',
      ...(cardId ? { cardId } : {}),
      ...(outfitId ? { outfitId } : {}),
      message: type + '「' + name + '」的参考图文件已丢失或损坏。请重新导入或生成图片并绑定。'
    })
  const cards = report.cards.map((card) => {
    if (!card.hasImage || !unavailableIds.has(card.assetId)) return card
    unavailable(card.type, card.name, card.cardId, card.outfitId)
    return { ...card, hasImage: false }
  })
  const frameId = shot.referenceId || shot.assetId
  const frame = doc.assets.find((asset) => asset.id === frameId)
  if (
    (shot.referenceId && frame?.kind !== 'image') ||
    (frame?.kind === 'image' && unavailableIds.has(frameId))
  )
    unavailable('分镜', shot.title || '首帧')
  return { ...report, cards, issues, ready: !issues.length }
}
