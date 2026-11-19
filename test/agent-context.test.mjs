import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgent } from '../desktop/services/agent.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { loadHistory } from '../desktop/services/conversation-store.mjs'
import { estimateTokens, reportedInput } from '../desktop/agent/context.mjs'
import { requestModel } from '../desktop/agent/transport.mjs'
import { conversation } from '../desktop/agent/protocols.mjs'

/** 为每一种协议构造供应商的真实工具调用格式。正文中的结构化外观不会创建工具调用。 */
function reply(protocol, text, tool = false) {
  const args = { value: 'test' }
  if (protocol === 'chat')
    return {
      choices: [
        {
          finish_reason: tool ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: text,
            ...(tool
              ? {
                  tool_calls: [
                    {
                      id: 'receipt-a',
                      type: 'function',
                      function: { name: 'sample', arguments: JSON.stringify(args) }
                    }
                  ]
                }
              : {})
          }
        }
      ],
      usage: { prompt_tokens: 1130 }
    }
  if (protocol === 'responses')
    return {
      status: 'completed',
      output: tool
        ? [{ type: 'function_call', name: 'sample', call_id: 'receipt-a', arguments: JSON.stringify(args) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 1130 }
    }
  return {
    stop_reason: tool ? 'tool_use' : 'end_turn',
    content: tool
      ? [{ type: 'tool_use', id: 'receipt-a', name: 'sample', input: args }]
      : [{ type: 'text', text }],
    usage: { input_tokens: 100, cache_read_input_tokens: 1030 }
  }
}

async function fixture(t, protocol) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-context-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const project = Project.create(dir, '压缩', '16:9')
  const original = '此前的用户偏好保留蓝色。'.repeat(40)
  project.save({ ...project.data, messages: [{ id: 'before', role: 'user', text: original }] })
  const events = [],
    executed = []
  const ctx = {
    project,
    signal: new AbortController().signal,
    event: (e) => events.push(e),
    settings: {
      data: { llm: protocol, agent: { contextThreshold: 1024, responseTimeoutSeconds: 10 } },
      credentials: () => ({ url: 'https://example.invalid/v1', key: 'key', model: 'fixture' }),
      redactor: () => (s) => s.replaceAll('private-value', '[隐藏]')
    },
    runtime: () => ({
      system: '你是通用助手。',
      tools: [{ name: 'sample', description: '测试工具', parameters: { type: 'object' } }],
      execute: async (_name, input) => {
        executed.push(input)
        return { outcome: '执行回执777', note: 'private-value' }
      }
    })
  }
  return { ctx, events, executed, original, dir }
}

for (const protocol of ['chat', 'responses', 'anthropic']) {
  test(protocol + ' 按实际用量触发模型压缩，保留本轮目标和配对回执，重开和归档后可继续', async (t) => {
    const { ctx, events, executed, original, dir } = await fixture(t, protocol)
    const question = '接着制作，请只执行一次。'
    let steps = 0,
      compact = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body)
      const raw = JSON.stringify(body)
      assert.ok(!raw.includes('private-value'))
      if (!body.tools) {
        compact++
        assert.ok(raw.includes('蓝色') || raw.includes('已有摘要'))
        return Response.json(reply(protocol, '用户定稿使用蓝色。'))
      }
      if (steps++ === 0) return Response.json(reply(protocol, '', true))
      const turns = body.messages || body.input
      assert.ok(turns.some((m) => m.role === 'user' && m.content === question))
      assert.ok(raw.includes('定稿使用蓝色') && !raw.includes(original))
      assert.ok(raw.includes('执行回执777'))
      const native =
        protocol === 'responses'
          ? turns.filter((m) => m.type === 'function_call_output').map((m) => m.call_id)
          : protocol === 'chat'
            ? turns.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
            : turns.flatMap((m) =>
                Array.isArray(m.content)
                  ? m.content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id)
                  : []
              )
      assert.deepEqual(native, ['receipt-a'])
      return Response.json(reply(protocol, '{"tool":"sample","arguments":{}}'))
    })
    await runAgent(ctx, question)
    assert.equal(executed.length, 1)
    assert.equal(steps, 2)
    assert.ok(compact >= 1)
    assert.deepEqual(
      events.filter((e) => e.type === 'compaction').map((e) => e.phase),
      ['started', 'completed']
    )
    const pack = path.join(dir, 'context.framepack')
    await ctx.project.archive(pack)
    const restored = await Project.restore(pack, dir)
    for (const p of [Project.open(ctx.project.root), restored]) {
      const saved = JSON.stringify(loadHistory(p))
      assert.ok(saved.includes('执行回执777') && saved.includes('定稿使用蓝色') && saved.includes(question))
      assert.ok(!saved.includes('private-value') && !saved.includes(original))
    }
  })
}

