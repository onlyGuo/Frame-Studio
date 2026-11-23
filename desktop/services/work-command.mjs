import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { localFile, localDir } from '../core/files.mjs'
import { mediaKinds } from '../../shared/model.mjs'
import { withMediaTarget } from './media-targets.mjs'
import { prepareMediaTarget, commitMediaTarget, videoTargetChanged } from '../../shared/shot-media.mjs'
import { providerEnvironment } from './commands.mjs'
import { probe, probeVoiceSample } from './media.mjs'
import { profiles } from './settings.mjs'
import { prepareVideoInput, verifyVideoFiles } from './shot-assets.mjs'
import { applyScriptEdits, readScriptEdits, writeScriptSnapshot, writeWorkScript } from './command-script.mjs'

/** 人工及智能体使用同一命令入口。只有显式声明的产物会进入媒体库。 */
export async function runWorkCommand(project, settings, commands, spec, signal, scope) {
  if (spec.provider && (!Object.hasOwn(profiles, spec.provider) || profiles[spec.provider][1] === 'llm'))
    throw Error('无效的媒体服务')
  if (spec.extension && !Object.hasOwn(mediaKinds, spec.extension)) throw Error('不支持的产物格式')
  if (profiles[spec.provider]?.[1] === 'video' && mediaKinds[spec.extension] !== 'video')
    throw Error('视频服务命令须声明视频产物扩展名并指定待制作的分镜，才能核对出场资产。')
  const target = spec.extension && prepareMediaTarget(project.data, mediaKinds[spec.extension], spec)
  return withMediaTarget(project, target, () =>
    execute(project, settings, commands, spec, signal, target, scope)
  )
}
/** 在已确定的目标上执行，并将本次命令的产物绑定到工程。 */
async function execute(project, settings, commands, spec, signal, target, scope) {
  const env = providerEnvironment(settings, spec.provider)
  const base = project.data
  if (mediaKinds[spec.extension] === 'video') {
    const { prompt, references, audioReferences } = prepareVideoInput(project, target, spec, {
      provider: profiles[spec.provider]?.[1] === 'video' ? spec.provider : undefined,
      model: env.STUDIO_MODEL
    })
    await verifyVideoFiles([...references, ...(audioReferences || [])], signal)
    env.STUDIO_REFERENCES = JSON.stringify(references)
    if (audioReferences?.length) env.STUDIO_AUDIO_REFERENCES = JSON.stringify(audioReferences)
    env.STUDIO_VIDEO_PROMPT = prompt
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-command-'))
  try {
    if (videoTargetChanged(project.data, target))
      throw Error('分镜或出场资产刚刚更改，请核对最新版本再生成。')
    if (spec.extension) env.STUDIO_OUTPUT = path.join(temp, 'result' + spec.extension)
    const work = localDir(project.root, 'work')
    const redact = settings.redactor?.()
    env.STUDIO_PROJECT = writeScriptSnapshot(temp, base, redact)
    if (spec.applyEdits) env.STUDIO_EDITS = path.join(temp, 'edits.json')
    signal?.throwIfAborted()
    if (spec.script) writeWorkScript(work, spec.script)
    let invocation = spec
    if (scope?.skillDirectory) {
      env.STUDIO_SKILL_DIR = scope.skillDirectory
      const expand = (value) => value.replaceAll('{skill}', () => scope.skillDirectory)
      invocation = { ...spec, executable: expand(spec.executable), args: spec.args.map(expand) }
    }
    const result = await commands.run(invocation, {
      cwd: work,
      env,
      signal,
      capture: true
    })
    signal?.throwIfAborted()
    if (result.code) return result
    const actions = spec.applyEdits ? readScriptEdits(temp, spec.episodeId) : []
    if (actions.length && redact && redact(JSON.stringify(actions)) !== JSON.stringify(actions))
      throw Error('工程变更包含已配置的服务地址或凭据，请移除后重新运行。')
    if (spec.extension) {
      const [asset] = await project.addMedia(
        [localFile(temp, 'result' + spec.extension)],
        target.kind === 'audio' && target.cardId ? (file) => probeVoiceSample(file, signal) : probe,
        '命令生成素材',
        (draft, [item]) => {
          if (actions.length) Object.assign(draft, applyScriptEdits(base, draft, actions))
          result.binding = commitMediaTarget(draft, item, target)
        }
      )
      result.asset = asset
    } else if (actions.length) project.save(applyScriptEdits(base, project.data, actions))
    if (actions.length) result.changed = actions.map(({ op, target, id }) => ({ op, target, id }))
    if (spec.extension || actions.length) result.state = project.snapshot()
    return result
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}
