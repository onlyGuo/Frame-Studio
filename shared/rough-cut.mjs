import { makeClip } from './model.mjs'
import { mentionToken, parseMentions } from './mentions.mjs'

/** 字幕显示角色名，保留无法解析的旧引用供创作者修订。 */
function captionText(dialogue, cards) {
  return parseMentions(dialogue)
    .map((part) =>
      part.type === 'text'
        ? part.text
        : (cards.find((card) => card.id === part.id)?.name ?? mentionToken(part.id, part.outfitId))
    )
    .join('')
}

/** 从镜头建立可独立调整的画面片段，实际取用时长受素材和镜头设计的共同约束。 */
export function clipFromShot(shot, asset, cards = []) {
  return clipWithCaption(shot, asset, captionText(shot.dialogue, cards))
}

function clipWithCaption(shot, asset, caption) {
  const duration = Math.min(asset.duration || shot.duration, shot.duration)
  return { ...makeClip(asset.id, duration), sourceShotId: shot.id, caption: caption.slice(0, 500) }
}

/** 只补齐未剪成镜。以镜头来源定位已有片段，旧工程每条无来源片段最多匹配一个镜头。 */
export function roughCut(episode, assets, cards = []) {
  const index = new Map(assets.map((a) => [a.id, a]))
  const ready = episode.shots.filter((s) => {
    const a = index.get(s.assetId)
    return a?.kind === 'video' && (!a.duration || a.duration >= 0.04)
  })
  // 同一镜头可能已分割成多段，自动插入避开既有裁切范围。
  const anchors = new Map()
  const legacy = new Map()
  const clips = [...episode.clips]
  for (const [i, c] of clips.entries()) {
    if (c.sourceShotId && index.get(c.assetId)?.kind === 'video') {
      const range = anchors.get(c.sourceShotId)
      anchors.set(c.sourceShotId, { first: range?.first ?? i, last: i })
    } else if (!c.sourceShotId) {
      if (!legacy.has(c.assetId)) legacy.set(c.assetId, [])
      legacy.get(c.assetId).push(i)
    }
  }
  let linked = 0
  for (const shot of ready) {
    if (anchors.has(shot.id)) continue
    const match = legacy.get(shot.assetId)?.shift()
    if (match === undefined) continue
    clips[match] = { ...clips[match], sourceShotId: shot.id }
    anchors.set(shot.id, { first: match, last: match })
    linked++
  }
  const insert = new Map()
  let next = null,
    subtitlesShortened = 0,
    added = 0
  const nextAnchor = ready.map(() => null)
  for (let i = ready.length - 1; i >= 0; i--) {
    nextAnchor[i] = next
    if (anchors.has(ready[i].id)) next = anchors.get(ready[i].id).first
  }
  let previous = null
  for (const [i, s] of ready.entries()) {
    const anchor = anchors.get(s.id)
    if (anchor) {
      previous = anchor.last
      continue
    }
    // 两个锚点被人工交换时保留当前剪辑顺序，新镜头紧邻前一个分镜。
    const before = nextAnchor[i]
    const at =
      before !== null && (previous === null || before > previous)
        ? before
        : previous !== null
          ? previous + 1
          : clips.length
    if (!insert.has(at)) insert.set(at, [])
    const caption = captionText(s.dialogue, cards)
    insert.get(at).push(clipWithCaption(s, index.get(s.assetId), caption))
    if (caption.length > 500) subtitlesShortened++
    added++
  }
  const merged = []
  for (let i = 0; i <= clips.length; i++) {
    merged.push(...(insert.get(i) || []))
    if (i < clips.length) merged.push(clips[i])
  }
  return {
    clips: merged,
    added,
    linked,
    existing: ready.length - added,
    pending: episode.shots.length - ready.length,
    subtitlesShortened
  }
}
