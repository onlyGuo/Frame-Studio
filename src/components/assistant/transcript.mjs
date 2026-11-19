import { traceToolStart, traceToolResult } from '../../../shared/agent-trace.mjs'

/** 将工程中已经落盘的消息按用户轮次分组，历史对话和当前执行共享一种视图。 */
export function groupTurns(messages) {
  const turns = []
  for (const message of messages || []) {
    if (message.role === 'user' || !turns.length) {
      turns.push({ id: message.id, question: message.role === 'user' ? message.text : '', replies: [] })
    }
    if (message.role === 'assistant') turns.at(-1).replies.push(message.text)
  }
  return turns
}

/** 展示与执行器的状态字使用同一映射，旧版轨迹缺少状态时由其结束事件补齐。 */
function stepState(state) {
  return (
    {
      completed: 'done',
      cancelled: 'stopped',
      skipped: 'skipped',
      failed: 'failed',
      running: 'running',
      pending: 'pending'
    }[state] || 'pending'
  )
}

/** 按工具 ID 对齐实时步骤和结束回执。每个压缩里程碑独占一行，可穿插在两段回复之间。 */
export function projectEvents(events, running) {
  const rounds = [],
    calls = new Map()
  let round, compression
  const newRound = (number) => {
    round = {
      key: rounds.length,
      number: number || rounds.length + 1,
      text: '',
      calls: [],
      phase: '',
      progress: '',
      streaming: false
    }
    rounds.push(round)
    return round
  }
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'compaction') {
      if (!compression || event.phase === 'started') compression = newRound()
      compression.compaction = event.phase
      compression.beforeTokens = event.beforeTokens || compression.beforeTokens
      compression.afterTokens = event.afterTokens
      if (event.phase !== 'started') compression = null
      round = null
      continue
    }
    if (event.type === 'thinking') {
      newRound(event.round)
      continue
    }
    if (!round) newRound()
    if (event.type === 'delta') {
      round.text += event.text || ''
      round.streaming = true
    } else if (event.type === 'message') {
      round.text = event.text || ''
      round.phase = event.phase || ''
      round.streaming = false
    } else if (['tool', 'result', 'command_step'].includes(event.type)) {
      let call = calls.get(event.id)
      if (!call) {
        const name = event.name || 'run_command'
        const steps =
          event.type === 'tool' && event.steps?.length
            ? event.steps
            : traceToolStart(name, event.arguments).steps
        const queued = name === 'run_command'
        call = {
          id: event.id,
          name,
          state: 'running',
          steps: steps.map((s) => ({ ...s, state: queued ? 'pending' : 'running' }))
        }
        round.calls.push(call)
        calls.set(call.id, call)
      }
      if (event.type === 'command_step') {
        const step = call.steps[event.index]
        if (step) step.state = stepState(event.status)
      }
      if (event.type === 'result') {
        const receipt =
          event.summary !== undefined ? traceToolResult(event.name, event.summary, event.failed) : event
        call.state = event.failed ? 'failed' : 'done'
        call.steps.forEach((step, i) => {
          const completed = receipt.steps?.[i]
          if (completed) {
            step.state = stepState(completed.state)
            step.detail = completed.detail
          } else if (['running', 'pending'].includes(step.state)) {
            step.state = event.failed && i > 0 ? 'skipped' : call.state
          }
        })
        if (call.steps.some((s) => s.state === 'failed')) call.state = 'failed'
        if (receipt.error && call.steps[0] && !call.steps[0].detail) call.steps[0].detail = receipt.error
      }
    } else if (event.type === 'progress') {
      round.progress = event.text
    }
  }
  if (!running) {
    for (const call of calls.values()) {
      if (call.state === 'running') call.state = 'stopped'
      for (const step of call.steps) {
        if (step.state === 'running') step.state = 'stopped'
        if (step.state === 'pending') step.state = 'skipped'
      }
    }
    if (compression) compression.compaction = 'interrupted'
  }
  return rounds
}

const typeNames = {
  read: ['folder', '读取工程'],
  edit: ['pen', '编辑工程'],
  command: ['terminal', '执行命令'],
  skill: ['skill', '查看 Skill'],
  media: ['media', '制作素材'],
  export: ['film', '导出视频'],
  tool: ['list', '调用工具']
}

/** 同一模型轮次里的读写与命令以一组呈现，展开后按执行顺序列出。 */
export function activityGroup(calls) {
  const steps = calls.flatMap((call) =>
    call.steps.map((step, i) => ({
      ...step,
      key: call.id + '/' + i,
      icon: typeNames[step.kind]?.[0] || 'list'
    }))
  )
  const titles = new Set(steps.map((s) => typeNames[s.kind]?.[1] || '调用工具'))
  const states = steps.map((s) => s.state)
  const state =
    states.includes('running') || states.includes('pending')
      ? 'running'
      : states.includes('failed')
        ? 'failed'
        : states.includes('stopped')
          ? 'stopped'
          : states.length && states.every((s) => s === 'skipped')
            ? 'skipped'
            : 'done'
  return { steps, title: [...titles].join('、'), icon: steps[0]?.icon || 'list', state }
}

/** 历史格式缺少消息阶段时，仅将成功运行的最后一个纯文本轮次识别为最终回答。 */
export function splitSteps(events, status) {
  const rounds = projectEvents(events, status === 'running')
  const last = rounds.at(-1)
  const final = last?.phase === 'final' || (status === 'completed' && last?.text && !last.calls.length)
  return {
    rounds: final ? rounds.slice(0, -1) : rounds,
    finalText: final ? last.text : ''
  }
}

/** 使用执行器记录的起止时间，完成的任务在重开工程后仍有相同用时。 */
export function elapsedText(start, end) {
  const diff = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(diff)) return ''
  const seconds = Math.max(0, Math.floor(diff / 1000))
  if (seconds < 1) return '不到 1 秒'
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor(seconds / 60) % 60
  return [hours && hours + ' 小时', minutes && minutes + ' 分钟', (seconds % 60) + ' 秒']
    .filter(Boolean)
    .join(' ')
}
