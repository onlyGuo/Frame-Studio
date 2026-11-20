import { sequence } from './model.mjs'
import { clipTrack, timelineTracks } from './timeline-tracks.mjs'

/** 兼容旧工程内嵌字幕，读取时给每条字幕独立身份和时间范围。 */
export function timelineCaptions(episode) {
  return [
    ...(episode.captions || []),
    ...sequence(episode.clips)
      .filter((clip) => clip.caption)
      .map((clip) => ({
        id: clip.id,
        caption: clip.caption,
        start: clip.start,
        duration: clip.duration,
        trackId: clip.captionTrackId || timelineTracks(episode).find((track) => track.kind === 'caption')?.id
      }))
  ]
}

/** 首次时间线编辑固定旧片段位置并拆出字幕，整个迁移随本次操作撤销。 */
export function materializeTimeline(episode) {
  const captions = timelineCaptions(episode)
  episode.clips = sequence(episode.clips).map(({ end, captionTrackId, ...clip }) => ({
    ...clip,
    caption: ''
  }))
  episode.captions = captions
}

/** 上方画面轨道优先，同轨重叠时后开始的片段优先。预览与导出共用。 */
export function pictureAt(episode, time) {
  const tracks = timelineTracks(episode)
  return sequence(episode.clips)
    .filter((clip) => time >= clip.start && time < clip.end)
    .sort(
      (a, b) =>
        tracks.findIndex((t) => t.id === clipTrack(tracks, 'visual', a)) -
          tracks.findIndex((t) => t.id === clipTrack(tracks, 'visual', b)) ||
        b.start - a.start ||
        episode.clips.findIndex((c) => c.id === b.id) - episode.clips.findIndex((c) => c.id === a.id)
    )[0]
}
/** 收集当前可见字幕，预览与编码使用相同的多行文本。 */
export function captionsAt(episode, time) {
  return timelineCaptions(episode)
    .filter((c) => time >= c.start && time < c.start + c.duration)
    .map((c) => c.caption)
    .join('\n')
}
/** 所有媒体及字幕的最晚结束时间决定播放和导出范围。 */
export function timelineEnd(episode) {
  return Math.max(
    0,
    ...sequence(episode.clips).map((c) => c.end),
    ...[...episode.audio, ...timelineCaptions(episode)].map((c) => c.start + c.duration)
  )
}

/** 将独立轨道展开成实际可见区间，空隙输出黑场，字幕和音频尾部完整保留。 */
export function renderSegments(episode, fps = 25) {
  const clips = sequence(episode.clips)
  const captions = timelineCaptions(episode)
  const boundaries = [
    ...new Set(
      [
        0,
        timelineEnd(episode),
        ...[...clips, ...captions].flatMap((c) => [c.start, c.start + c.duration])
      ].map((time) => Math.ceil(time * fps - 1e-7))
    )
  ]
    .sort((a, b) => a - b)
    .map((frame) => frame / fps)
  return boundaries.slice(0, -1).map((start, index) => {
    const duration = boundaries[index + 1] - start
    const clip = pictureAt(episode, start + 1e-8)
    return {
      ...(clip || { trim: 0, volume: 0 }),
      id: 'segment-' + index,
      trim: clip ? clip.trim + start - clip.start : 0,
      start,
      duration,
      caption: captionsAt(episode, start + 1e-8)
    }
  })
}
