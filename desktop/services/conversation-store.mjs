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
    if (e.type === 'result' && calls.has(e.id) && typeof e.summary === 'string') {
      const call = calls.get(e.id)
      receipts.push({
        id: e.id,
        tool: call.name,
        arguments: call.arguments,
        failed: Boolean(e.failed),
        result: e.summary
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
export function loadHistory(project) {
  const messages = project.data.messages
  const original = (items) => items.map((m) => ({ role: m.role, content: m.text }))
  if (!project.root || !fs.existsSync(path.join(project.root, contextFile))) return previousHistory(project)
  let saved
  try {
    saved = readJson(localFile(project.root, contextFile))
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error
    return previousHistory(project)
  }
  const index = messages.findIndex((m) => m.id === saved?.throughMessageId)
  if (
    saved?.version !== 1 ||
    saved.projectId !== project.data.id ||
    index < 0 ||
    !Array.isArray(saved.history) ||
    !saved.history.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
  )
    return previousHistory(project)
  return [...saved.history, ...original(messages.slice(index + 1))]
}

/** 原子写入经脱敏的模型历史，界面仅订阅独立的操作轨迹。 */
export function saveHistory(project, history) {
  if (!project.root) return
  writeJson(path.join(project.root, contextFile), {
    version: 1,
    projectId: project.data.id,
    throughMessageId: project.data.messages.at(-1).id,
    history
  })
}
