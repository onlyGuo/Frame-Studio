import { input, env, dimensions, request, poll, fail } from './http.mjs'

/** 万相 2.5/2.6 文生图要求总像素不低于 1280 × 1280。 */
export const imageSize = /^wan2\.[56]-t2i/i.test(env.STUDIO_MODEL)
  ? { '16:9': '1920*1080', '9:16': '1080*1920', '1:1': '1280*1280' }[input.ratio]
  : dimensions.join('*')

/** 旧版万相使用异步文生图接口。 */
export async function generateLegacyImage() {
  await generateAsync(
    '/services/aigc/text2image/image-synthesis',
    { model: env.STUDIO_MODEL, input: { prompt: input.prompt }, parameters: { n: 1, size: imageSize } },
    (output) => output.results?.[0]?.url
  )
}

/** 提交一次异步任务，轮询至终态，只下载该任务的产物。 */
export async function generateAsync(route, body, imageOrVideoUrl) {
  const result = await request(route, body, { 'X-DashScope-Async': 'enable' })
  if (!result.output?.task_id) await fail('submit', 'format')
  await poll(async () => {
    const { output } = await request('/tasks/' + encodeURIComponent(result.output.task_id))
    if (output?.task_status === 'SUCCEEDED') {
      const url = imageOrVideoUrl(output)
      if (!url) await fail('poll', 'format')
      return url
    }
    if (!['PENDING', 'RUNNING'].includes(output?.task_status)) await fail('poll', 'task')
  })
}
