import fs from 'node:fs/promises'
import { input, env, request, fail } from '../_lib/http.mjs'

/** 有现成音色时直接合成，否则让音色设计接口返回试听音频。 */
async function generateSample() {
  if (input.voiceId) {
    const result = await request('/t2a_v2', {
      model: env.STUDIO_MODEL,
      text: input.sampleText,
      voice_setting: { voice_id: input.voiceId },
      audio_setting: { format: 'mp3', channel: 1 }
    })
    if (result.base_resp?.status_code) return fail('submit', 'task')
    return result.data?.audio
  }
  const result = await request('/voice_design', { prompt: input.prompt, preview_text: input.sampleText })
  if (result.base_resp?.status_code) return fail('submit', 'task')
  return result.trial_audio
}

const hex = await generateSample()
if (typeof hex !== 'string' || !hex.length || hex.length % 2 || /[^0-9a-f]/i.test(hex))
  await fail('submit', 'format')
await fs.writeFile(input.output, Buffer.from(hex, 'hex'))
