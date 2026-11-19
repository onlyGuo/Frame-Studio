export const isMiniMaxH3 = (model = '') => /^MiniMax-H3(?:-(?:Highspeed|Lite|Max))?$/i.test(model)

/** 内置视频适配器实际实现的图像输入模式。自定义模型仅在能力明确时接收图片。 */
export function videoInputMode(provider, model = '') {
  if (provider === 'vllm-h3') return 'h3'
  if (provider === 'aliyun-video') {
    if (/^wan3\.0-video(?:-|$)/i.test(model)) return 'wan-multi'
    if (/^wan2\.7-r2v(?:-|$)/i.test(model)) return 'wan-subjects'
    if (/^wan2\.6-r2v(?:-|$)/i.test(model)) return 'remote-only'
    if (/-i2v(?:-|$)/i.test(model)) return 'required-frame'
  }
  if (provider === 'minimax-video') {
    if (isMiniMaxH3(model)) return 'h3'
    if (['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'].includes(model)) return 'optional-frame'
    if (['MiniMax-Hailuo-2.3-Fast', 'I2V-01', 'I2V-01-live', 'I2V-01-Director'].includes(model))
      return 'required-frame'
  }
  return 'text'
}

/** 同一模式同时决定提示词的参考编号和发送给供应商的图片角色。 */
export function videoPromptInput(provider, model, references, audioReferences = []) {
  const kind = videoInputMode(provider, model)
  const frame = references.find((ref) => ref.type === '分镜参考')
  if (!references.length)
    return { mode: audioReferences.length ? 'references' : 'text', firstFrame: null, subjects: [] }
  if (
    ['optional-frame', 'required-frame'].includes(kind) ||
    (['wan-multi', 'h3'].includes(kind) && frame && references.length === 1 && !audioReferences.length)
  )
    return { mode: 'first-frame', firstFrame: frame, subjects: [] }
  const separateFrame = kind === 'wan-subjects' && frame && references.length > 1
  return {
    mode: 'references',
    firstFrame: separateFrame ? frame : null,
    subjects: separateFrame ? references.filter((ref) => ref !== frame) : references
  }
}

/** 时长选择在手动表单和后台生成中使用同一组供应商限制。 */
export function videoDurations(provider, model) {
  if (provider === 'vllm-h3') return Array.from({ length: 12 }, (_, i) => i + 4)
  if (provider === 'minimax-video') {
    if (!isMiniMaxH3(model)) return [6, 10]
    const start = /-max$/i.test(model) ? 5 : 4
    return Array.from({ length: 16 - start }, (_, i) => start + i)
  }
  return Array.from(
    { length: provider === 'aliyun-video' && videoInputMode(provider, model) === 'wan-multi' ? 29 : 14 },
    (_, i) => i + 2
  )
}

/** 旧视频型号仍可制作普通有声镜头，只有实际支持的型号收到样音。 */
export function supportsReferenceAudio(provider, model) {
  return ['wan-multi', 'h3'].includes(videoInputMode(provider, model))
}

/** 提交前核对每一张已选的图片是否都会发送，容量与接口模式保持一致。 */
export function validateVideoInputs(provider, model, references = [], audioReferences = []) {
  const mode = videoInputMode(provider, model)
  const count = references.length
  let message, code
  const audioLimit = mode === 'h3' ? 3 : 5
  if (audioReferences.length && !count && mode === 'h3') {
    code = 'audio_reference_image'
    message = 'H3 的角色样音需要搭配至少一张参考图，请绑定角色图或分镜底图。'
  } else if (
    audioReferences.length > audioLimit ||
    audioReferences.reduce((total, ref) => total + Math.round(ref.duration * 1000), 0) > 15000 ||
    (provider === 'vllm-h3' && count + audioReferences.length > 12)
  ) {
    code = 'audio_reference_limit'
    message =
      '角色样音超出当前模型的容量（最多 ' + audioLimit + ' 段，合计最多 15 秒）。请缩短样音或拆分镜头。'
  } else if (mode === 'remote-only') {
    code = 'reference_upload'
    message = '该型号要求远程素材。请改用可接收本地参考图的视频模型。'
  } else if (!count && ['required-frame', 'wan-subjects'].includes(mode)) {
    code = 'reference_missing'
    message = '该模型需要参考图。请设置分镜首帧，或为无资产镜头选择支持纯文字的视频模型。'
  } else if (count && mode === 'text') {
    code = 'reference_unsupported'
    message = '当前视频适配器无法向该型号提交参考图。请在模型配置中选择可接收本镜全部图片的视频模型。'
  } else {
    let limit
    if (mode === 'h3') limit = 9
    if (mode === 'wan-multi') limit = 10
    if (mode === 'wan-subjects') limit = references.some((r) => r.type === '分镜参考') ? 6 : 5
    if (mode === 'optional-frame' || mode === 'required-frame') limit = 1
    if (count > limit) {
      code = 'reference_limit'
      message =
        '本镜有 ' +
        count +
        ' 张参考图，超过当前型号可接收的 ' +
        limit +
        ' 张。请选用可容纳全部图片的视频模型。'
    } else if (
      count &&
      ['optional-frame', 'required-frame'].includes(mode) &&
      references[0].type !== '分镜参考'
    ) {
      code = 'first_frame_required'
      message =
        '该型号仅接收分镜首帧，不能将角色、服饰或其他设定图作为成片首帧。请选择可提交本镜所有资产的参考生视频模型。'
    }
  }
  if (message) throw Object.assign(Error((model ? model + ' · ' : '') + message), { code })
}
