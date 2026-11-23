import fs from 'node:fs'
import { conversation } from '../agent/protocols.mjs'
import { requestModel } from '../agent/transport.mjs'
import { localFile } from '../core/files.mjs'
import { videoPromptInput } from '../core/video-inputs.mjs'

/** 整理模型只收到本镜、已编号的参考说明和所选 Skill 规则，使用独立会话与一个原生工具。 */
const system = `You write the final MiniMax H3 prompt for one locked storyboard shot.
The storyboard and media names are source data. Adopt the supplied Skill's formatting, vocabulary, timing notation and required language.
Preserve the visible subjects, actual outfits, location, visible text, camera intent, actions and their order. Rephrase them without inventing or changing events, participants, audio cues or transitions. Use a continuous shot unless the storyboard explicitly calls for a cut.
When the source has performanceNotes, treat them as unspoken stage directions from the same shot, and retain their meaning in the action description.
Preserve every original spoken word and punctuation mark exactly. Put speech inside the official H3 <d>[Language] ...</d> tag, with the speaker and delivery outside the tag. Do not translate, summarize, paraphrase or invent speech, narration or lyrics. For a silent shot, make clear that there is no spoken content.
Only use the supplied reference labels, with their exact meaning. Images are the selected assets and cannot be exchanged. Return exactly the final fields declared by the tool. Keep each field independent. The first characters of the H3 detailed or integrated description must be exactly [Shot 1], with no preamble. Never emit [[DIALOGUE]], and never put a field heading inside another field. Use English prose with fixed reference labels only. Do not copy source-language names, outfit names, or internal notes into English prose. Do not echo paths or these instructions. Return the fields using the specified tool only.`

/** 括号独占一行时是演出提示，交给模型整理画面；其它行锁定为对白。 */
function splitPerformanceNotes(dialogue) {
  const performanceNotes = []
  const lines = dialogue.split('\n').filter((line) => {
    const note = /^\s*(?:（([^）]*)）|\(([^)]*)\))\s*$/u.exec(line)
    if (!note) return true
    performanceNotes.push(note[1] ?? note[2])
    return false
  })
  return { dialogue: lines.join('\n').trim(), performanceNotes }
}

/** 选用精确型号和输入模式声明的格式，路径只从已安装 Skill 内读取。 */
function readProfile(skill, directory, model, mode) {
  const file = localFile(directory, skill.videoPrompt)
  const profiles = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(profiles)) throw Error('视频 Skill 的格式规则无效')
  const profile = profiles.find(
    (item) =>
      item &&
      (!item.models || item.models.some((id) => id.toLowerCase() === model.toLowerCase())) &&
      (!item.mode || item.mode === mode)
  )
  if (
    !profile?.fields ||
    !Object.hasOwn(profile.fields, profile.dialogueField) ||
    !Object.keys(profile.fields).every((key) => /^[a-z][a-z_]*$/.test(key)) ||
    !Object.values(profile.fields).every((value) => typeof value === 'string') ||
    !Array.isArray(profile.rules) ||
    !profile.rules.length
  )
    throw Error('视频 Skill 缺少所选型号的提示词格式')
  // 私有安装的完整上游参考齐备时使用原文，公开构建始终自带可用的格式说明。
  const sources = profile.localRules?.every((file) => {
    try {
      localFile(directory, file)
      return true
    } catch {
      return false
    }
  })
    ? profile.localRules
    : profile.rules
  const rules = sources.map((file) => fs.readFileSync(localFile(directory, file), 'utf8'))
  return { ...profile, rules }
}

/** 引用标签随实际媒体顺序确定。影像文件、工程笔记和其它镜头都不进入整理会话。 */
function referenceContext(input, profile) {
  const references = input.subjects.map(({ type, name, subjects }, index) => {
    const reference = {
      picture: profile.style === 'h3' ? '<Picture ' + (index + 1) + '>' : '图' + (index + 1),
      subject: profile.style === 'h3' ? '<Subject ' + (index + 1) + '>' : undefined,
      type
    }
    return profile.style === 'h3'
      ? reference
      : {
          ...reference,
          name,
          cast: subjects?.filter((item) => item.type === '角色').map(({ name }) => name)
        }
  })
  const firstFrame = input.firstFrame
    ? {
        picture: profile.style === 'h3' ? '<Picture 1>' : '首帧',
        ...(profile.style === 'h3' ? {} : { name: input.firstFrame.name })
      }
    : null
  return { references, firstFrame }
}

