import { outputSize } from '../shared/model.mjs'
/** 预览与导出使用相同字体、换行和描边，保证字幕位置一致。 */
export function captionImage(text, ratio, quality) {
  if (!text) return ''
  const [w, h] = outputSize(ratio, quality),
    canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d'),
    size = Math.round(Math.min(w, h) * 0.043)
  ctx.font = '600 ' + size + 'px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#121512'
  ctx.fillStyle = 'white'
  ctx.lineWidth = size * 0.13
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const ch of paragraph) {
      if (ctx.measureText(line + ch).width > w * 0.88 && line) {
        lines.push(line)
        line = ''
      }
      line += ch
    }
    lines.push(line)
  }
  lines.forEach((line, i) => {
    const y = h * 0.91 - (lines.length - 1 - i) * size * 1.32
    ctx.strokeText(line, w / 2, y)
    ctx.fillText(line, w / 2, y)
  })
  return canvas.toDataURL('image/png')
}
