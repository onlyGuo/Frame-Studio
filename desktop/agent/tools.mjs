import { applyPlan, planFields } from '../../shared/plan.mjs'
import { roughCut } from '../../shared/rough-cut.mjs'
import { mentionToken } from '../../shared/mentions.mjs'
import { prepareMediaTarget } from '../../shared/shot-media.mjs'
import { defaultOutfit, roleOutfits, settingImage } from '../../shared/outfits.mjs'
import { skillFiles } from '../core/skill-files.mjs'
import { localFile } from '../core/files.mjs'
import fs from 'node:fs'
import { runCommandGroup, runLegacyCommand } from '../services/command-group.mjs'
import { decodeReferenceImage } from '../services/media.mjs'
import { hasProjectImage, inspectProjectShotAssets, verifyVideoFiles } from '../services/shot-assets.mjs'
import { shotVoiceReferences } from '../../shared/shot-assets.mjs'
import { supportsReferenceAudio } from '../core/video-inputs.mjs'
const string = { type: 'string' },
  num = { type: 'number' }
const mediaKind = { type: 'string', enum: ['image', 'video', 'audio'] }
/** 生成和通用命令使用相同的工程归属参数。 */
const mediaTarget = {
  episodeId: string,
  shotId: string,
  cardId: string,
  outfitId: { type: 'string', description: '角色参考图的服饰 ID。省略时使用角色的默认服饰。' },
  destination: { type: 'string', enum: ['shot', 'newShot', 'library'] },
  shotTitle: string,
  assetFree: {
    type: 'boolean',
    description: '创建新镜头或独立视频时，确认画面无需任何角色、场景或道具。已有镜头通过 edit_project 确认。'
  }
}
const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const action = object(
  {
    op: { enum: ['add', 'update', 'remove', 'move'], type: 'string' },
    target: { enum: Object.keys(planFields), type: 'string' },
    id: string,
    episodeId: string,
    index: { type: 'integer' },
    fields: { type: 'object', additionalProperties: true }
  },
  ['op', 'target']
)
/** 同一命令组可包含本地程序、脚本以及已注册 Skill 的可执行入口。 */
const commandStep = object({
  executable: string,
  fromSkill: {
    type: 'string',
    description:
      '以已启用的 Skill 为脚本来源。参数中的 {skill} 展开为其本机目录，程序也可读 STUDIO_SKILL_DIR。'
  },
  args: { type: 'array', items: string },
  script: object({ path: string, content: string, overwrite: { type: 'boolean' } }, ['path', 'content']),
  applyEdits: { type: 'boolean' },
  skill: string,
  mediaKind,
  provider: string,
  extension: string,
  prompt: string,
  sampleText: { type: 'string', description: '角色样音使用的短试听台词。' },
  voiceId: { type: 'string', description: '复用指定 MiniMax Speech 音色时提供的音色 ID。' },
  duration: num,
  regenerate: { type: 'boolean' },
  ...mediaTarget
})
export const toolDefinitions = [
  {
    name: 'read_project',
    description:
      '读取工程。shot_assets 配合 shotId 检查出场卡、服饰、对应图片和视频模型。默认使用已配置的视频能力，创作者明确指定其他服务时可传 skillId。cards 返回角色默认服饰及每套服饰的图片和可插入的 mention。assets 返回用图位置。cards/assets 支持 query；assets 支持 kind。列表按 offset 分页，每页最多 50 项。',
    parameters: object(
      {
        section: {
          type: 'string',
          enum: ['overview', 'episode', 'cards', 'shots', 'shot_assets', 'assets', 'clips', 'audio']
        },
        episodeId: string,
        shotId: string,
        skillId: string,
        query: string,
        kind: mediaKind,
        offset: { type: 'integer' }
      },
      ['section']
    )
  },
  {
    name: 'edit_project',
    description:
      '原子应用创作变更。所有对象均支持 id。shots/clips/audio 需要 episodeId。新增时可指定唯一 id，用于后续调用。可编辑字段 ' +
      JSON.stringify(planFields),
    parameters: object({ actions: { type: 'array', items: action, maxItems: 200 } }, ['actions'])
  },
  {
    name: 'list_skills',
    description: '列出就绪的媒体能力、已配置的模型、默认标记和指令工作流。',
    parameters: object({})
  },
  {
    name: 'read_skill',
    description: '获取某个已启用 Skill 的使用说明和随包文件列表。可指定 file 读取包内 Markdown 或文本参考。',
    parameters: object({ id: string, file: string }, ['id'])
  },
  {
    name: 'run_command',
    description:
      '在工程 work/ 中顺序执行命令组，返回每一步的状态和输出。普通命令填写 executable 与 args；可附 script 写入相对路径的脚本，再由命令运行。STUDIO_PROJECT 是当前制作资料快照。applyEdits=true 时将 edit_project 的 actions 数组写入 STUDIO_EDITS，以事务提交。已配置的可执行 Skill 可用 skill 指定其 ID 或默认媒体类型，并同层填写输入与工程目标。自定义程序按需用 mediaKind 或 provider 取得临时服务环境；媒体产物写到 STUDIO_OUTPUT 并声明 extension。带凭据命令的标准输出保留在本机。默认首个失败后跳过后续步骤，独立任务可设置 continueOnError=true。',
    parameters: object(
      {
        commands: { type: 'array', items: commandStep, minItems: 1, maxItems: 32 },
        continueOnError: { type: 'boolean' }
      },
      ['commands']
    )
  },
  {
    name: 'rough_cut',
    description:
      '将本集已生成的视频按分镜顺序补入剪辑主轨，依据镜头时长截取并带入对白字幕。保留手工片段、裁切、字幕和音频。同一镜头重复调用不会再次添加。返回新增、已剪及待制作镜头数。',
    parameters: object({ episodeId: string })
  },
  {
    name: 'export_episode',
    description: '根据分集已保存的时间线、字幕及声音轨道导出真正的 MP4 到工程 exports 目录。',
    parameters: object({ episodeId: string }, ['episodeId'])
  }
]
/** 首次请求即带上设备实际的媒体路由，各协议共用此声明。 */
export function toolsForSession(skills) {
  const media = skills
    .catalog()
    .filter((s) => s.kind !== 'guide')
    .map(({ id, kind, provider, model, preferred }) => ({ id, kind, provider, model, preferred }))
  return toolDefinitions.map((tool) =>
    tool.name !== 'run_command'
      ? tool
      : {
          ...tool,
          description:
            tool.description +
            ' 当前就绪的 Skill 和模型 ' +
            JSON.stringify(media) +
            '。preferred=true 表示默认服务。'
        }
  )
}
/** 仅公开工程素材信息。实际图片由主进程交给生成服务。 */
function cardImage(project, assetId) {
  const image = project.data.assets.find((a) => a.id === assetId && a.kind === 'image')
  return image
    ? { id: image.id, name: image.name, ext: image.ext, available: hasProjectImage(project, image) }
    : null
}
/** 补图时复用实际可解码的定稿。损坏图进入正常补图流程，期间的人工换图优先。 */
async function reusableCardImage(project, { cardId, outfitId, expected }, signal) {
  const image = project.data.assets.find((a) => a.id === expected)
  if (!hasProjectImage(project, image)) return null
  let usable = true
  try {
    await decodeReferenceImage(project.assetPath(image), signal)
  } catch {
    signal?.throwIfAborted()
    usable = false
  }
  if (
    settingImage(
      project.data.cards.find((c) => c.id === cardId),
      outfitId
    ) !== image.id
  )
    throw Error('核对期间设定卡已更改，请重新读取当前设定图。')
  return usable ? image : null
}
/** 保留工具返回的结构化诊断。工作流如何处理这些诊断由已启用的 Skill 说明。 */
export function assetIssueActions(issues) {
  return issues.map((issue) => ({ ...issue, nextAction: issue.message }))
}