test('模型上下文比配置小会分段汇总并重试，保留超长工具尾部数据', async (t) => {
  const { ctx, events } = await fixture(t, 'chat')
  const long = '中文材料'.repeat(1400) + '最后的素材编号314'
  ctx.project.save({ ...ctx.project.data, messages: [{ id: 'past', role: 'assistant', text: long }] })
  ctx.settings.data.agent.contextThreshold = 270000
  let ordinary = 0,
    rejected = 0,
    summaries = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const b = JSON.parse(init.body),
      raw = JSON.stringify(b)
    if ((b.tools && ++ordinary === 1) || (!b.tools && estimateTokens(raw) > 1400)) {
      rejected++
      return Response.json(
        { error: { code: 'context_length_exceeded', message: 'too many tokens' } },
        { status: 400 }
      )
    }
    if (!b.tools) {
      summaries++
      return Response.json(
        reply('chat', raw.includes('最后的素材编号314') ? '素材编号314已归档' : '此前材料已读')
      )
    }
    assert.ok(raw.includes('素材编号314已归档'))
    return Response.json(reply('chat', '完成'))
  })
  await runAgent(ctx, '继续处理')
  assert.ok(summaries > 1 && rejected > 1)
  assert.equal(ordinary, 2)
  assert.ok(events.some((e) => e.phase === 'completed'))
})

test('Anthropic 输入用量包含读取与写入缓存的 token', () => {
  assert.equal(
    reportedInput(
      { usage: { input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 4 } },
      'anthropic'
    ),
    14
  )
})

test('工具完成后的下一轮模型请求重试时，沿用原生回执且只执行一次工具', async (t) => {
  const { ctx, executed, events } = await fixture(t, 'chat')
  ctx.settings.data.agent.contextThreshold = 270000
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) return Response.json(reply('chat', '', true))
    if (bodies.length === 2) {
      const cause = Object.assign(new Error('连接已重置'), { code: 'ECONNRESET' })
      throw new TypeError('fetch failed', { cause })
    }
    return Response.json(reply('chat', '已完成'))
  })
  await runAgent(ctx, '执行一次后汇报')
  assert.equal(bodies.length, 3)
  assert.deepEqual(bodies[1], bodies[2])
  const receipt = bodies[2].messages.find((turn) => turn.role === 'tool')
  assert.equal(receipt.tool_call_id, 'receipt-a')
  assert.match(receipt.content, /执行回执777/)
  assert.deepEqual(executed, [{ value: 'test' }])
  assert.equal(events.filter((event) => event.type === 'result').length, 1)
})