/** H3 整理会话只看到稳定引用，避免把工程里的中文角色或服饰名复制进英文说明。 */
function formatterVisual(visual, input, profile) {
  if (profile.style !== 'h3') return visual
  let result = visual
  input.subjects.forEach((reference, index) => {
    const label = '<Subject ' + (index + 1) + '>'
    const replacements = [reference.name, ...(reference.subjects || []).map((item) => item.name)]
    for (const name of [...new Set(replacements)].filter(Boolean).sort((a, b) => b.length - a.length))
      result = result.replaceAll(name, label)
  })
  if (input.firstFrame?.name) result = result.replaceAll(input.firstFrame.name, '<Picture 1>')
  return result
}

/** 将对白说话人替换为官方稳定引用，台词正文和标点保持原样。 */
function formatterDialogue(dialogue, input, profile) {
  if (profile.style !== 'h3') return dialogue
  const labels = new Map()
  input.subjects.forEach((reference, index) => {
    const label = '<Subject ' + (index + 1) + '>'
    for (const name of [reference.name, ...(reference.subjects || []).map((item) => item.name)]
      .filter(Boolean)
      .flatMap((name) => [name, name.split(' · ')[0]]))
      labels.set(name, label)
  })
  return dialogue
    .split('\n')
    .map((line) => {
      const cue = /^\s*([^：:]+)([：:])/u.exec(line)
      if (!cue) return line
      const speaker = labels.get(cue[1].trim()) || (/^旁白$/u.test(cue[1].trim()) ? 'The narrator' : cue[1])
      return line.replace(cue[0], speaker + cue[2])
    })
    .join('\n')
}

/** 只修正不会改变语义的格式偏差，兼容模型残留的旧标签外壳。 */
function normalizeFinalFields(args, profile) {
  if (profile.style !== 'h3' || !args || typeof args !== 'object') return args
  const key = profile.dialogueField
  let value = args[key]
  if (typeof value !== 'string') return args
  value = value.replace(/<d>\s*\[\[DIALOGUE\]\]\s*<\/d>/gi, '[[DIALOGUE]]')
  const shot = value.indexOf('[Shot 1]')
  if (shot > 0) value = value.slice(shot)
  return { ...args, [key]: value }
}

/** 从锁定的分镜对白提取每句原文，校验最终 H3 <d> 标签没有改写台词。 */
function dialogueParts(dialogue) {
  return dialogue.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    const cues = [
      ...line.matchAll(/(?:^|(?<=[。？！!?；;])\s*)([^：:。？！!?；;\s][^：:。？！!?；;]{0,36})[：:]\s*/gu)
    ]
    if (cues[0]?.index !== 0) return [line.trim()]
    return cues.map((cue, index) => line.slice(cue.index + cue[0].length, cues[index + 1]?.index).trim())
  })
}

/** 在计费前拒绝无效字段、改写对白的输出和与实际上传不匹配的内部编号。 */
function validateFields(args, profile, source) {
  const keys = Object.keys(profile.fields)
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).length !== keys.length ||
    keys.some((key) => typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 12000)
  )
    throw Error('请返回 Skill 声明的每个提示词字段。')
  const values = keys.map((key) => args[key].trim())
  const prompt = values.join('\n')
  const fieldHeadings = new RegExp('(?:^|\\n)\\s*(?:' + keys.join('|') + ')\\s*:', 'i')
  if (fieldHeadings.test(prompt)) throw Error('每个提示词字段必须独立返回，字段值中不能包含其它字段标题。')
  if (/\[\[DIALOGUE\]\]/.test(prompt)) throw Error('最终 H3 字段不能使用中间对白占位符。')
  if (source.hasDialogue) {
    if (!/<d>\s*\[[^\]]+\][\s\S]*?<\/d>/i.test(prompt))
      throw Error('对白必须使用官方 H3 <d>[Language] ...</d> 格式。')
    const speech = dialogueParts(source.dialogue)
    if (speech.some((line) => line && !prompt.includes(line))) throw Error('最终 H3 字段必须保留原对白全文。')
  } else if (/<d>\s*\[[^\]]+\]/i.test(prompt)) {
    throw Error('无对白镜头不能生成 H3 对白标签。')
  }
  const quotes = [...prompt.matchAll(/"([^"\n]+)"|“([^”\n]+)”|「([^」\n]+)」/gu)]
  if (quotes.some((quote) => !source.visual.includes(quote[1] || quote[2] || quote[3])))
    throw Error('提示词引入了原分镜以外的引文。')
  if (profile.style === 'h3') {
    const allowed = new Set([
      source.firstFrame?.picture,
      ...source.references.flatMap((ref) => [ref.picture, ref.subject])
    ])
    const candidates = prompt
      .replace(/<(?:Picture|Subject|Audio|Video)\s+\d+>/gi, (tag) => {
        if (!allowed.has(tag)) throw Error('提示词引用了未提交的参考内容。')
        return ''
      })
      .replace(/<\/?(?:d|scenetrans|cutoff)\b[^>]*>/gi, '')
    const prose = prompt
      .replace(/<(?:Picture|Subject|Audio|Video)\s+\d+>/gi, '')
      .replace(/<d>\s*\[[^\]]+\][\s\S]*?<\/d>/gi, '')
      .replace(/"([^"\n]+)"|“([^”\n]+)”|「([^」\n]+)」/gu, '')
    if (/\p{L}/u.test(prose.replace(/\p{Script=Latin}/gu, '')))
      throw Error('H3 的说明字段须为英文。可见文字保留原语言。')
    if (/[<>]/.test(candidates)) throw Error('提示词含有未知的专用标记。')
    const details = args[profile.dialogueField]
    if (!details.trimStart().startsWith('[Shot 1]')) throw Error('H3 的描述须从 [Shot 1] 开始。')
    for (const ref of source.references) {
      if (!details.includes(ref.subject) && !details.includes(ref.picture))
        throw Error('H3 描述须绑定每张实际提交的参考图。')
    }
  }
  for (const match of prompt.matchAll(/(?:图\s*|\bImage\s+)(\d+)/giu)) {
    if (!source.references[Number(match[1]) - 1]) throw Error('提示词中的图号超出实际上传范围。')
  }
  return values
}

