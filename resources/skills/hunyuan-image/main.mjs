import { createHash, createHmac } from 'node:crypto'
import { input, env, dimensions, poll } from '../_lib/http.mjs'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const mac = (key, value) => createHmac('sha256', key).update(value).digest()
/** 按云 API 3.0 规范使用 TC3-HMAC-SHA256 签名。 */
async function call(action, data) {
  const host = new URL(env.STUDIO_API_URL).host
  const time = Math.floor(Date.now() / 1000)
  const date = new Date(time * 1000).toISOString().slice(0, 10)
  const body = JSON.stringify(data)
  const canonical = [
    'POST',
    '/',
    '',
    'content-type:application/json\nhost:' + host + '\n',
    'content-type;host',
    hash(body)
  ].join('\n')
  const scope = date + '/hunyuan/tc3_request'
  const signKey = mac(mac(mac('TC3' + env.STUDIO_API_KEY, date), 'hunyuan'), 'tc3_request')
  const signature = mac(signKey, ['TC3-HMAC-SHA256', time, scope, hash(canonical)].join('\n')).toString('hex')
  const res = await fetch(env.STUDIO_API_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-TC-Action': action,
      'X-TC-Version': '2023-09-01',
      'X-TC-Timestamp': String(time),
      'X-TC-Region': env.STUDIO_REGION,
      Authorization:
        'TC3-HMAC-SHA256 Credential=' +
        env.STUDIO_SECRET_ID +
        '/' +
        scope +
        ', SignedHeaders=content-type;host, Signature=' +
        signature
    }
  })
  const result = (await res.json()).Response
  if (!res.ok || !result || result.Error) throw Error('混元请求失败')
  return result
}
const { JobId } = await call('SubmitHunyuanImageJob', {
  Prompt: input.prompt,
  Resolution: dimensions.join(':')
})
if (!JobId) throw Error('未返回任务 ID')
await poll(async () => {
  const job = await call('QueryHunyuanImageJob', { JobId })
  if (job.JobStatusCode === '5') return job.ResultImage[0]
  if (!['1', '2'].includes(job.JobStatusCode)) throw Error('混元生成失败')
})
