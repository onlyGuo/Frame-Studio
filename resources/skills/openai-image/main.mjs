import { input, env, request, download, saveBytes } from '../_lib/http.mjs'
const size = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' }[input.ratio]
const result = await request('/images/generations', {
  model: env.STUDIO_MODEL,
  prompt: input.prompt,
  n: 1,
  size
})
const item = result.data?.[0]
if (item?.b64_json) await saveBytes(item.b64_json)
else await download(item?.url)
