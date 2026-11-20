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
  // 沿螺旋带面分片绘制，由远及近遮挡，穴孔及画格随曲面一起变形。
  const scale = Math.min(w / 640, h / 230)
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
  const slices = Array.from({ length: 310 }, (_, i) => ({ t: -4.95 + i * step, i })).sort(
    (a, b) => Math.cos(a.t) - Math.cos(b.t)
  )
  for (const { t, i } of slices) {
    const k = (Math.sin(t - 0.55) + 1) / 2,
      hue = 219 + 32 * Math.sin(t * 0.56),
      light = 25 + 37 * k,
      u = t + step * 1.025
    quad(t, u, -1, 1, `hsl(${hue} 40% ${light}%)`)
    quad(t, u, -0.72, 0.72, i % 21 < 2 ? '#202842' : `hsl(${hue + 17} 45% ${light - 10}%)`)
    for (const s of [-0.91, 0.78]) if (i % 5 < 3) quad(t, u, s, s + 0.13, '#1b2542')
    quad(t, u, -1, -0.98, `hsl(${hue} 52% ${light + 20}%)`)
  }
}
onMounted(() => {
  observer = new ResizeObserver(paint)
  observer.observe(canvas.value)
  paint()
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template><canvas ref="canvas" class="film-art" aria-hidden="true" /></template>