test('命令组第一步完成后取消，重开工程仍能读取部分回执继续剩余步骤', async (t) => {
  const { ctx } = await fixture(t, 'chat')
  ctx.settings.data.agent.contextThreshold = 270000
  const stop = new AbortController()
  ctx.signal = stop.signal
  const actions = []
  ctx.runtime = () => ({
    system: '继续已完成的操作，避免重复执行。',
    tools: [{ name: 'sample', description: '执行一组步骤', parameters: { type: 'object' } }],
    async execute(_name, { remaining }, _id, checkpoint) {
      for (const action of remaining) {
        actions.push(action)
        await checkpoint({ completed: [...actions], receipt: 'record-123' })
        if (action === '生成定稿图') {
          stop.abort()
          stop.signal.throwIfAborted()
        }
      }
      return { completed: remaining }
    }
  })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    const response = reply('chat', '', true)
    const call = response.choices[0].message.tool_calls[0]
    if (requests++ === 0) {
      call.function.arguments = JSON.stringify({ remaining: ['生成定稿图', '编排分镜'] })
    } else if (!body.messages.some((m) => m.role === 'tool')) {
      const partial = body.messages.find(
        (m) => m.role === 'assistant' && m.content.includes('record-123')
      ).content
      const [receipt] = JSON.parse(partial.split('\n').at(-1))
      assert.equal(receipt.partial, true)
      assert.deepEqual(receipt.result.completed, ['生成定稿图'])
      call.function.arguments = JSON.stringify({ remaining: ['编排分镜'] })
    } else return Response.json(reply('chat', '已续作'))
    return Response.json(response)
  })
  await assert.rejects(runAgent(ctx, '生成后编排'), /已停止/)
  await runAgent(
    { ...ctx, project: Project.open(ctx.project.root), signal: new AbortController().signal },
    '从中断处继续'
  )
  assert.deepEqual(actions, ['生成定稿图', '编排分镜'])
  assert.equal(requests, 3)
})

test('Chat 请求流式用量，遇到拒绝该可选字段的兼容代理只协商一次', async (t) => {
  const session = conversation('chat', { system: 's', history: [], model: 'x' })
  const options = {
    protocol: 'chat',
    cfg: { url: 'https://example.invalid/v1', key: 'x' },
    signal: new AbortController().signal,
    redact: (s) => s,
    responseTimeoutMs: 1000
  }
  const flags = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const sendsUsage = JSON.parse(init.body).stream_options?.include_usage === true
    flags.push(sendsUsage)
    if (sendsUsage)
      return Response.json({ error: { message: 'Unsupported field: stream_options' } }, { status: 400 })
    const frames = [
      { choices: [{ delta: { content: '成功' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 723 } },
      '[DONE]'
    ]
    return new Response(
      frames.map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n').join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  })
  assert.equal((await requestModel(session, options)).usage.prompt_tokens, 723)
  assert.equal((await requestModel(session, options)).choices[0].message.content, '成功')
  assert.deepEqual(flags, [true, false, false])
})

test('升级前的超时轨迹与损坏的可选上下文均可重建，只恢复最近一次可确认的调用', async (t) => {
  const { ctx } = await fixture(t, 'chat')
  const project = ctx.project
  project.save({
    ...project.data,
    messages: [
      { id: 'early', role: 'user', text: '草稿' },
      { id: 'task', role: 'user', text: '完成本镜' },
      { id: 'timeout', role: 'assistant', text: 'The operation was aborted due to timeout' }
    ]
  })
  for (const [id, value] of [
    ['early', '很早的执行明细'],
    ['task', '真实生成的素材编号011']
  ])
    project.runs.save({
      id,
      status: 'failed',
      events: [
        { type: 'tool', id: 'call1', name: 'generate_media', arguments: '{}' },
        { type: 'result', id: 'call1', name: 'generate_media', summary: value },
        { type: 'tool', id: 'call2', name: '未完成工具' }
      ]
    })
  for (const broken of [false, true]) {
    if (broken) await fs.writeFile(path.join(project.root, 'agent-context.json'), '{半个文件')
    const history = JSON.stringify(loadHistory(Project.open(project.root)))
    assert.ok(history.includes('真实生成的素材编号011') && history.includes('长参数和输出的开头'))
    assert.ok(!history.includes('很早的执行明细') && !history.includes('未完成工具'))
  }
})
