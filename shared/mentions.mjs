// 分镜脚本用普通字符串保存，占位中的稳定 ID 既可由编辑器插入，也可由工程工具写入。
import { roleOutfit, settingImage, settingLabel } from './outfits.mjs'

const tokenPattern = /@\{card:([a-zA-Z0-9_-]{1,80})(?::([a-zA-Z0-9_-]{1,80}))?\}/g
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id)

/** 根据设定卡的工程 ID 构造占位符。 */
export function mentionToken(id, outfitId) {
  if (!validId(id) || (outfitId && !validId(outfitId))) throw Error('设定卡或服饰 ID 无效')
  return '@{card:' + id + (outfitId ? ':' + outfitId : '') + '}'
}

/** 将分镜脚本拆为文本和资产节点，保留原始空白、换行以及重复出场的角色。 */
export function parseMentions(text) {
  const parts = []
  let position = 0
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > position) parts.push({ type: 'text', text: text.slice(position, match.index) })
    parts.push({ type: 'card', id: match[1], ...(match[2] ? { outfitId: match[2] } : {}) })
    position = match.index + match[0].length
  }
  if (position < text.length) parts.push({ type: 'text', text: text.slice(position) })
  return parts
}

/** 将台词中的标记展开为当前资产名称，并将每份出场设定只附加一次，供媒体生成使用。 */
export function resolveMentions(source, cards, { includeNotes = true, labelOutfits = false } = {}) {
  const index = new Map(cards.map((card) => [card.id, card]))
  const used = new Map()
  const line = parseMentions(source)
    .map((part) => {
      if (part.type === 'text') return part.text
      const card = index.get(part.id)
      if (!card) throw Error('分镜脚本引用的设定卡已缺失：' + part.id + '。请重新选择资产。')
      const outfit = roleOutfit(card, part.outfitId)
      if (part.outfitId && !outfit)
        throw Error('分镜脚本引用的服饰已缺失：' + card.name + '。请重新选择服饰。')
      used.set(mentionToken(part.id, part.outfitId), {
        ...card,
        ...(outfit && (card.outfits || part.outfitId)
          ? { outfitId: outfit.id, outfitName: outfit.name, outfitNotes: outfit.notes }
          : {}),
        assetId: settingImage(card, part.outfitId)
      })
      return labelOutfits && (card.outfits || part.outfitId) ? settingLabel(card, outfit?.id) : card.name
    })
    .join('')
  const referenced = [...used.values()]
  const notes = includeNotes
    ? referenced.map((card) => {
        const details = [card.notes?.trim(), card.outfitNotes?.trim()].filter(Boolean)
        return '【' + card.type + '】' + card.name + (details.length ? '：' + details.join('；') : '')
      })
    : []
  return { text: notes.length ? line + '\n\n视觉设定\n' + notes.join('\n') : line, cards: referenced }
}

/** 保留分镜内已删除卡的稳定占位，制作前可逐处发现并替换缺失的出场设定。 */
export function removeSettingCard(draft, id) {
  draft.cards = draft.cards.filter((item) => item.id !== id)
}

/** 按真实分镜引用建立资产索引；同一张卡在同一镜头内多次出现只登记一次。 */
export function indexShotMentions(episodes) {
  const index = new Map()
  for (const episode of episodes) {
    for (const [position, shot] of episode.shots.entries()) {
      const ids = new Set(
        [...parseMentions(shot.prompt), ...parseMentions(shot.dialogue || '')]
          .filter((part) => part.type === 'card')
          .map((part) => part.id)
      )
      for (const id of ids) {
        if (!index.has(id)) index.set(id, [])
        index.get(id).push({
          episodeId: episode.id,
          episodeTitle: episode.title,
          shotId: shot.id,
          shotTitle: shot.title,
          number: position + 1
        })
      }
    }
  }
  return index
}
