import { onFrame } from './timecode.mjs'

const snapDistance = 8

/** 片段两端都可吸附，同距离时优先播放头，其余位置对齐工程帧率。 */
export function clipDrop(desired, duration, scale, fps, points) {
  const position = Math.max(0, Math.min(86400, desired))
  let start = onFrame(position, fps)
  let best = snapDistance / scale
  let snap = null
  for (const point of points) {
    for (const candidate of [point.time, point.time - duration]) {
      const distance = Math.abs(position - candidate)
      if (candidate < 0 || candidate > 86400 || distance > best || (snap && distance === best)) continue
      best = distance
      start = candidate
      snap = point
    }
  }
  return { start, snap }
}
