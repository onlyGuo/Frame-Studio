import { validateCommand } from './commands.mjs'
import { validateScript } from './command-script.mjs'

const mediaKinds = ['image', 'video', 'audio']

/** 将本次请求选用的服务冻结到具体 Skill，授权界面显示与实际调用相同的配置名称。 */
function resolveStep(step, ctx) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw Error('无效的命令步骤')
  const spec = { ...step, episodeId: step.episodeId || ctx.episodeId }
  if (step.skill !== undefined) {
    if (
      typeof step.skill !== 'string' ||
      !step.skill ||
      step.executable !== undefined ||
      step.script ||
      step.fromSkill !== undefined ||
      step.applyEdits ||
      step.args !== undefined ||
      step.provider ||
      step.mediaKind ||
      step.extension
    )
      throw Error('一个步骤应选择已配置的 Skill 或可执行命令')
    const selected = mediaKinds.includes(step.skill)
      ? ctx.skills.resolveMedia(step.skill)
      : ctx.skills.resolveMedia(undefined, step.skill)
    return {
      ...spec,
      skill: selected.id,
      provider: selected.provider,
      model: selected.model,
      mediaKind: selected.kind
    }
  }
  validateCommand(step)
  if (step.fromSkill !== undefined) ctx.skills.enabledDirectory(step.fromSkill)
  if (step.applyEdits !== undefined && typeof step.applyEdits !== 'boolean')
    throw Error('applyEdits 必须为布尔值')
  if (step.script) validateScript(step.script)
  if (step.provider || step.mediaKind) {
    const selected = step.provider
      ? ctx.skills
          .catalog()
          .find((s) => s.provider === step.provider && (!step.mediaKind || s.kind === step.mediaKind))
      : ctx.skills.resolveMedia(step.mediaKind)
    if (!selected?.provider) throw Error('没有可注入的就绪媒体服务，请检查媒体模型配置')
    spec.provider = selected.provider
    spec.model = selected.model
  }
  return spec
}

/** 普通命令的回执保留有限标准输出；带凭据的步骤只回传状态及已登记的产物。 */
async function runStep(spec, ctx, invokeSkill) {
  if (spec.provider && ctx.settings?.data?.profiles?.[spec.provider]?.model !== spec.model)
    throw Error('命令等待期间模型配置已更改，请重新选择服务')
  if (spec.skill) return invokeSkill({ ...spec, id: spec.skill, kind: spec.mediaKind }, ctx)
  const scope = spec.fromSkill ? { skillDirectory: ctx.skills.enabledDirectory(spec.fromSkill) } : undefined
  const { code, stdout, stderr, asset, binding, changed } = await ctx.command(spec, ctx.signal, scope)
  const result = { exitCode: code }
  if (!spec.provider) {
    result.stdout = (stdout || '').slice(-8000)
    result.stderr = (stderr || '').slice(-4000)
  }
  if (asset) Object.assign(result, { asset }, binding)
  if (changed) result.changed = changed
  return result
}

/** 持久记录只需要操作名称、工程更改与素材。命令输出仅随原生工具结果回送模型。 */
function progress(ctx, index, status, step, result = {}) {
  const label = step.script?.path || step.skill || step.executable
  const asset =
    result.asset || (result.assetId && { id: result.assetId, kind: result.kind, name: result.name })
  ctx.onCommandStep?.(index, status, {
    label,
    ...(asset ? { asset, outputs: [asset] } : {}),
    ...(result.changed ? { changed: result.changed } : {})
  })
}

/** 一次原生工具调用授权一组命令，按输入顺序执行并交付每一步的回执。 */
export async function runCommandGroup(input, ctx, invokeSkill) {
  if (
    !Array.isArray(input.commands) ||
    !input.commands.length ||
    input.commands.length > 32 ||
    (input.continueOnError !== undefined && typeof input.continueOnError !== 'boolean')
  )
    throw Error('命令组需要 1 至 32 个步骤')
  const steps = input.commands.map((step) => {
    try {
      return { spec: resolveStep(step, ctx) }
    } catch (error) {
      return { spec: {}, error: error.message }
    }
  })
  const continueOnError = input.continueOnError === true
  const hasPrograms = steps.some((step) => !step.error && !step.spec.skill)
  const approved =
    !hasPrograms ||
    (await ctx.approve(
      {
        commands: steps.map((step, i) =>
          step.error ? { ...input.commands[i], validationError: step.error } : step.spec
        ),
        continueOnError
      },
      ctx.signal
    ))
  const results = []
  let skip = approved ? '' : '创作者拒绝了本组命令，请尊重决定'
  for (const [index, entry] of steps.entries()) {
    ctx.signal.throwIfAborted()
    const spec = entry.spec
    let result
    if (skip) result = { status: 'skipped', reason: skip }
    else {
      progress(ctx, index, 'running', spec)
      try {
        if (entry.error) throw Error(entry.error)
        const value = await runStep(spec, ctx, invokeSkill)
        result = {
          ...value,
          status: value.exitCode === undefined || value.exitCode === 0 ? 'completed' : 'failed'
        }
      } catch (error) {
        ctx.signal.throwIfAborted()
        result = { status: 'failed', error: error.message, ...(error.issues ? { issues: error.issues } : {}) }
      }
      if (result.status === 'failed' && !continueOnError) skip = '前序步骤失败，后续命令未执行'
    }
    results.push(result)
    await ctx.checkpoint?.({
      executed: approved,
      results: [...results],
      remaining: steps.length - results.length
    })
    progress(ctx, index, result.status, spec, result)
  }
  return { executed: approved, results }
}

/** 老版本会话仍可消费旧的单条命令回执；新请求统一使用命令组。 */
export async function runLegacyCommand(input, ctx) {
  const spec = resolveStep(input, ctx)
  if (!(await ctx.approve(spec, ctx.signal)))
    return { executed: false, reason: '创作者拒绝了本次命令，请尊重决定' }
  ctx.signal.throwIfAborted()
  return { executed: true, ...(await runStep(spec, ctx)) }
}
