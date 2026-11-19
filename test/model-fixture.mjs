import { setTimeout as delay } from 'node:timers/promises'

export const slowQuestion = '逐段说明镜头的开场与收尾。'
export const slowParts = ['雨滴落在窗台，', '镜头移向远处的街灯。']

/** 首次请求故意迟发响应头，重试立即发头，随后分别停顿以检验首字和后续文字。 */
export async function streamSlowReply(res, attempt, firstPartSeen) {
  const frame = (content, finish_reason = null) =>
    'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason }] }) + '\n\n'
  if (attempt === 1) {
    await delay(1500)
    if (!res.destroyed) res.end(JSON.stringify({ error: { message: '首次请求本应已超时' } }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.flushHeaders()
  await delay(1500)
  if (res.destroyed) return
  res.write(frame(slowParts[0]))
  await firstPartSeen
  await delay(1500)
  if (!res.destroyed) res.end(frame(slowParts[1], 'stop') + 'data: [DONE]\n\n')
}

// 根据上一轮真实结果生成下一次调用，从而让“一次生成整份计划”的实现无法通过验收。
export function modelFixture(route, body) {
  const responses = route.endsWith('responses'),
    claude = route.endsWith('messages')
  const turns = responses ? body.input : body.messages
  const results = responses
    ? turns.filter((t) => t.type === 'function_call_output').map((t) => t.output)
    : claude
      ? turns.flatMap((t) =>
          Array.isArray(t.content)
            ? t.content.filter((b) => b.type === 'tool_result').map((b) => b.content)
            : []
        )
      : turns.filter((t) => t.role === 'tool').map((t) => t.content)
  const id = 'call_' + results.length
  let name, args, text
  if (body.model === 'recover') {
    if (!results.length) {
      name = 'read_skill'
      args = { id: 'missing' }
    } else if (results.length === 1 && JSON.parse(results[0]).error) {
      name = 'list_skills'
      args = {}
    } else text = '已找到 ' + JSON.parse(results.at(-1)).length + ' 个可用能力。'
  } else if (body.model === 'fixture-studio' && results.length === 2) {
    name = 'run_command'
    args = { commands: [{ skill: 'image', prompt: '蓝色雨夜' }] }
  } else
    switch (results.length - (body.model === 'fixture-studio' && results.length > 2 ? 1 : 0)) {
      case 0:
        name = 'read_project'
        args = { section: 'overview' }
        break
      case 1: {
        const d = JSON.parse(results[0])
        name = 'edit_project'
        args = {
          actions: [
            {
              op: 'add',
              target: 'shots',
              episodeId: d.episodes[0].id,
              id: 'shot-' + body.model,
              fields: { title: '雨夜', prompt: '灯光照过街道' }
            }
          ]
        }
        break
      }
      case 2:
        name = 'run_command'
        args = {
          commands: [
            {
              executable: 'node',
              args: ['check.mjs'],
              script: { path: 'check.mjs', content: 'console.log(6 * 7)' }
            },
            { executable: 'python', args: ['-I', '-c', 'print(7 * 6)'] }
          ]
        }
        break
      default: {
        const result = JSON.parse(results.at(-1))
        if (
          result.results.length !== 2 ||
          !result.results.every((row) => row.status === 'completed' && row.stdout.trim() === '42')
        )
          throw Error('命令回执缺失')
        text =
          body.model === 'fixture-studio'
            ? '雨夜分镜和参考图已完成，两个本机运行时均已验证。'
            : '已根据工程读取结果创建分镜。命令返回 ' + result.results[1].stdout.trim() + '。'
      }
    }
  const commentary =
    body.model === 'fixture-studio' && name
      ? name === 'read_project'
        ? '我先核对当前分集和已有素材。'
        : name === 'run_command' && args.commands[0].executable
          ? '分镜已就绪，我会检查工程的两个运行时。'
          : null
      : null
  if (responses)
    return {
      status: 'completed',
      output: name
        ? [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
    }
  if (claude)
    return {
      stop_reason: name ? 'tool_use' : 'end_turn',
      content: name ? [{ type: 'tool_use', id, name, input: args }] : [{ type: 'text', text }]
    }
  return {
    choices: [
      {
        finish_reason: name ? 'tool_calls' : 'stop',
        message: name
          ? {
              role: 'assistant',
              content: commentary,
              tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
            }
          : { role: 'assistant', content: text }
      }
    ]
  }
}
