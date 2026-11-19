import fs from 'node:fs'
import path from 'node:path'
import { assetIssueActions, executeTool, toolsForSession } from './tools.mjs'
import { traceToolStart, traceToolResult } from '../../shared/agent-trace.mjs'

const instructions = new URL('../../resources/prompts/agent.md', import.meta.url)

/** 装配本应用的工具、环境和启用的创作指南，通用对话循环只依赖这个运行接口。 */
export function studioRuntime(ctx) {
  const tools = toolsForSession(ctx.skills)
  const names = new Set(tools.map((tool) => tool.name))
  const guides = ctx.skills.list().filter((skill) => skill.enabled && skill.kind === 'guide')
  const system = [fs.readFileSync(instructions, 'utf8').trim(), '当前分集 ID：' + ctx.episodeId]
  const localPrompt = ctx.settings.root && path.join(ctx.settings.root, 'prompts', 'AGENT.md')
  if (localPrompt && fs.existsSync(localPrompt)) system.push(fs.readFileSync(localPrompt, 'utf8').trim())
  for (const guide of guides) {
    if (guide.context === 'always') system.push(guide.guide.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, ''))
    else system.push('可用工作流 ' + guide.id + '：' + guide.description)
  }
  return {
    system: system.join('\n\n'),
    tools,
    execute(name, args, callId, checkpoint) {
      if (!names.has(name)) throw Error('当前会话未注册该工具：' + name)
      return executeTool(name, args, {
        ...ctx,
        callId,
        checkpoint,
        onCommandStep: (index, status, metadata = {}) =>
          ctx.event?.({ type: 'command_step', id: callId, index, status, ...metadata })
      })
    },
    describeCall: traceToolStart,
    describeResult: traceToolResult,
    describeError: (error) => (Array.isArray(error.issues) ? { issues: assetIssueActions(error.issues) } : {})
  }
}
