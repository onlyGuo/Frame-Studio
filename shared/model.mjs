import { timelineTracks } from './timeline-tracks.mjs'

// 工程、人工编辑和智能体提案共用的创作模型。
export const uid = () => globalThis.crypto.randomUUID()
export const formats = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960] }
/** 按工程画幅换算成片尺寸，方形画幅采用相同面积等级。 */
export function outputSize(ratio, quality = '720p') {
  return formats[ratio].map((n) => (quality === '1080p' ? Math.round(n * 1.5) : n))
}
/** 初始化同时包含剧本、分镜及剪辑轨道的分集。 */
export const makeEpisode = () => ({ id: uid(), title: '第一集', script: '', shots: [], clips: [], audio: [] })
/** 建立尚未绑定素材的分镜。 */
export const makeShot = () => ({
  id: uid(),
  title: '新镜头',
  prompt: '',
  dialogue: '',
  referenceId: '',
  duration: 5,
  assetId: ''
})
/** 建立角色、场景或道具的视觉设定卡。 */
export const makeCard = () => ({ id: uid(), type: '角色', name: '新角色', notes: '', assetId: '' })
/** 初始化主画面轨道的裁切与字幕属性。 */
export const makeClip = (assetId, duration = 5) => ({
  id: uid(),
  assetId,
  trim: 0,
  duration,
  volume: 1,
  caption: ''
})
/** 初始化独立混音片段。 */
export const makeAudio = (assetId, duration = 5) => ({
  id: uid(),
  assetId,
  start: 0,
  trim: 0,
  duration,
  volume: 0.7
})
/** 按画幅创建本地工程与首集。 */
export function makeProject(title, ratio = '16:9') {
  return {
    version: 1,
    id: uid(),
    revision: 0,
    title,
    ratio,
    quality: '720p',
    fps: 25,
    synopsis: '',
    cards: [],
    episodes: [makeEpisode()],
    assets: [],
    messages: []
  }
}

/** 字段校验也用于导入包和智能体输出，未知字段无法进入工程。 */
const str =
  (max = 80000, min = 0) =>
  (value) =>
    typeof value === 'string' && value.length >= min && value.length <= max
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
const refId = (value) => value === '' || id(value)
const number = (min, max) => (value) => Number.isFinite(value) && value >= min && value <= max
const one =
  (...values) =>
  (value) =>
    values.includes(value)
const fields = (spec) => (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(spec).length &&
  Object.entries(spec).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
const list =
  (check, limit = 5000) =>
  (value) =>
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(check) &&
    new Set(value.map((item) => item.id)).size === value.length
const time = number(0, 86400)
const length = number(0.04, 86400)
const mediaFields = { id, assetId: id, trim: time, duration: length, volume: number(0, 1) }
const clipFields = { ...mediaFields, caption: str(500) }
const looseClip = fields(clipFields)
const shotClip = fields({ ...clipFields, sourceShotId: id })
const clip = (value) => {
  if (!value) return false
  const { trackId, captionTrackId, start, ...item } = value
  return (
    (trackId === undefined || id(trackId)) &&
    (captionTrackId === undefined || id(captionTrackId)) &&
    (start === undefined || time(start)) &&
    (looseClip(item) || shotClip(item))
  )
}
const audioFields = fields({ ...mediaFields, start: time })
const audio = (value) => {
  if (!value) return false
  const { trackId, ...item } = value
  return (trackId === undefined || id(trackId)) && audioFields(item)
}
const tracks = list(fields({ id, kind: one('visual', 'caption', 'audio') }), 64)
const shotFields = {
  id,
  title: str(200, 1),
  prompt: str(),
  dialogue: str(),
  duration: length,
  assetId: refId
}
// 早期镜头只有主素材字段，读取时继续保留原始清单。
const oldShot = fields(shotFields)
const currentShot = fields({ ...shotFields, referenceId: refId })
const shot = (value) => {
  if (!value || typeof value !== 'object') return false
  const { assetFreeFor, ...base } = value
  return (assetFreeFor === undefined || str(160009)(assetFreeFor)) && (currentShot(base) || oldShot(base))
}
const episodeFields = fields({
  id,
  title: str(200, 1),
  script: str(500000),
  shots: list(shot),
  clips: list(clip),
  audio: list(audio)
})
const captions = list(fields({ id, caption: str(500), start: time, duration: length, trackId: id }))
const episode = (value) => {
  if (!value) return false
  const { tracks: rows, captions: subtitles, ...base } = value
  return (
    episodeFields(base) &&
    (rows === undefined || tracks(rows)) &&
    (subtitles === undefined || captions(subtitles))
  )
}
const cardFields = {
  id,
  name: str(200, 1),
  type: one('角色', '场景', '道具'),
  notes: str(),
  assetId: refId
}
const legacyCard = fields(cardFields)
const outfittedCard = fields({
  ...cardFields,
  outfits: list(fields({ id, name: str(200, 1), notes: str(), assetId: refId }), 100),
  defaultOutfitId: id
})
const card = (value) => value && validCard(value)
function validCard(value) {
  const { voiceAssetId, ...base } = value
  if (Object.hasOwn(value, 'voiceAssetId') && (base.type !== '角色' || !refId(voiceAssetId))) return false
  return (
    legacyCard(base) ||
    (outfittedCard(base) && base.type === '角色' && base.outfits.some((o) => o.id === base.defaultOutfitId))
  )
}
export const mediaKinds = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio'
}
const asset = fields({
  id,
  name: str(300, 1),
  ext: one(...Object.keys(mediaKinds)),
  kind: one('image', 'audio', 'video'),
  duration: time
})
const project = fields({
  version: one(1),
  id,
  revision: (value) => Number.isSafeInteger(value) && value >= 0,
  title: str(200, 1),
  ratio: one(...Object.keys(formats)),
  quality: one('720p', '1080p'),
  fps: one(24, 25, 30),
  synopsis: str(),
  cards: list(card),
  episodes: list(episode, 500),
  assets: list(asset),
  messages: list(fields({ id, role: one('user', 'assistant'), text: str(80000) }))
})

