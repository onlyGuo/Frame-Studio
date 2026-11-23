import { validateCommand } from './commands.mjs'
import { validateScript } from './command-script.mjs'
import os from 'node:os'

const mediaKinds = ['image', 'video', 'audio']
const internalExecutables = new Set(['node', 'python', 'python3', 'ffmpeg'])

/** 识别可能越过工程 work/ 的路径，保守处理绝对路径和父目录跳转。 */
function hasExternalPath(text) {
  return /(?:^|[\s"'`=:(])(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/{1,2}|\.\.[\\/])/.test(text)
}

/** 为审批策略提供内部、低风险外部和高风险外部三级命令风险。 */
export function commandRisk(spec = {}) {
  if (spec.skill) return 'internal'
  const executable = String(spec.executable || '')
    .split(/[\\/]/)
    .at(-1)
    .toLowerCase()
  const args = (spec.args || []).join('\n')
  const text = [spec.executable, args, spec.script?.content].filter(Boolean).join('\n')
  if (spec.provider || spec.fromSkill || !internalExecutables.has(executable)) return 'high'
  const network =
    /https?:\/\//i.test(text) ||
    /\b(?:fetch|axios|curl|wget|httpie|ssh|scp|nc|https?\.request|git\s+(?:clone|pull|push|fetch))\b/i.test(
      text
    )
  const externalPath = hasExternalPath(text)
  const write =
    /\b(?:rm|rmdir|del|erase|unlink|rename|copyFile(?:Sync)?|appendFile(?:Sync)?|writeFile(?:Sync)?|mkdir(?:Sync)?|chmod|chown|git\s+(?:clone|pull|push))\b/i.test(
      text
    ) || /(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)|(?:^|\s)-[dF]\b/i.test(text)
  if ((externalPath && write) || (network && write)) return 'high'
  if (externalPath || network) return 'low'
  return 'internal'
}

function needsApproval(risk, mode) {
  return risk !== 'internal' && mode !== 'full'
}

/** 将子进程原生回执交给模型，凭据由调用方的脱敏器遮蔽。 */
function redactShell(text, ctx, spec) {
  let result = String(text || '')
  const redact = ctx.settings?.redactor?.()
  if (redact) result = redact(result)
  for (const value of [ctx.project?.root, os.tmpdir()])
    if (value) result = result.replaceAll(value, '[本地路径]')
  const url = spec.provider && ctx.settings?.data?.profiles?.[spec.provider]?.url
  if (url) {
    try {
      const parsed = new URL(url)
      result = result.replaceAll(parsed.origin, '[服务地址]')
    } catch {}
  }
  result = result.replace(/https?:\/\/[^\s]+/g, '[服务地址]')
  return result
}

function shellResult(value, ctx, spec) {
  return {
    exitCode: value.code ?? value.exitCode,
    ...(value.reason || value.signal ? { signal: value.reason || value.signal } : {}),
    stdout: redactShell(value.stdout, ctx, spec),
    stderr: redactShell(value.stderr, ctx, spec)
  }
}

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

/** 将普通命令的原生回执交给模型，实时轨迹只保存状态及已登记的产物。 */
async function runStep(spec, ctx, invokeSkill) {
  if (spec.provider && ctx.settings?.data?.profiles?.[spec.provider]?.model !== spec.model)
    throw Error('命令等待期间模型配置已更改，请重新选择服务')
  if (spec.skill) {
    const value = await invokeSkill(
      {
        ...spec,
        id: spec.skill,
        kind: spec.mediaKind,
        includeCommandResult: true,
        requireFinalPrompt: true
      },
      ctx
    )
    return value &&
      (Object.hasOwn(value, 'stdout') || Object.hasOwn(value, 'stderr') || Object.hasOwn(value, 'exitCode'))
      ? { ...value, ...shellResult(value, ctx, spec) }
      : value
  }
  const scope = spec.fromSkill ? { skillDirectory: ctx.skills.enabledDirectory(spec.fromSkill) } : undefined
  const value = await ctx.command(spec, ctx.signal, scope)
  const result = shellResult(value, ctx, spec)
  const { asset, binding, changed } = value
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
  if (!Array.isArray(input.commands) || !input.commands.length || input.commands.length > 32)
    throw Error('命令组需要 1 至 32 个步骤')
  if (input.continueOnError !== undefined && typeof input.continueOnError !== 'boolean')
    throw Error('continueOnError 必须为布尔值')
  if (input.executionMode !== undefined && !['serial', 'parallel'].includes(input.executionMode))
    throw Error('executionMode 只能是 serial 或 parallel')
  const steps = input.commands.map((step) => {
    try {
      return { spec: resolveStep(step, ctx) }
    } catch (error) {
      return { spec: {}, error: error.message }
    }
  })
  const continueOnError = input.continueOnError === true
  const executionMode = input.executionMode || 'serial'
  const mode = ctx.settings?.data?.agent?.approvalMode || 'ask'
  const risks = steps.map((step) => (step.error ? 'internal' : commandRisk(step.spec)))
  const requiresApproval = risks.some((risk) => needsApproval(risk, mode))
  const approved =
    !requiresApproval ||
    (await ctx.approve(
      {
        commands: steps.map((step, i) =>
          step.error
            ? { ...input.commands[i], validationError: step.error }
            : { ...step.spec, ...(risks[i] !== 'internal' ? { approvalRisk: risks[i] } : {}) }
        ),
        continueOnError,
        executionMode,
        approvalRisk: risks.includes('high') ? 'high' : 'low'
      },
      ctx.signal
    ))
  const results = []
  let skip = approved ? '' : '创作者拒绝了本组命令，请尊重决定'
  if (executionMode === 'parallel') {
    const completed = new Array(steps.length).fill(false)
    const parallelResults = new Array(steps.length)
    let checkpointTail = Promise.resolve()
    const checkpoint = (value) => {
      checkpointTail = checkpointTail.then(() => ctx.checkpoint?.(value))
      return checkpointTail
    }
    await Promise.all(
      steps.map(async (entry, index) => {
        ctx.signal.throwIfAborted()
        const spec = entry.spec
        let result
        if (!approved) result = { status: 'skipped', reason: skip }
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
            result = {
              ...(error.commandResult ? shellResult(error.commandResult, ctx, spec) : {}),
              status: 'failed',
              error: error.message,
              ...(error.recovery ? { recovery: error.recovery } : {}),
              ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
              ...(error.issues ? { issues: error.issues } : {})
            }
          }
        }
        parallelResults[index] = result
        completed[index] = true
        progress(ctx, index, result.status, spec, result)
        await checkpoint({
          executed: approved,
          executionMode,
          results: parallelResults.map((value, n) => (completed[n] ? value : { status: 'running' })),
          remaining: completed.filter((value) => !value).length
        })
      })
    )
    return { executed: approved, executionMode, results: parallelResults }
  }
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
        result = {
          ...(error.commandResult ? shellResult(error.commandResult, ctx, spec) : {}),
          status: 'failed',
          error: error.message,
          ...(error.recovery ? { recovery: error.recovery } : {}),
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          ...(error.issues ? { issues: error.issues } : {})
        }
      }
      if (result.status === 'failed' && !continueOnError) skip = '前序步骤失败，后续命令未执行'
    }
    results.push(result)
    await ctx.checkpoint?.({
      executed: approved,
      executionMode,
      results: [...results],
      remaining: steps.length - results.length
    })
    progress(ctx, index, result.status, spec, result)
  }
  return { executed: approved, executionMode, results }
}

/** 老版本会话仍可消费旧的单条命令回执；新请求统一使用命令组。 */
export async function runLegacyCommand(input, ctx) {
  const spec = resolveStep(input, ctx)
  const risk = commandRisk(spec)
  const mode = ctx.settings?.data?.agent?.approvalMode || 'ask'
  if (needsApproval(risk, mode) && !(await ctx.approve({ ...spec, approvalRisk: risk }, ctx.signal)))
    return { executed: false, reason: '创作者拒绝了本次命令，请尊重决定' }
  ctx.signal.throwIfAborted()
  return { executed: true, ...(await runStep(spec, ctx)) }
}
