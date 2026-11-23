import { uid } from '../../shared/model.mjs'
import { agentDefaults } from '../../shared/agent-settings.mjs'
import { studioRuntime } from '../agent/studio-runtime.mjs'
import { AgentContext } from '../agent/context.mjs'
import { runToolLoop } from '../agent/loop.mjs'
import { loadHistoryRecord, saveHistory } from './conversation-store.mjs'

/** 对话循环只处理协议、模型上下文和工具事务。应用提供系统指令、工具及事件展示方式。 */
export async function runAgent(ctx, question) {
  const { settings, project, signal } = ctx
  if (typeof question !== 'string' || !question.trim() || question.length > 20000)
    throw Error('请输入 1 至 20000 字的创作要求')
  const redact = settings.redactor()
  const sanitized = (value) =>
    JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'string' ? redact(v) : v)))
  const event = (info) => ctx.event?.(sanitized(info))
  const append = (role, text) =>
    project.save({
      ...project.data,
      messages: [
        ...project.data.messages,
        { id: role === 'user' && ctx.turnId ? ctx.turnId : uid(), role, text: text.slice(0, 80000) }
      ]
    })
  const protocol = settings.data.llm
  const historyRecord = loadHistoryRecord(project, protocol)
  const history = historyRecord.history
  append('user', question)
  try {
    const cfg = settings.credentials(protocol)
    const runtime = (ctx.runtime || studioRuntime)({ ...ctx, event })
    const limits = { ...agentDefaults, ...settings.data.agent }
    const memory = new AgentContext(
      history,
      question,
      { protocol, system: runtime.system, tools: runtime.tools, model: cfg.model, baseUrl: cfg.url },
      (value) => saveHistory(project, sanitized(value)),
      historyRecord.native
    )
    const options = {
      protocol,
      cfg,
      signal,
      redact,
      responseTimeoutMs: limits.responseTimeoutSeconds * 1000,
      onRetry: (attempt, limit) =>
        event({
          type: 'progress',
          text: '尚未收到模型响应，已发起第 ' + attempt + ' / ' + limit + ' 次重试。'
        }),
      onText: (text) => event({ type: 'delta', text })
    }
    return await runToolLoop({
      memory,
      runtime,
      options,
      threshold: limits.contextThreshold,
      event,
      append,
      sanitized
    })
  } catch (err) {
    const message = signal.aborted ? '本轮已停止。' : redact(err.message)
    append('assistant', message)
    throw Error(message)
  }
}
