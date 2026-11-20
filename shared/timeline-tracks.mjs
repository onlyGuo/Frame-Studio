// 轨道只组织片段。画面仍按主序列拼接，字幕跟随画面，音频按时间混合。
export const trackLabels = { visual: '画面', caption: '字幕', audio: '音频' }
const defaults = [
  { id: 'visual', kind: 'visual' },
  { id: 'caption', kind: 'caption' },
  { id: 'audio', kind: 'audio' }
]
export function timelineTracks(episode) {
  const tracks = episode.tracks || defaults
  const missing = defaults.filter((track) => {
    if (tracks.some(({ kind }) => kind === track.kind)) return false
    if (track.kind === 'visual') return episode.clips.length > 0
    if (track.kind === 'caption') return episode.clips.some((clip) => clip.caption)
    return episode.audio.length > 0
  })
  return missing.length ? [...tracks, ...missing] : tracks
}
export function clipTrack(tracks, kind, clip) {
  const explicit = kind === 'caption' ? clip.captionTrackId : clip.trackId
  return explicit || tracks.find((track) => track.kind === kind)?.id
}
/** 删除轨道和所属片段是一次工程修改；清除字幕不改变画面。 */
export function removeTrack(episode, track) {
  const tracks = timelineTracks(episode)
  if (track.kind === 'visual') {
    episode.clips = episode.clips.filter((clip) => clipTrack(tracks, 'visual', clip) !== track.id)
  } else if (track.kind === 'audio') {
    episode.audio = episode.audio.filter((clip) => clipTrack(tracks, 'audio', clip) !== track.id)
  } else {
    for (const clip of episode.clips) {
      if (clipTrack(tracks, 'caption', clip) !== track.id) continue
      clip.caption = ''
      delete clip.captionTrackId
    }
  }
  episode.tracks = tracks.filter(({ id }) => id !== track.id)
}

/** 固定旧片段的默认轨道，后续插入同类轨道不会改变现有归属。 */
export function assignDefaultTracks(episode) {
  const tracks = timelineTracks(episode)
  for (const clip of episode.clips) {
    clip.trackId ||= clipTrack(tracks, 'visual', clip)
    if (clip.caption) clip.captionTrackId ||= clipTrack(tracks, 'caption', clip)
  }
  for (const clip of episode.audio) clip.trackId ||= clipTrack(tracks, 'audio', clip)
  episode.tracks = [...tracks]
}
