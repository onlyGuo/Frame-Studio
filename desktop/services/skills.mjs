import { parse } from 'yaml'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateCommand, providerEnvironment } from './commands.mjs'
import { readJson, localDir, localFile } from '../core/files.mjs'
import { mediaKinds, uid } from '../../shared/model.mjs'
import { profiles } from './settings.mjs'
import { probe, probeVoiceSample } from './media.mjs'
import { prepareMediaTarget, commitMediaTarget, videoTargetChanged } from '../../shared/shot-media.mjs'
import { withMediaTarget } from './media-targets.mjs'
import { resolveMentions } from '../../shared/mentions.mjs'
import { prepareVideoInput, verifyVideoFiles } from './shot-assets.mjs'
import { defaultOutfit, roleOutfit } from '../../shared/outfits.mjs'
import { formatVideoPrompt } from './video-prompt.mjs'
import { isMiniMaxH3, videoDurations, videoPromptInput } from '../core/video-inputs.mjs'

const roleReferencePrompt = fs
  .readFileSync(new URL('../../resources/prompts/role-reference.md', import.meta.url), 'utf8')
  .trim()
const h3PromptFile = 'video-prompt.json'

/** 校验声明与入口。自定义 Skill 是由用户安装的受信任本地程序。 */
function describe(dir) {
  const guide = fs.readFileSync(localFile(dir, 'SKILL.md'), 'utf8').slice(0, 30000)
  if (!fs.existsSync(path.join(dir, 'skill.json'))) {
    const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(guide)
    const metadata = block && parse(block[1])
    if (
      !metadata ||
      typeof metadata.name !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(metadata.name) ||
      typeof metadata.description !== 'string'
    )
      throw Error('SKILL.md 需要有效的 name 与 description')
    return {
      id: metadata.name,
      name:
        typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : metadata.name,
      description: metadata.description,
      kind: 'guide',
      context: metadata.context === 'always' ? 'always' : 'on-demand',
      command: null,
      guide
    }
  }
  const s = readJson(localFile(dir, 'skill.json'))
  if (
    typeof s.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(s.id) ||
    typeof s.name !== 'string' ||
    !s.name ||
    typeof s.description !== 'string' ||
    !['image', 'video', 'audio'].includes(s.kind) ||
    mediaKinds[s.extension] !== s.kind ||
    (s.maxReferenceImages !== undefined &&
      (s.kind !== 'video' || !Number.isSafeInteger(s.maxReferenceImages) || s.maxReferenceImages < 0)) ||
    (s.provider && (!Object.hasOwn(profiles, s.provider) || profiles[s.provider][1] !== s.kind))
  )
    throw Error('Skill 声明无效')
  validateCommand(s.command)
  if (s.videoPrompt !== undefined) {
    if (s.kind !== 'video' || typeof s.videoPrompt !== 'string') throw Error('视频提示词规则声明无效')
    localFile(dir, s.videoPrompt)
  }
  for (const arg of s.command.args) if (arg.startsWith('{skill}/')) localFile(dir, arg.slice(8))
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    provider: s.provider,
    kind: s.kind,
    extension: s.extension,
    ...(s.kind === 'video' ? { maxReferenceImages: s.maxReferenceImages ?? 0 } : {}),
    command: s.command,
    ...(s.videoPrompt ? { videoPrompt: s.videoPrompt } : {}),
    guide
  }
}
/** 展开稳定占位符，按分镜参考、场景和角色等引用收集本机已登记图片。 */
function generationInput(project, target, input, skill, model) {
  const doc = project.data
  const shot =
    target.newShot ||
    doc.episodes.find((e) => e.id === target.episodeId)?.shots.find((s) => s.id === target.shotId)
  const card = doc.cards.find((c) => c.id === target.cardId)
  const requested = input.duration ?? shot?.duration ?? 5
  let duration = requested
  if (skill.builtin && skill.kind === 'video' && (skill.provider !== 'minimax-video' || isMiniMaxH3(model))) {
    const allowed = videoDurations(skill.provider, model)
    if (input.duration == null)
      duration = Math.max(allowed[0], Math.min(allowed.at(-1), Math.round(requested)))
    else if (!allowed.includes(duration)) throw Error('请输入所选视频模型支持的整数秒数')
  } else if (skill.provider === 'minimax-video' && input.duration == null) duration = requested > 6 ? 10 : 6
  const generation =
    skill.kind === 'video'
      ? prepareVideoInput(project, target, input, { ...skill, model, custom: !skill.builtin })
      : skill.provider === 'minimax-speech'
        ? speechInput(card, input)
        : imageInput(project, shot, card, target, input)
  if (generation.prompt.length > 30000) throw Error('生成提示词（含控制说明）超过 30000 字')
  return { ratio: doc.ratio, duration, ...generation }
}

