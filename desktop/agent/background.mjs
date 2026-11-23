import { randomUUID } from 'node:crypto'
import { runAgent } from '../services/agent.mjs'
import { conversation } from './protocols.mjs'
import { requestModel } from './transport.mjs'

const reviewTool = {
  name: 'review_commands',
  description:
    '审核一组即将执行的本机命令。每个命令返回 allow、ask 或 deny。allow 只适用于内部或低风险操作，外部写入、删除、凭据、网络写入和无法确认安全的操作返回 ask。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'decision', 'reason'],
          properties: {
            index: { type: 'integer' },
            decision: { type: 'string', enum: ['allow', 'ask', 'deny'] },
            reason: { type: 'string' }
          }
        }
      }
    }
  }
}

const reviewSystem = `你是 Frame Studio 的独立命令审核器。你只审核命令，不执行命令，也不修改工程。
对每一组命令逐项返回决定。内部工程工具、工程 work/ 内的受控读写和明确的低风险只读网络访问可以 allow。外部文件写入或删除、绝对路径、凭据、网络写入、付费服务调用、未知程序和无法确认安全的内容必须 ask。deny 只用于明显违反当前工程边界或危险目的的命令。必须为每个输入命令返回一个 index、decision 和简短 reason，使用 review_commands 工具。`

/** 运行权归主进程；页面只订阅增量事件，重新连接时可恢复当前快照。 */
export class BackgroundAgent {
  current = null
  project = null
  controller = null
  settings = null
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
    const mode = this.settings?.data.agent?.approvalMode || 'ask'
    if (mode === 'full') return Promise.resolve(true)
    if (mode === 'auto')
      return this.reviewCommands(spec, signal).then((review) => {
        if (review?.decisions.every((row) => row.decision === 'allow')) return true
        return this.waitForApproval(
          {
            ...spec,
            ...(review
              ? { approvalReview: review.decisions.filter((row) => row.decision !== 'allow') }
              : { approvalReviewError: '自动审核未完成，请确认本组命令' })
          },
          signal
        )
      })
    return this.waitForApproval(spec, signal)
  }
  /** 用独立短会话批量审核一组命令，不把审核上下文写入创作对话。 */
  async reviewCommands(spec, signal) {
    try {
      const protocol = this.settings.data.llm
      const cfg = this.settings.credentials(protocol)
      const redact = this.settings.redactor()
      const commands = structuredClone(spec.commands || [spec])
      const session = conversation(protocol, {
        system: reviewSystem,
        history: [{ role: 'user', content: JSON.stringify({ commands }) }],
        tools: [reviewTool],
        model: cfg.model,
        baseUrl: cfg.url,
        maxTokens: 2400
      })
      const raw = await requestModel(session, {
        protocol,
        cfg,
        signal,
        redact,
        responseTimeoutMs: this.settings.data.agent.responseTimeoutSeconds * 1000
      })
      const received = session.receive(raw)
      if (received.calls.length !== 1 || received.calls[0].name !== reviewTool.name) return null
      const input =
        typeof received.calls[0].input === 'string'
          ? JSON.parse(received.calls[0].input)
          : received.calls[0].input
      const decisions = input?.decisions
      if (
        !Array.isArray(decisions) ||
        decisions.length !== commands.length ||
        new Set(decisions.map((row) => row?.index)).size !== commands.length ||
        decisions.some(
          (row, index) =>
            row?.index !== index ||
            !['allow', 'ask', 'deny'].includes(row.decision) ||
            typeof row.reason !== 'string'
        )
      )
        return null
      return { decisions }
    } catch (error) {
      signal.throwIfAborted()
      return null
    }
  }
  /** 审核无法自动放行时，把整组命令一次交给创作者确认。 */
  waitForApproval(spec, signal) {
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
    this.settings = settings
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
