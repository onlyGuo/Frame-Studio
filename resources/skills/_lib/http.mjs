import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout } from 'node:timers/promises'
export const input = JSON.parse(
  await new Promise((resolve, reject) => {
    let data = ''
    process.stdin
      .setEncoding('utf8')
      .on('data', (part) => (data += part))
      .on('end', () => resolve(data))
      .on('error', reject)
  })
)
export const env = process.env
export const dimensions = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1024, 1024] }[input.ratio]
/** 仅传回阶段、错误类别及 HTTP 状态，避免供应商响应内容流入对话。 */
export async function fail(stage, reason, status) {
  await fs.writeFile(input.output + '.diagnostic', JSON.stringify({ stage, reason, status }))
  throw Error('媒体服务请求失败')
}
export async function checkedFetch(url, options, stage) {
  let response
  try {
    response = await fetch(url, options)
  } catch (e) {
    return fail(stage, e.name === 'TimeoutError' ? 'timeout' : 'network')
  }
  if (!response.ok) return fail(stage, 'http', response.status)
  return response
}
/** 鉴权头只随 API 请求发送；结果下载独立请求，不复用鉴权。 */
export async function request(route, body, headers = {}, timeout = 90000) {
  const res = await checkedFetch(
    env.STUDIO_API_URL + route,
    {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.STUDIO_API_KEY,
        ...headers
      },
      body: body && JSON.stringify(body)
    },
    body ? 'submit' : 'poll'
  )
  return res.json()
}
export async function download(url, options = {}) {
  if (!['https:', 'http:'].includes(new URL(url).protocol)) throw Error('无效的下载地址')
  const res = await checkedFetch(url, { signal: AbortSignal.timeout(300000), ...options }, 'download')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(input.output))
}
export const saveBytes = (data) => fs.writeFile(input.output, Buffer.from(data, 'base64'))
/** 厂商返回终态或超时即退出，不重复提交计费任务。 */
export async function poll(check, save = download) {
  for (let i = 0; i < 180; i++) {
    const url = await check()
    if (url) return save(url)
    await setTimeout(5000)
  }
  return fail('poll', 'timeout')
}
