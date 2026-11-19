import fs from 'node:fs'
import path from 'node:path'
import { localDir, localFile, readJson, writeJson } from '../core/files.mjs'
import { describeRun } from '../../shared/agent-trace.mjs'

const folder = 'agent-runs'
const runId = /^[A-Za-z0-9_-]{1,80}$/
export const isRunFile = (name) => /^agent-runs\/[A-Za-z0-9_-]{1,80}\.json$/.test(name)

/** 每次提问有独立的执行记录，提问消息的 ID 同时是记录主键。 */
export class AgentHistory {
  constructor(root) {
    this.root = root
    this.summaries = new Map()
  }
  /** 保存一次运行，不重复持久化整个工程及以往对话。 */
  save(task) {
    if (!runId.test(task.id)) throw Error('无效的会话编号')
    const { id, status, startedAt, endedAt, error, events } = task
    const record = { id, status, startedAt, endedAt, error, events }
    writeJson(path.join(localDir(this.root, folder), id + '.json'), record)
    this.summaries.delete(id)
    if (status !== 'running') this.summaries.set(id, describeRun(record))
  }
  /** 只打包本应用认可的执行记录文件。 */
  files() {
    if (!fs.existsSync(path.join(this.root, folder))) return []
    return fs
      .readdirSync(localDir(this.root, folder))
      .map((name) => folder + '/' + name)
      .filter(isRunFile)
  }
  /** 0.2 仅保存过最后一次执行，在新记录之前定位相应提问。 */
  legacy(messages, files) {
    if (!fs.existsSync(path.join(this.root, 'last-run.json'))) return null
    const modern = new Set(files.map((name) => path.basename(name, '.json')))
    let turn
    for (const message of messages) {
      if (modern.has(message.id)) break
      if (message.role === 'user') turn = { id: message.id, reply: '' }
      else if (turn) turn.reply = message.text
    }
    if (!turn) return null
    const events = readJson(localFile(this.root, 'last-run.json'))
    if (!Array.isArray(events) || !events.length) return null
    const answer = events.findLast((event) => event?.type === 'message')
    const status =
      turn.reply === '本轮已停止。' ? 'cancelled' : answer?.text === turn.reply ? 'completed' : 'interrupted'
    return { id: turn.id, status, events }
  }
  /** 返回小型回执，当前进程内缓存已完成任务的摘要。 */
  list(messages) {
    const files = this.files()
    const results = []
    for (const name of files) {
      const id = path.basename(name, '.json')
      let summary = this.summaries.get(id)
      if (!summary) {
        const record = this.read(id)
        if (!record) continue
        summary = describeRun(record)
        if (record.status !== 'running') this.summaries.set(id, summary)
      }
      results.push(summary)
    }
    const legacy = this.legacy(messages, files)
    if (legacy) results.push(describeRun(legacy))
    return results
  }
  /** 读取一个主键对应的工具轨迹，限制在该工作目录内。 */
  read(id) {
    if (typeof id !== 'string' || !runId.test(id)) throw Error('无效的会话编号')
    const name = folder + '/' + id + '.json'
    if (!fs.existsSync(path.join(this.root, name))) return null
    const record = readJson(localFile(this.root, name))
    return record?.id === id && Array.isArray(record.events) ? record : null
  }
  /** 旧工程在下一次打包和打开时也可以展开最后一次操作。 */
  trace(id, messages) {
    const record = this.read(id) || this.legacy(messages, this.files())
    return record?.id === id ? record.events : []
  }
}
