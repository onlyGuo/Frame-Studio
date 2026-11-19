import { openAsBlob } from 'node:fs'
import path from 'node:path'
import { input, env, checkedFetch, download, fail, poll } from '../_lib/http.mjs'

const mimeTypes = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}
const base =
  env.STUDIO_API_URL.replace(/(?:\/v1)?\/videos(?:\/sync)?$/, '').replace(/\/v1$/, '') + '/v1/videos'
const headers = env.STUDIO_API_KEY ? { Authorization: 'Bearer ' + env.STUDIO_API_KEY } : {}
const task = { text: 't2va', 'first-frame': 'fl2va', references: 'ref2va' }[input.inputMode]
if (!task) await fail('submit', 'reference_unsupported')

/** 文本、严格首帧和混合参考各自选择服务端的 H3 工作模式。 */
const form = new FormData()
form.set('model', env.STUDIO_MODEL)
form.set('prompt', input.prompt)
form.set('num_inference_steps', env.STUDIO_INFERENCE_STEPS || '10')
form.set('fps', '24')
form.set('extra_params', JSON.stringify({ task, duration: input.duration }))
if (task !== 'fl2va') form.set('aspect_ratio', input.ratio)
for (const ref of [...input.references, ...(input.audioReferences || [])]) {
  const type = mimeTypes[path.extname(ref.path).toLowerCase()]
  if (!type) await fail('submit', 'reference_format')
  const file = await openAsBlob(ref.path, { type })
  form.append(task === 'fl2va' ? 'input_reference' : 'input_references', file, path.basename(ref.path))
}

async function requestJob(url, stage, body) {
  const options = { headers, redirect: 'error', signal: AbortSignal.timeout(90000) }
  const response = await checkedFetch(url, body ? { ...options, method: 'POST', body } : options, stage)
  try {
    return await response.json()
  } catch {
    return fail(stage, 'format')
  }
}

const job = await requestJob(base, 'submit', form)
if (typeof job.id !== 'string' || !job.id) await fail('submit', 'format')
const jobUrl = base + '/' + encodeURIComponent(job.id)
await poll(
  async () => {
    const current = await requestJob(jobUrl, 'poll')
    if (current.status === 'completed') return jobUrl + '/content'
    if (!['queued', 'in_progress'].includes(current.status)) await fail('poll', 'task')
  },
  (url) => download(url, { headers, redirect: 'error' })
)