/** 检查媒体绑定及剪辑源范围；素材文件名只从受限 ID 与扩展名构造。 */
export function validateProject(value) {
  if (!project(value) || !value.episodes.length) throw Error('工程字段无效，请检查名称、时长或工程版本')
  const assets = new Map(value.assets.map((a) => [a.id, a]))
  for (const a of value.assets) if (a.kind !== mediaKinds[a.ext]) throw Error('素材类型不匹配')
  const check = (key, kinds) => {
    if (key && !kinds.includes(assets.get(key)?.kind)) throw Error('关联素材缺失或类型不匹配')
  }
  for (const c of value.cards) {
    check(c.assetId, ['image'])
    check(c.voiceAssetId, ['audio'])
    if (c.voiceAssetId) validateVoiceSample(assets.get(c.voiceAssetId))
    for (const outfit of c.outfits || []) check(outfit.assetId, ['image'])
  }
  for (const e of value.episodes) {
    const trackKinds = new Map(timelineTracks(e).map(({ id, kind }) => [id, kind]))
    for (const clip of e.clips) {
      if (
        (clip.trackId && trackKinds.get(clip.trackId) !== 'visual') ||
        (clip.captionTrackId && trackKinds.get(clip.captionTrackId) !== 'caption')
      )
        throw Error('画面或字幕所属轨道无效')
    }
    for (const caption of e.captions || [])
      if (trackKinds.get(caption.trackId) !== 'caption') throw Error('字幕所属轨道无效')
    for (const clip of e.audio)
      if (clip.trackId && trackKinds.get(clip.trackId) !== 'audio') throw Error('音频所属轨道无效')
    for (const s of e.shots) {
      check(s.assetId, ['image', 'video'])
      check(s.referenceId, ['image'])
    }
    for (const c of [...e.clips, ...e.audio]) {
      check(c.assetId, e.audio.includes(c) ? ['audio', 'video'] : ['image', 'video'])
      const asset = assets.get(c.assetId)
      if (asset.duration && c.trim + c.duration > asset.duration + 0.05) throw Error('裁切范围超出素材时长')
    }
  }
  return value
}

/** 角色卡保存可同时供海螺和万相参考的单人样音。 */
export function validateVoiceSample(asset) {
  if (!['.wav', '.mp3'].includes(asset?.ext) || !(asset.duration >= 2 && asset.duration <= 15))
    throw Error('角色样音须为 2–15 秒的 WAV 或 MP3。')
}

/** 使用显式起点构建时间范围，旧工程和新追加的片段沿已有末尾排列。 */
export function sequence(clips) {
  let start = 0
  return clips.map((clip) => {
    const at = clip.start ?? start
    const item = { ...clip, start: at, end: at + clip.duration }
    start = Math.max(start, item.end)
    return item
  })
}