/** 使用已安装 Skill 的真实命令与工程登记服务，和桌面生成操作共享资源绑定。 */
async function invokeMediaSkill(args, ctx) {
  const { skills, project, signal } = ctx
  const d = project.data
  const chosenById = args.id && skills.resolveMedia(args.kind, args.id)
  if ((args.kind || chosenById?.kind) === 'image' && args.cardId && args.regenerate !== true) {
    const target = prepareMediaTarget(d, 'image', args)
    const image = await reusableCardImage(project, target, signal)
    if (image)
      return {
        assetId: image.id,
        name: image.name,
        kind: 'image',
        cardId: target.cardId,
        ...(target.outfitId ? { outfitId: target.outfitId } : {}),
        reused: true
      }
  }
  const chosen = chosenById || skills.resolveMedia(args.kind)
  const {
    assets: [a],
    ...binding
  } = await skills.generate(
    project,
    chosen.id,
    { ...args, episodeId: args.episodeId || ctx.episodeId },
    signal
  )
  return {
    assetId: a.id,
    kind: a.kind,
    name: a.name,
    duration: a.duration,
    skillId: chosen.id,
    model: chosen.model,
    ...binding
  }
}

/** 此层只返回创作结果，不向模型提供设置对象、绝对路径或媒体命令日志。 */
export async function executeTool(name, args, ctx) {
  const { project, skills, signal } = ctx
  const d = project.data
  switch (name) {
    case 'read_project': {
      const e = d.episodes.find((e) => e.id === (args.episodeId || ctx.episodeId))
      if (args.section === 'overview')
        return {
          title: d.title,
          ratio: d.ratio,
          synopsis: d.synopsis,
          episodes: d.episodes.map(({ id, title }) => ({ id, title })),
          assets: d.assets.length,
          cards: d.cards.length
        }
      if (args.section === 'episode' && e)
        return { id: e.id, title: e.title, script: e.script, shots: e.shots.length, clips: e.clips.length }
      if (args.section === 'shot_assets') {
        const shot = e?.shots.find((s) => s.id === args.shotId)
        if (!shot) throw Error('请从本集 shots 中选择有效的 shotId')
        const report = inspectProjectShotAssets(project, shot)
        let videoModel
        try {
          const selected = skills.resolveMedia('video', args.skillId)
          videoModel = {
            skillId: selected.id,
            model: selected.model,
            referenceAudio: Boolean(
              selected.builtin && supportsReferenceAudio(selected.provider, selected.model)
            )
          }
          if (report.ready) {
            const media = skills.preflightVideo(project, selected, { episodeId: e.id, shotId: shot.id })
            await verifyVideoFiles(media, signal)
          }
        } catch (error) {
          signal?.throwIfAborted()
          report.ready = false
          for (const issue of error.issues || []) {
            const card = report.cards.find((c) => c.cardId === issue.cardId && c.outfitId === issue.outfitId)
            if (card && issue.code === 'missing_file') card.hasImage = false
          }
          report.issues.push(
            ...(error.issues || [{ code: videoModel ? 'shot_input' : 'video_route', message: error.message }])
          )
        }
        return {
          episodeId: e.id,
          shotId: shot.id,
          title: shot.title,
          videoModel,
          voiceReferences: shotVoiceReferences(d, shot),
          ...report,
          issues: assetIssueActions(report.issues)
        }
      }
      let rows = { cards: d.cards, assets: d.assets, shots: e?.shots, clips: e?.clips, audio: e?.audio }[
        args.section
      ]
      if (!Array.isArray(rows)) throw Error('未知分集或资料类型')
      if (args.section === 'assets' && args.kind) rows = rows.filter((a) => a.kind === args.kind)
      const query = args.query?.trim().toLowerCase()
      if (query && ['assets', 'cards'].includes(args.section))
        rows = rows.filter((row) =>
          [
            row.id,
            row.name,
            row.type,
            row.notes,
            ...roleOutfits(row).flatMap((o) => [o.id, o.name, o.notes])
          ].some((s) => s?.toLowerCase().includes(query))
        )
      const start = Math.max(0, Math.trunc(args.offset || 0))
      const items = rows.slice(start, start + 50).map((row) => {
        if (args.section === 'cards') {
          const outfits = roleOutfits(row)
          return {
            ...row,
            mention: mentionToken(row.id),
            referenceImage: cardImage(project, settingImage(row)),
            ...(outfits.length
              ? {
                  defaultOutfitId: defaultOutfit(row),
                  outfits: outfits.map((o) => ({
                    ...o,
                    mention: mentionToken(row.id, o.id),
                    referenceImage: cardImage(project, o.assetId)
                  }))
                }
              : {})
          }
        }
        if (args.section === 'shots') {
          const { id, title, prompt, dialogue, duration, assetId, referenceId } = row
          return {
            id,
            title,
            prompt,
            dialogue,
            duration,
            assetId,
            referenceId,
            hasVideo: d.assets.some((a) => a.id === assetId && a.kind === 'video')
          }
        }
        if (args.section === 'assets')
          return {
            ...row,
            cards: d.cards.flatMap((c) =>
              c.type === '角色'
                ? c.voiceAssetId === row.id
                  ? [{ id: c.id, name: c.name, type: c.type, usage: 'voice' }]
                  : roleOutfits(c)
                      .filter((o) => o.assetId === row.id)
                      .map((o) => ({
                        id: c.id,
                        name: c.name,
                        type: c.type,
                        outfitId: o.id,
                        outfitName: o.name
                      }))
                : c.assetId === row.id
                  ? [{ id: c.id, name: c.name, type: c.type }]
                  : []
            ),
            shots: d.episodes.flatMap((ep) =>
              ep.shots
                .filter((s) => s.assetId === row.id || s.referenceId === row.id)
                .map((s) => ({ episodeId: ep.id, shotId: s.id, title: s.title }))
            )
          }
        return row
      })
      return { total: rows.length, items }
    }
    case 'edit_project': {
      const actions = args.actions?.map((action) => ({
        ...action,
        episodeId: action.episodeId || ctx.episodeId
      }))
      const next = applyPlan(d, actions)
      project.save(next)
      return {
        revision: project.data.revision,
        changed: args.actions.map((a) => ({ op: a.op, target: a.target, id: a.id }))
      }
    }
    case 'list_skills':
      return skills.catalog()
    case 'read_skill': {
      const s = skills
        .list()
        .find((s) => s.id === args.id && s.enabled && (!s.provider || ctx.settings.ready(s.provider)))
      if (!s) throw Error('Skill 未启用或不存在')
      const directory = skills.enabledDirectory(s.id)
      const files = skillFiles(directory)
      if (args.file) {
        if (!files.includes(args.file) || !/\.(?:md|txt)$/i.test(args.file))
          throw Error('请选择此 Skill 列出的文本参考')
        return {
          id: s.id,
          file: args.file,
          text: fs.readFileSync(localFile(directory, args.file), 'utf8').slice(0, 60000)
        }
      }
      return { id: s.id, guide: s.guide, files }
    }
    case 'generate_media':
      return invokeMediaSkill(args, ctx)
    case 'run_command':
      return Object.hasOwn(args, 'commands')
        ? runCommandGroup(args, ctx, invokeMediaSkill)
        : runLegacyCommand(args, ctx)
    case 'rough_cut': {
      const next = structuredClone(project.data)
      const episode = next.episodes.find((e) => e.id === (args.episodeId || ctx.episodeId))
      if (!episode) throw Error('请选择有效分集')
      const { clips, ...status } = roughCut(episode, next.assets, next.cards)
      if (status.added || status.linked) {
        episode.clips = clips
        project.save(next)
      }
      return { episodeId: episode.id, ...status }
    }
    case 'export_episode':
      return { file: await ctx.exportEpisode(args.episodeId, signal) }
    default:
      throw Error('未知工具')
  }
}
