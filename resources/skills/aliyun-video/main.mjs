import { openAsBlob } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { referenceUrl, numberedPrompt } from '../_lib/reference-images.mjs'
import { input, env, dimensions, fail, request, checkedFetch } from '../_lib/http.mjs'
import { generateAsync } from '../_lib/wan.mjs'
import { validateVideoInputs, videoInputMode, videoPromptInput } from '../_lib/video-inputs.mjs'

/** 万相视频系列对参考图的边长和画幅有限制。 */
const imageUrl = (reference, megabytes = 20) =>
  referenceUrl(reference, { megabytes, minSide: 240, maxRatio: 8 })

/** 万相的参考音频使用百炼临时 OSS，上传请求只携带 OSS 的临时表单凭证。 */
async function uploadVoice(reference, policy) {
  const extension = path.extname(reference.path).toLowerCase()
  const name = randomUUID() + extension
  const key = policy.upload_dir + '/' + name
  const form = new FormData()
  for (const [field, value] of Object.entries({
    OSSAccessKeyId: policy.oss_access_key_id,
    Signature: policy.signature,
    policy: policy.policy,
    key,
    'x-oss-object-acl': policy.x_oss_object_acl,
    'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite,
    success_action_status: '200'
  }))
    form.set(field, value)
  const file = await openAsBlob(reference.path, { type: extension === '.wav' ? 'audio/wav' : 'audio/mpeg' })
  form.set('file', file, name)
  await checkedFetch(
    policy.upload_host,
    {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(90000)
    },
    'submit'
  )
  return 'oss://' + key
}

/** 根据服务选择的模型构造一次请求。图编号按供应商收到的数组顺序分配。 */
async function videoBody() {
  const model = env.STUDIO_MODEL
  const mode = videoInputMode('aliyun-video', model)
  const wan3 = mode === 'wan-multi'
  const wan27 = /^wan2\.7-/i.test(model)
  const i2v = mode === 'required-frame'
  const r2v = mode === 'wan-subjects'
  const refs = input.references || []
  const audio = wan3 ? input.audioReferences || [] : []
  try {
    validateVideoInputs('aliyun-video', model, refs, audio)
  } catch (err) {
    return fail('submit', err.code)
  }
  const { firstFrame, subjects } = videoPromptInput('aliyun-video', model, refs, audio)
  const source = { prompt: input.prompt }
  // 已保存的镜头对白和顺序由工作室控制，供应商扩写可能引入额外台词或转场。
  const parameters = { duration: input.duration, prompt_extend: false }
  if (wan3 || wan27 || i2v) parameters.resolution = '720P'
  else parameters.size = input.ratio === '1:1' ? '960*960' : dimensions.join('*')
  if (wan3 || (wan27 && !i2v)) parameters.ratio = input.ratio
  if (
    (wan3 || wan27) &&
    (!Number.isInteger(input.duration) || input.duration < 2 || input.duration > (wan3 ? 30 : 15))
  )
    return fail('submit', 'duration')
  if (wan3 || r2v) {
    const media = []
    if (firstFrame) media.push({ type: 'first_frame', url: await imageUrl(firstFrame) })
    for (const ref of subjects) media.push({ type: 'reference_image', url: await imageUrl(ref) })
    if (audio.length) {
      const query = new URLSearchParams({ action: 'getPolicy', model })
      const { data: policy } = await request('/uploads?' + query)
      const host = URL.parse(policy?.upload_host)
      if (
        !host ||
        (host.protocol !== 'https:' && host.origin !== new URL(env.STUDIO_API_URL).origin) ||
        host.username ||
        host.password ||
        !policy.upload_dir?.startsWith('dashscope-instant/') ||
        !policy.policy ||
        !policy.signature ||
        !policy.oss_access_key_id ||
        !policy.x_oss_object_acl ||
        !policy.x_oss_forbid_overwrite
      )
        return fail('submit', 'voice_upload')
      for (const ref of audio) media.push({ type: 'reference_audio', url: await uploadVoice(ref, policy) })
    }
    if (media.length) source.media = media
    source.prompt = numberedPrompt(subjects, input.prompt)
  } else if (i2v) {
    const url = await imageUrl(refs[0], /^wanx?2\.[12]-/i.test(model) ? 10 : 20)
    if (wan27) source.media = [{ type: 'first_frame', url }]
    else source.img_url = url
  }
  return { model, input: source, parameters }
}
await generateAsync(
  '/services/aigc/video-generation/video-synthesis',
  await videoBody(),
  (output) => output.video_url,
  input.audioReferences?.length ? { 'X-DashScope-OssResourceResolve': 'enable' } : {}
)