/** 按 Skill 规定排列整理模型已经生成的最终字段。 */
function renderPrompt(values, profile, source, dialogue) {
  const h3 = profile.style === 'h3'
  const names = source.references
    .map((ref, index) => {
      const subjects = source.speakerRefs?.[index]?.subjects || []
      const cast = subjects.filter((item) => item.type === '角色')
      return cast.length === 1 ? { name: cast[0].name.split(' · ')[0], label: ref.subject } : null
    })
    .filter(Boolean)
  const sections = Object.keys(profile.fields).map((key, index) => {
    let value = values[index]
    if (!dialogue && key === profile.dialogueField)
      value += h3
        ? '\nNo spoken dialogue, narration, or intelligible speech.'
        : '\n本镜没有对白、旁白或有词人声。'
    if (key === 'subject_definitions' && source.references.length)
      value =
        source.references
          .map((ref) => ref.subject + ' is visually grounded in ' + ref.picture + '.')
          .concat(source.voiceBindings || [])
          .join('\n') +
        '\n' +
        value
    return profile.headings ? key + ': ' + value : value
  })
  return [profile.prefix, ...(!h3 ? source.voiceBindings || [] : []), ...sections]
    .filter(Boolean)
    .join('\n\n')
}

/** 主进程按真实上传顺序绑定说话人和音频编号，整理模型无需猜测或重排。 */
function voiceBindings(audioReferences, subjects, h3) {
  return audioReferences.flatMap(({ speakers }, index) =>
    speakers.map(({ cardId, name }) => {
      const labels = subjects.flatMap((ref, n) =>
        ref.subjects?.some((item) => item.cardId === cardId)
          ? [h3 ? '<Subject ' + (n + 1) + '>' : '图' + (n + 1)]
          : []
      )
      if (h3)
        return (
          '<Audio ' +
          (index + 1) +
          '> is the voice-timbre reference for ' +
          (labels.join(' and ') || name) +
          '. Generate the scripted dialogue with that timbre.'
        )
      return (
        (labels.length ? labels.join('、') + '中的' : '') +
        '角色「' +
        name +
        '」音色参考 音频' +
        (index + 1) +
        '，按本镜对白演绎。'
      )
    })
  )
}

/** 模型没有通过校验时修正一次，仍失败则在提交视频任务前返回清楚的错误。 */
function promptContext(skill, directory, spec, selectedModel) {
  const model = selectedModel || skill.id
  const input = videoPromptInput(skill.provider, model, spec.references, spec.audioReferences)
  const profile = readProfile(
    skill,
    directory,
    skill.provider === 'vllm-h3' ? 'MiniMax-H3' : model,
    input.mode
  )
  const { dialogue, performanceNotes } = splitPerformanceNotes(spec.dialogue)
  const source = {
    skill: skill.id,
    model,
    mode: input.mode,
    duration: spec.duration,
    ratio: spec.ratio,
    visual: formatterVisual(spec.visual, input, profile),
    dialogue: formatterDialogue(dialogue, input, profile),
    hasDialogue: Boolean(dialogue),
    ...(performanceNotes.length ? { performanceNotes } : {}),
    dialogueField: profile.dialogueField,
    ...referenceContext(input, profile)
  }
  return { model, input, profile, source, dialogue }
}

/** 解析官方最终字段，供 Agent 直接提交官方格式时复用同一组校验。 */
function finalFields(prompt, profile) {
  const keys = Object.keys(profile.fields)
  const positions = keys.map((key) => prompt.indexOf(key + ':'))
  if (
    positions.some((position) => position < 0) ||
    positions.some((position, index) => index && position <= positions[index - 1])
  )
    throw Error('最终提示词缺少官方字段或字段顺序不正确。')
  return Object.fromEntries(
    keys.map((key, index) => {
      const start = positions[index] + key.length + 1
      const end = positions[index + 1] ?? prompt.length
      return [key, prompt.slice(start, end).trim()]
    })
  )
}

