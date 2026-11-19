<script setup vapor>
import { ref, onMounted, onBeforeUnmount } from 'vue'
const canvas = ref(null)
let observer
/** 投影带齿孔的三维胶片，在不同窗口宽度保持同一画幅。 */
function paint() {
  const el = canvas.value,
    w = el.clientWidth,
    h = el.clientHeight
  if (!w || !h) return
  const d = Math.min(devicePixelRatio, 2)
  el.width = w * d
  el.height = h * d
  const ctx = el.getContext('2d')
  ctx.scale(d, d)
  const light = ctx.createRadialGradient(w * 0.58, h * 0.52, 0, w * 0.58, h * 0.52, w * 0.62)
  light.addColorStop(0, '#484c40')
  light.addColorStop(0.55, '#222722')
  light.addColorStop(1, '#191d1b')
  ctx.fillStyle = light
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#a5b5a513'
  ctx.lineWidth = 0.7
  for (let x = 0; x < w; x += 24) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let y = 0; y < h; y += 24) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  // 沿螺旋带面分片绘制，由远及近遮挡，穴孔及画格随曲面一起变形。
  const scale = Math.min(w / 540, h / 220)
  function point(t, s) {
    const x = 69 * t + 92 * Math.sin(t),
      z = 105 * Math.cos(t),
      y = -27 * t + s * 39
    const a = -0.16
    return [
      w * 0.53 + (x * Math.cos(a) - y * Math.sin(a)) * scale,
      h * 0.52 + (x * Math.sin(a) + y * Math.cos(a) - z * 0.35) * scale
    ]
  }
  function quad(t, u, a, b, color) {
    const pts = [point(t, a), point(u, a), point(u, b), point(t, b)]
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  const step = 0.032
  const slices = Array.from({ length: 330 }, (_, i) => ({ t: -5 + i * step, i })).sort(
    (a, b) => Math.cos(a.t) - Math.cos(b.t)
  )
  for (const { t, i } of slices) {
    const k = (Math.sin(t - 0.55) + 1) / 2,
      m = Math.round(48 + 170 * k),
      u = t + step * 1.025
    quad(t, u, -1, 1, 'rgb(' + [m, m + 5, Math.min(255, m + 1)].join(',') + ')')
    quad(
      t,
      u,
      -0.72,
      0.72,
      i % 21 < 2 ? '#3a4038' : 'hsl(78, ' + (12 + k * 14) + '%, ' + (16 + k * 37) + '%)'
    )
    for (const s of [-0.91, 0.78]) if (i % 5 < 3) quad(t, u, s, s + 0.13, '#252b23')
    quad(t, u, -1, -0.975, '#c4c7b4')
  }
  ctx.strokeStyle = '#bac9a4'
  for (const [x, y, dx, dy] of [
    [18, 18, 1, 1],
    [w - 18, 18, -1, 1],
    [18, h - 18, 1, -1],
    [w - 18, h - 18, -1, -1]
  ]) {
    ctx.beginPath()
    ctx.moveTo(x + dx * 12, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + dy * 12)
    ctx.stroke()
  }
}
onMounted(() => {
  observer = new ResizeObserver(paint)
  observer.observe(canvas.value)
  paint()
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template><canvas ref="canvas" class="film-art" aria-label="银绿色螺旋胶片插画" /></template>