/** 样音请求只发送此角色的音色描述和独立试听文本。 */
function speechInput(card, input) {
  const prompt = (input.prompt?.trim() || card?.notes?.trim() || '').slice(0, 1000)
  const sampleText = input.sampleText?.trim() || '我在这儿等你，慢慢走，别着急。'
  const voiceId = input.voiceId?.trim() || ''
  if (!prompt && !voiceId) throw Error('请描述需要的声音，或输入 MiniMax 音色 ID')
  if (sampleText.length > 500 || voiceId.length > 256) throw Error('试听台词或音色 ID 过长')
  return { prompt, sampleText, voiceId }
}

/** 角色参考图是一套服饰的五视图设定页；分镜底图只使用其画面和实际引用。 */
function imageInput(project, shot, card, target, input) {
  const { cards, assets } = project.data
  const outfit = roleOutfit(card, target.outfitId)
  const identity = outfit && outfit.id !== defaultOutfit(card) ? roleOutfit(card) : undefined
  const source = outfit
    ? [card.name, card.notes, '服饰：' + outfit.name, outfit.notes, input.prompt].filter(Boolean).join('\n')
    : [shot?.prompt, input.prompt].filter((v, i, all) => v?.trim() && all.indexOf(v) === i).join('\n') ||
      [card?.name, card?.notes].filter(Boolean).join(' ')
  if (!source.trim()) throw Error('请填写生成提示词或目标分镜的脚本')
  const resolved = resolveMentions(source, cards, { includeNotes: !shot, labelOutfits: true })
  const references = new Map()
  const add = (assetId, type, name, cardId) => {
    const asset = assets.find((item) => item.id === assetId && item.kind === 'image')
    if (asset)
      references.set(asset.id, { type, name, cardId, assetId: asset.id, path: project.assetPath(asset) })
  }
  for (const c of resolved.cards)
    add(c.assetId, c.type, c.outfitName ? c.name + ' · ' + c.outfitName : c.name, c.id)
  if (identity?.assetId) add(identity.assetId, '角色身份参考', card.name, card.id)
  const prompt = outfit ? resolved.text + '\n\n' + roleReferencePrompt : resolved.text
  return { prompt, references: [...references.values()], ...(outfit ? { ratio: '16:9' } : {}) }
}

