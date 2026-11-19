import { generateLegacyImage, generateAsync, imageSize } from '../_lib/wan.mjs'
import { referenceUrl, numberedPrompt } from '../_lib/reference-images.mjs'
import { input, env, download, fail, request } from '../_lib/http.mjs'

/** 千问及新版万相采用多模态消息协议；早期万相沿用异步文生图接口。 */
if (/^(qwen-image|wan2\.[67]-(image|t2i))/i.test(env.STUDIO_MODEL)) {
  const refs = /^qwen-image-3\.0(?:-|$)/i.test(env.STUDIO_MODEL) ? input.references || [] : []
  if (refs.length > 3) await fail('submit', 'reference_limit')
  const content = []
  for (const reference of refs) content.push({ image: await referenceUrl(reference, { megabytes: 10 }) })
  content.push({ text: numberedPrompt(refs, input.prompt) })
  const body = {
    model: env.STUDIO_MODEL,
    input: { messages: [{ role: 'user', content }] },
    parameters: { size: imageSize, n: 1 }
  }
  const imageUrl = (output) => output?.choices?.[0]?.message?.content?.find((part) => part.image)?.image
  if (env.STUDIO_MODEL.toLowerCase() === 'wan2.6-image') {
    // 万相 2.6 image 的纯文本输入必须开启图文混排，异步调用可直接取得最终图像。
    Object.assign(body.parameters, { enable_interleave: true, max_images: 1 })
    await generateAsync('/services/aigc/image-generation/generation', body, imageUrl)
  } else {
    const result = await request('/services/aigc/multimodal-generation/generation', body, {}, 600000)
    const image = imageUrl(result.output)
    if (!image) await fail('submit', 'format')
    await download(image)
  }
} else {
  await generateLegacyImage()
}
