import fs from 'node:fs'
import path from 'node:path'
import { localFile, readJson, writeJson } from '../core/files.mjs'

export const contextFile = 'agent-context.json'

/** 旧工程仅存对话与展示轨迹，重建能确证的调用回执，以便接续升级前已经执行的工作。 */
function previousHistory(project) {
  const messages = project.data.messages
  const files = project.runs?.files?.() || []
  const known = new Set(files.map((file) => path.basename(file, '.json')))
  const legacy = project.runs?.legacy?.(messages, files)
  const last = messages.findLast((m) => m.role === 'user' && (known.has(m.id) || legacy?.id === m.id))
  const history = messages.map((m) => ({ role: m.role, content: m.text }))
  if (!last) return history
  const record = known.has(last.id) ? project.runs.read(last.id) : legacy
  const calls = new Map()
  const receipts = []
  for (const e of record?.events || []) {
    if (e.type === 'tool' && e.id) calls.set(e.id, e)
    if (e.type === 'result' && calls.has(e.id) && (typeof e.summary === 'string' || e.recoveryError)) {
      const call = calls.get(e.id)
      receipts.push({
        id: e.id,
        tool: call.name,
        arguments: call.arguments,
        failed: Boolean(e.failed),
        result: e.summary || { error: e.recoveryError }
      })
    }
  }
  if (receipts.length) {
    const position = messages.indexOf(last)
    const next = messages.findIndex((m, i) => i > position && m.role === 'user')
    history.splice(next < 0 ? history.length : next, 0, {
      role: 'assistant',
      content:
        '旧版本已执行的工具回执。旧轨迹可能仅保存长参数和输出的开头，请核查现有成果后继续。\n' +
        JSON.stringify(receipts)
    })
  }
  return history
}

/** 已提交的命令保存在模型上下文中，公开的 UI 轨迹只保存可展示的动作。 */
function validDisplayHistory(history) {
  return (
    Array.isArray(history) &&
    history.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
  )
}

function originalMessages(messages, index) {
  return messages.slice(index + 1).map((m) => ({ role: m.role, content: m.text }))
}

/** 升级 H3 直连协议时移除会诱导模型复用的旧调用示例，实际执行结果仍保留在 agent-runs 展示轨迹。 */
function migrateNativeHistory(history) {
  if (!Array.isArray(history)) return history
  const result = []
  let removed = 0
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]
    const blocks = Array.isArray(message?.content) ? message.content : []
    const calls = [
      ...(Array.isArray(message?.tool_calls) ? message.tool_calls : []),
      ...blocks.filter((block) => block?.name === 'run_command' || block?.type === 'function_call')
    ]
    const legacy = calls.some((call) => {
      const raw = call.function?.arguments ?? call.arguments ?? call.input
      let input = raw
      try {
        if (typeof raw === 'string') input = JSON.parse(raw)
      } catch {
        return false
      }
      return input?.commands?.some(
        (step) =>
          ['minimax-video', 'vllm-h3'].includes(step?.skill) && !String(step?.finalPrompt || '').trim()
      )
    })
    if (!legacy) {
      result.push(message)
      continue
    }
    removed += 1
    result.push({
      role: 'assistant',
      content:
        '历史中的 H3 视频调用使用了旧协议，未包含 finalPrompt，不能作为当前调用范例。继续制作 H3 镜头前必须重新读取当前 SKILL.md 和 references，再按官方格式生成 finalPrompt。'
    })
    const next = history[index + 1]
    if (
      next &&
      (next.role === 'tool' ||
        (Array.isArray(next.content) && next.content.some((block) => block?.type === 'tool_result')) ||
        next.type === 'function_call_output')
    )
      index += 1
  }
  return removed ? result : history
}

/** 将新版上下文写成协议原生历史，工具角色和调用结果直接可审计。 */
function saveNativeContext(project, value) {
  writeJson(path.join(project.root, contextFile), {
    version: 3,
    projectId: project.data.id,
    protocol: value.protocol,
    throughMessageId: project.data.messages.at(-1)?.id,
    history: value.nativeHistory,
    displayHistory: value.history,
    nativeComplete: value.nativeComplete === true
  })
}

/** 读取可继续的模型上下文，并在协议一致时恢复原生工具与 thinking 内容块。 */
export function loadHistoryRecord(project, protocol) {
  const messages = project.data.messages
  const original = (items) => items.map((m) => ({ role: m.role, content: m.text }))
  if (!project.root || !fs.existsSync(path.join(project.root, contextFile)))
    return { history: previousHistory(project), native: null }
  let saved
  try {
    saved = readJson(localFile(project.root, contextFile))
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error
    return { history: previousHistory(project), native: null }
  }
  const index = messages.findIndex((m) => m.id === saved?.throughMessageId)
  if (
    saved?.version === 3 &&
    saved.projectId === project.data.id &&
    validDisplayHistory(saved.displayHistory) &&
    (!protocol || saved.protocol !== protocol || saved.nativeComplete !== true)
  ) {
    const tail = index >= 0 ? originalMessages(messages, index) : []
    return { history: [...saved.displayHistory, ...tail], native: null }
  }
  if (
    saved?.version === 3 &&
    saved.projectId === project.data.id &&
    validDisplayHistory(saved.displayHistory) &&
    Array.isArray(saved.history) &&
    saved.nativeComplete === true &&
    saved.protocol === protocol
  ) {
    const tail = index >= 0 ? originalMessages(messages, index) : []
    return {
      history: [...saved.displayHistory, ...tail],
      native: migrateNativeHistory([...saved.history, ...tail])
    }
  }
  if (
    saved?.version === 2 &&
    saved.projectId === project.data.id &&
    validDisplayHistory(saved.history) &&
    (!protocol || saved.protocol !== protocol || saved.nativeComplete !== true)
  ) {
    const tail = index >= 0 ? originalMessages(messages, index) : []
    return { history: [...saved.history, ...tail], native: null }
  }
  if (
    saved?.version === 2 &&
    saved.projectId === project.data.id &&
    validDisplayHistory(saved.history) &&
    Array.isArray(saved.nativeHistory) &&
    saved.nativeComplete === true &&
    saved.protocol === protocol
  ) {
    const tail = index >= 0 ? originalMessages(messages, index) : []
    return {
      history: [...saved.history, ...tail],
      native: [...saved.nativeHistory, ...tail]
    }
  }
  if (
    saved?.version !== 1 ||
    saved.projectId !== project.data.id ||
    index < 0 ||
    !Array.isArray(saved.history) ||
    !saved.history.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
  )
    return { history: previousHistory(project), native: null }
  return { history: [...saved.history, ...original(messages.slice(index + 1))], native: null }
}

/** 兼容旧调用方只读取可展示的文本上下文。 */
export function loadHistory(project, protocol) {
  return loadHistoryRecord(project, protocol).history
}

/** 原子写入经脱敏的模型历史，界面仅订阅独立的操作轨迹。 */
export function saveHistory(project, value) {
  if (!project.root) return
  if (!Array.isArray(value)) return saveNativeContext(project, value)
  writeJson(path.join(project.root, contextFile), {
    version: 1,
    projectId: project.data.id,
    throughMessageId: project.data.messages.at(-1)?.id,
    history: value
  })
}
