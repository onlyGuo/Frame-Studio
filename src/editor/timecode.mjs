/** 以工程帧率显示无丢帧时码，避免毫秒读数跨秒进位。 */
export function timecode(seconds, fps) {
  const frames = Math.max(0, Math.round(seconds * fps))
  const whole = Math.floor(frames / fps)
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, frames % fps]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}
/** 输入可为 HH:MM:SS:FF、MM:SS:FF，也可以直接输入秒数。 */
export function parseTimecode(value, fps) {
  const raw = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  const parts = raw.split(':')
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) return null
  const [hours, minutes, seconds, frames] = (parts.length === 3 ? ['0', ...parts] : parts).map(Number)
  if (minutes >= 60 || seconds >= 60 || frames >= fps) return null
  return hours * 3600 + minutes * 60 + seconds + frames / fps
}
export const onFrame = (sec, fps) => Math.round(sec * fps) / fps