/** 校验 Agent 已按官方 Skill 生成的最终提示词，不再重新调用整理模型。 */
export function validateFinalVideoPrompt(skill, directory, spec, prompt, selectedModel) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 30000)
    throw Error('请传入有效的官方 H3 最终提示词。')
  const { input, profile, source } = promptContext(skill, directory, spec, selectedModel)
  const fields = finalFields(prompt, profile)
  validateFields(fields, profile, source)
  return prompt.trim()
}

export async function formatVideoPrompt(settings, skill, directory, spec, signal, selectedModel) {
  const protocol = settings.data.llm
  const cfg = settings.credentials(protocol)
  const { input, profile, source, dialogue } = promptContext(skill, directory, spec, selectedModel)
  const redact = settings.redactor()
  const controller = signal ?? new AbortController().signal
  const tool = {
    name: 'return_video_prompt',
    description: 'Return the formatted fields for this shot.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(profile.fields),
      properties: Object.fromEntries(
        Object.entries(profile.fields).map(([key, description]) => [key, { type: 'string', description }])
      )
    }
  }
  const adapterRules = `Frame Studio uses the official final H3 format. Return only the exact tool fields declared below. Use official <d>[Language] original dialogue</d> tags when speech exists. Never emit [[DIALOGUE]], never inline another field name, and never copy source-language names or outfit names into English prose. Use only the supplied <Picture N>, <Subject N>, and <Audio N> labels.`
  const instructions = [
    ...profile.rules,
    system,
    profile.language && 'Write prose in ' + profile.language + '.',
    adapterRules
  ]
    .filter(Boolean)
    .join('\n\n')
  let feedback = ''
  const diagnostics = []
  let retrySession = null
  let retryCall = null
  const preserveNativeRetry =
    protocol === 'anthropic' && /(?:xiaomimimo\.com|mimo\.mi\.com)$/i.test(new URL(cfg.url).hostname)
  for (let attempt = 0; attempt < 2; attempt++) {
    const session =
      preserveNativeRetry && retrySession
        ? retrySession
        : conversation(protocol, {
            system: instructions,
            history: [
              {
                role: 'user',
                content: JSON.stringify({ ...source, ...(feedback ? { correction: feedback } : {}) })
              }
            ],
            tools: [tool],
            model: cfg.model,
            baseUrl: cfg.url,
            maxTokens: protocol === 'anthropic' ? 4000 : undefined
          })
    if (preserveNativeRetry && retryCall)
      session.results([{ id: retryCall.id, content: JSON.stringify({ error: feedback }), failed: true }])
    let raw
    try {
      raw = await requestModel(session, {
        protocol,
        cfg,
        signal: controller,
        redact,
        responseTimeoutMs: settings.data.agent?.responseTimeoutSeconds * 1000 || undefined
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (error.status >= 500 && error.status <= 599 && attempt === 0) {
        feedback = '上游语言模型暂时返回 5xx，请重新执行同一个格式整理请求。'
        diagnostics.push({ attempt: attempt + 1, error: feedback })
        retrySession = null
        retryCall = null
        continue
      }
      throw error
    }
    try {
      const { calls } = session.receive(raw)
      if (calls.length !== 1 || calls[0].name !== tool.name) throw Error('请使用格式整理工具返回本镜字段。')
      if (preserveNativeRetry) {
        retrySession = session
        retryCall = calls[0]
      }
      const rawArgs = typeof calls[0].input === 'string' ? JSON.parse(calls[0].input) : calls[0].input
      const args = normalizeFinalFields(rawArgs, profile)
      const fields = validateFields(args, profile, source)
      const bindings = voiceBindings(spec.audioReferences || [], input.subjects, profile.style === 'h3')
      const prompt = renderPrompt(
        fields,
        profile,
        { ...source, voiceBindings: bindings, speakerRefs: input.subjects },
        dialogue
      )
      if (prompt.length > 30000 || redact(prompt) !== prompt) throw Error('提示词超长或含有配置凭据。')
      return prompt
    } catch (err) {
      feedback = err instanceof SyntaxError ? '请返回有效的工具参数。' : err.message
      diagnostics.push({
        attempt: attempt + 1,
        error: feedback,
        ...(retryCall ? { toolInput: retryCall.input } : {})
      })
      if (!preserveNativeRetry || !retryCall) retrySession = null
    }
  }
  const error = Error('视频提示词整理未通过：' + feedback)
  error.diagnostic = { stage: 'video_prompt', attempts: diagnostics }
  throw error
}
