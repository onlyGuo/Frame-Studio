import { randomUUID } from 'node:crypto'
import { runAgent } from '../services/agent.mjs'

/** 运行权归主进程；页面只订阅增量事件，重新连接时可恢复当前快照。 */
export class BackgroundAgent {
  current = null
  project = null
  controller = null
  sequence = 0

  constructor(emit) {
    this.emit = emit
  }
  /** 给快照与增量统一编号，重连时可跳过已包含在快照中的事件。 */
  publish(update) {
    this.current.sequence = ++this.sequence
    if (update.task) update.task.sequence = this.sequence
    this.emit({ ...update, sequence: this.sequence })
  }
  /** 给订阅界面独立的任务副本，便于重载后从当前进度继续。 */
  snapshot() {
    return this.current && structuredClone(this.current)
  }
  /** 取消指定运行，过期窗口的操作不会中断新任务。 */
  cancel(id) {
    if (this.current?.id === id) this.controller?.abort()
  }
  /** 待批准命令绑定到运行和一次性 ID，界面导航不会代替创作者确认。 */
  approve(spec, signal) {
    signal.throwIfAborted()
    const id = randomUUID(),
      task = this.current
    task.approval = { ...structuredClone(spec), id }
    return new Promise((resolve) => {
      const abort = () => this.answer(task.id, id, false)
      this.resolveApproval = (allowed) => {
        signal.removeEventListener('abort', abort)
        task.approval = null
        this.resolveApproval = null
        this.publish({ type: 'approval', id: task.id, approval: null })
        resolve(allowed)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.publish({ type: 'approval', id: task.id, approval: task.approval })
    })
  }
  /** 确认仍在等待的这一次命令。 */
  answer(taskId, id, allowed) {
    if (
      !id ||
      this.current?.id !== taskId ||
      this.current.approval?.id !== id ||
      typeof allowed !== 'boolean'
    )
      return false
    this.resolveApproval(allowed)
    return true
  }
  /** 先返回运行快照，再异步推进属于该工程的工具循环。 */
  start(ctx, question) {
    if (this.controller) throw Error('上一项助手任务仍在执行')
    if (typeof question !== 'string' || !question.trim() || question.length > 20000)
      throw Error('请输入有效的创作要求')
    const { project, episodeId, settings } = ctx
    const controller = new AbortController()
    this.controller = controller
    this.project = project
    const cfg = settings.view()
    const task = (this.current = {
      id: randomUUID(),
      session: project.session,
      root: project.root,
      title: project.data.title,
      episodeTitle: project.data.episodes.find((e) => e.id === episodeId)?.title || '',
      model: cfg.profiles[cfg.llm].model,
      startedAt: new Date().toISOString(),
      status: 'running',
      question,
      messages: structuredClone(project.data.messages),
      events: []
    })
    const started = this.snapshot()
    this.publish({ type: 'started', task: started })
    let revision = project.data.revision
    const event = (info) => {
      const row = { ...info, time: new Date().toISOString() }
      const last = task.events.at(-1)
      if (row.type === 'delta' && last?.type === 'delta') last.text += row.text
      else {
        if (last?.type === 'delta' && row.type === 'message') task.events.pop()
        task.events.push(row)
      }
      if (row.type !== 'delta') project.runs.save(task)
      const changed = revision !== project.data.revision
      revision = project.data.revision
      this.publish({ type: 'activity', id: task.id, row, state: changed ? project.snapshot() : undefined })
    }
    const finish = (status, message) => {
      task.status = status
      task.error = message
      task.endedAt = new Date().toISOString()
      task.finalMessages = structuredClone(project.data.messages)
      this.controller = null
      try {
        project.runs.save(task)
      } catch (err) {
        task.error = [message, '保存执行记录失败：' + err.message].filter(Boolean).join('\n')
        task.status = 'failed'
      }
      this.publish({ type: 'finished', task: this.snapshot(), state: project.snapshot() })
    }
    runAgent(
      {
        ...ctx,
        turnId: task.id,
        approve: (spec, sig) => this.approve(spec, sig),
        signal: controller.signal,
        event
      },
      question
    ).then(
      () => finish('completed'),
      (err) => finish(controller.signal.aborted ? 'cancelled' : 'failed', err.message)
    )
    return started
  }
}