/** 发现并管理内置能力与用户安装的扩展。 */
export class Skills {
  constructor(settings, source, commands, { formatVideo = formatVideoPrompt } = {}) {
    this.settings = settings
    this.commands = commands
    this.formatVideo = formatVideo
    const base = localDir(settings.root, 'skills')
    this.builtin = localDir(base, 'builtin')
    this.custom = localDir(base, 'custom')
    fs.cpSync(source, this.builtin, { recursive: true, force: true })
  }
  /** 从本地目录读取最新能力声明和启用状态。 */
  list() {
    return [this.builtin, this.custom].flatMap((root) =>
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^[a-z]/.test(d.name))
        .map((d) => {
          const item = describe(localDir(root, d.name))
          if (item.id !== d.name) throw Error('Skill 目录与 ID 不一致')
          return {
            ...item,
            builtin: root === this.builtin,
            ...(root === this.builtin && item.id === 'vllm-h3' ? { videoPrompt: h3PromptFile } : {}),
            enabled: !this.settings.data.disabled.includes(item.id)
          }
        })
    )
  }
  /** 解析已启用扩展的资源目录，终端可以用 {skill} 调用扩展随附的本地脚本。 */
  enabledDirectory(id) {
    const item = this.list().find((skill) => skill.id === id && skill.enabled)
    if (!item) throw Error('找不到已启用的 Skill，请读取当前能力列表')
    return localDir(item.builtin ? this.builtin : this.custom, item.id)
  }
  /** 仅向助手公开可使用的能力、模型名和默认标记。URL 与凭据保持在主进程。 */
  catalog() {
    const available = this.list().filter((s) => s.enabled && (!s.provider || this.settings.ready(s.provider)))
    return available.map(({ id, name, description, kind, provider, builtin, maxReferenceImages }) => ({
      id,
      name,
      description,
      kind,
      builtin,
      ...(kind === 'video' && !builtin ? { maxReferenceImages } : {}),
      ...(provider ? { provider, model: this.settings.data.profiles[provider].model } : {}),
      preferred: Boolean(builtin && provider && this.settings.defaultMedia(kind) === provider)
    }))
  }
  /** 缺少明确目标时只执行唯一候选或已选默认服务，不逐个试运行。 */
  resolveMedia(kind, id) {
    const catalog = this.catalog().filter((s) => s.kind !== 'guide')
    if (id) {
      const skill = catalog.find((s) => s.id === id && (!kind || s.kind === kind))
      if (!skill) throw Error('指定的媒体能力未就绪，请使用已配置的默认媒体类型')
      return skill
    }
    if (!['image', 'video', 'audio'].includes(kind)) throw Error('请选择 image、video 或 audio 类型')
    const candidates = catalog.filter((s) => s.kind === kind)
    const preferred = candidates.find((s) => s.preferred)
    if (preferred) return preferred
    if (this.settings.defaultMedia(kind))
      throw Error('默认媒体服务的 Skill 未启用，请在 Skill 管理中启用或调整默认模型')
    if (candidates.length === 1) return candidates[0]
    if (candidates.length === 0) throw Error('当前没有可用的该类媒体能力，请配置模型并启用对应 Skill')
    throw Error('有多个可用的媒体能力，请在模型配置中选择默认服务，或由创作者指定 Skill')
  }
  /** 在临时目录验证完整扩展包后发布。 */
  install(source) {
    const item = describe(source)
    if (this.list().some((s) => s.id === item.id)) throw Error('同名 Skill 已存在')
    const stage = path.join(this.custom, '.install-' + uid())
    try {
      fs.cpSync(source, stage, {
        recursive: true,
        filter: (file) => {
          if (fs.lstatSync(file).isSymbolicLink()) throw Error('Skill 包不能包含符号链接')
          return true
        }
      })
      describe(stage)
      fs.renameSync(stage, path.join(this.custom, item.id))
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
    }
  }
  /** 启停能力或卸载自定义扩展。 */
  manage(id, action) {
    const s = this.list().find((s) => s.id === id)
    if (!s) throw Error('Skill 不存在')
    if (action === 'remove') {
      if (s.builtin) throw Error('内置 Skill 只读')
      fs.rmSync(localDir(this.custom, id), { recursive: true })
    } else if (!['enable', 'disable'].includes(action)) throw Error('未知操作')
    this.settings.data.disabled = this.settings.data.disabled.filter((value) => value !== id)
    if (action === 'disable') this.settings.data.disabled.push(id)
    this.settings.save()
  }
  /** 返回生成的原始素材列表，保留命令式调用的接口。 */
  async run(project, id, input, signal) {
    return (await this.generate(project, id, input, signal)).assets
  }
  /** 先确认分镜、设定与引用，再执行 Skill；最终将素材和目标绑定一起写入工程。 */
  async generate(project, id, input, signal) {
    const s = this.list().find((s) => s.id === id && s.enabled)
    if (!s?.command) throw Error('请选择可用的媒体 Skill')
    const target = prepareMediaTarget(project.data, s.kind, input)
    return withMediaTarget(project, target, () => this.runTarget(project, s, input, target, signal))
  }
  /** 批量生成在首个镜头付费前检查整份待制作清单，执行时仍按实时工程复核。 */
  preflightVideo(project, selected, input) {
    const target = prepareMediaTarget(project.data, 'video', input)
    const spec = prepareVideoInput(project, target, input, { ...selected, custom: !selected.builtin })
    return [...spec.references, ...(spec.audioReferences || [])]
  }
  /** 在独占目标上执行命令并返回已提交的绑定回执。 */
  async runTarget(project, s, input, target, signal) {
    const { id } = s
    const env = providerEnvironment(this.settings, s.provider)
    const spec = generationInput(project, target, input, s, env.STUDIO_MODEL)
    const skillDir = path.join(s.builtin ? this.builtin : this.custom, id)
    if (s.kind === 'video')
      await verifyVideoFiles([...spec.references, ...(spec.audioReferences || [])], signal)
    if (s.kind === 'video' && s.videoPrompt) {
      try {
        const promptDir =
          s.provider === 'vllm-h3' && s.builtin ? path.join(this.builtin, 'minimax-video') : skillDir
        spec.prompt = await this.formatVideo(this.settings, s, promptDir, spec, signal, env.STUDIO_MODEL)
      } catch (error) {
        signal?.throwIfAborted()
        throw Error('整理视频提示词失败：' + this.settings.redactor()(error.message))
      }
    }
    signal?.throwIfAborted()
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-skill-'))
    try {
      const output = path.join(dir, 'result' + s.extension)
      const expand = (value) => value.replaceAll('{skill}', skillDir).replaceAll('{output}', output)
      const command = { executable: expand(s.command.executable), args: s.command.args.map(expand) }
      const { visual, dialogue, ...payload } = spec
      if (s.provider === 'vllm-h3' || (s.provider === 'minimax-video' && isMiniMaxH3(env.STUDIO_MODEL)))
        payload.inputMode = videoPromptInput(
          s.provider,
          env.STUDIO_MODEL,
          spec.references,
          spec.audioReferences
        ).mode
      payload.output = output
      if (videoTargetChanged(project.data, target))
        throw Error('分镜或出场资产刚刚更改，请核对最新版本再生成。')
      const result = await this.commands.run(command, {
        cwd: dir,
        env: { ...env, STUDIO_OUTPUT: output },
        input: JSON.stringify(payload),
        signal,
        capture: false
      })
      if (result.code) {
        const label = s.name + (env.STUDIO_MODEL ? '（' + env.STUDIO_MODEL + '）' : '')
        throw Error(label + '：' + failureReason(dir, output, s.builtin, result.code))
      }
      let binding
      const assets = await project.addMedia(
        [localFile(dir, path.basename(output))],
        s.kind === 'audio' && target.cardId ? (file) => probeVoiceSample(file, signal) : probe,
        (
          project.data.episodes
            .find((e) => e.id === target.episodeId)
            ?.shots.find((s) => s.id === target.shotId)?.title ||
          target.newShot?.title ||
          project.data.cards.find((c) => c.id === target.cardId)?.name ||
          input.prompt ||
          spec.prompt
        ).slice(0, 50),
        (draft, [asset]) => {
          binding = commitMediaTarget(draft, asset, target)
        }
      )
      return { assets, ...binding }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
}

/** 解码内置服务的有限错误字段；任何其他子进程输出均不进入模型上下文。 */
function failureReason(dir, output, builtin, code) {
  if (builtin && fs.existsSync(output + '.diagnostic')) {
    const info = readJson(localFile(dir, path.basename(output) + '.diagnostic'))
    const stage = { submit: '提交请求', poll: '查询任务', download: '下载产物' }[info.stage]
    if (stage) {
      if (info.reason === 'reference_missing') return '该模型需要参考图，请绑定分镜底图或引用带图的设定卡'
      if (info.reason === 'reference_limit')
        return '参考图超过该模型支持的张数，请选择能接收本镜全部参考图的视频模型'
      if (info.reason === 'reference_unsupported')
        return '当前型号无法提交参考图，请选择支持本镜全部参考图的视频模型'
      if (info.reason === 'reference_format')
        return '参考图的格式、文件大小、分辨率或长宽比超出所选模型的限制'
      if (info.reason === 'reference_upload')
        return '万相 2.6 R2V 要求已上传的公网或 OSS 素材，请选用支持本地图片的 2.7 R2V 或 3.0'
      if (info.reason === 'voice_upload') return '无法上传角色样音到百炼临时存储，请核对模型和地域配置'
      if (info.reason === 'duration') return '请输入所选视频模型支持的整数秒数'
      if (info.reason === 'http' && Number.isInteger(info.status) && info.status >= 300 && info.status <= 599)
        return stage + '返回 HTTP ' + info.status
      if (info.reason === 'format') return stage + '成功，但响应中缺少生成的媒体'
      if (info.reason === 'task') return '供应商未完成生成任务'
      if (info.reason === 'timeout') return stage + '超时'
      if (info.reason === 'network') return stage + '无法连接到服务'
    }
  }
  return 'Skill 执行失败（退出码 ' + code + '），请检查配置及输入参数'
}
