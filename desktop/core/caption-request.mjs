import { randomUUID } from 'node:crypto'
// 字幕由 Chromium 系统字体排版。请求与回复通过一次性编号配对。
const pending = new Map()
export function receiveCaptions({ id, images }) {
  pending.get(id)?.(images)
}
export function requestCaptions(window, ratio, quality, clips, signal) {
  const rows = clips.filter((c) => c.caption).map(({ id, caption }) => ({ id, caption }))
  if (!rows.length) return Promise.resolve({})
  const id = randomUUID(),
    wait = AbortSignal.any([signal, AbortSignal.timeout(20000)])
  wait.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      pending.delete(id)
      wait.removeEventListener('abort', cancel)
    }
    const cancel = () => {
      finish()
      reject(Error('字幕渲染已停止'))
    }
    pending.set(id, (images) => {
      finish()
      resolve(images)
    })
    wait.addEventListener('abort', cancel, { once: true })
    window.webContents.send('studio:captions', { id, ratio, quality, rows })
  })
}
