import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { requestModel } from '../desktop/agent/transport.mjs'
import { conversation } from '../desktop/agent/protocols.mjs'

/** 本机 HTTP 服务独立控制响应头、数据帧和连接关闭，计数包括每一次真实 HTTP 请求。 */
async function endpoint(t, respond, protocol = 'chat') {
  let requests = 0
  const server = http.createServer((req, res) => {
    req.resume()
    respond(req, res, ++requests)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  const cfg = { url: 'http://127.0.0.1:' + server.address().port + '/v1', key: 'local', model: 'fixture' }
  const session = conversation(protocol, { system: '测试', history: [], model: cfg.model })
  return {
    get requests() {
      return requests
    },
    async run(overrides = {}) {
      const raw = await requestModel(session, {
        protocol,
        cfg,
        signal: new AbortController().signal,
        redact: (value) => value,
        responseTimeoutMs: 200,
        retryDelay: async () => {},
        ...overrides
      })
      return session.receive(raw)
    }
  }
}

/** 封装实际提供商事件，允许在任意两个事件之间停顿。 */
function sse(event) {
  return 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n'
}

function chatDelta(content, finish_reason = null) {
  return { choices: [{ delta: { content }, finish_reason }] }
}

const streams = {
  chat: [[chatDelta('上')], [chatDelta('下', 'stop'), '[DONE]']],
  responses: [
    [{ type: 'response.output_text.delta', delta: '上' }],
    [
      { type: 'response.output_text.delta', delta: '下' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '上下' }] }]
        }
      }
    ]
  ],
  anthropic: [
    [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '上' } }
    ],
    [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '下' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' }
    ]
  ]
}

for (const [protocol, [first, last]] of Object.entries(streams)) {
  test(protocol + ' 收到响应头后可以长时间等待首字或下一段文字', async (t) => {
    const service = await endpoint(
      t,
      async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        await delay(320)
        if (res.destroyed) return
        res.write(first.map(sse).join(''))
        await delay(320)
        if (!res.destroyed) res.end(last.map(sse).join(''))
      },
      protocol
    )
    const deltas = []
    const reply = await service.run({ onText: (text) => deltas.push(text) })
    assert.equal(service.requests, 1)
    assert.deepEqual(deltas, ['上', '下'])
    assert.equal(reply.text, '上下')
  })
}

test('连续无响应在首次请求和五次重试后结束', async (t) => {
  const service = await endpoint(t, () => {})
  let retries = 0
  await assert.rejects(
    service.run({
      responseTimeoutMs: 100,
      retryDelay: async () => {
        retries++
      }
    }),
    /超时/
  )
  assert.equal(service.requests, 6)
  assert.equal(retries, 5)
})

test('等待响应头的超时和临时断线共同计入重试，最后一次可以成功', async (t) => {
  const service = await endpoint(t, (req, res, attempt) => {
    if (attempt === 1) return
    if (attempt < 6) {
      req.socket.destroy()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(chatDelta('成功', 'stop')) + sse('[DONE]'))
  })
  assert.equal((await service.run()).text, '成功')
  assert.equal(service.requests, 6)
})

test('Chat 兼容参数协商前后的无响应请求共用五次重试额度', async (t) => {
  const service = await endpoint(t, (req, res, attempt) => {
    if (attempt !== 3) return req.socket.destroy()
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { param: 'stream_options', message: 'Unsupported field' } }))
  })
  const retries = []
  await assert.rejects(service.run({ onRetry: (retry) => retries.push(retry) }), /已重试 5 次/)
  assert.deepEqual(retries, [1, 2, 3, 4, 5])
  assert.equal(service.requests, 7) // 六次建连失败，加一次明确的兼容协商响应。
})

test('服务商明确返回 HTTP 错误时保留原始状态码', async (t) => {
  const service = await endpoint(t, (_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '维护中' } }))
  })
  await assert.rejects(service.run(), /HTTP 503.*维护中/)
  assert.equal(service.requests, 1)
})

test('兼容代理返回的 JSON 在响应头后也可分段慢速读取', async (t) => {
  const service = await endpoint(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"choices":')
    await delay(320)
    if (!res.destroyed) res.end('[{"finish_reason":"stop","message":{"role":"assistant","content":"完成"}}]}')
  })
  assert.equal((await service.run()).text, '完成')
  assert.equal(service.requests, 1)
})

test('已展开部分文字和工具参数的回复意外结束时不会重发', async (t) => {
  const partial = chatDelta('写入中')
  partial.choices[0].delta.tool_calls = [
    {
      index: 0,
      id: 'unfinished',
      type: 'function',
      function: { name: 'sample', arguments: '{"path":' }
    }
  ]
  const service = await endpoint(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse(partial))
  })
  const deltas = []
  await assert.rejects(service.run({ onText: (text) => deltas.push(text) }), /中断/)
  assert.deepEqual(deltas, ['写入中'])
  assert.equal(service.requests, 1)
})

test('正在读取 SSE 时套接字断开，返回中断原因并只显示一次已收到的文字', async (t) => {
  let socket
  const service = await endpoint(t, (req, res) => {
    socket = req.socket
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse(chatDelta('已收到')))
  })
  const deltas = []
  await assert.rejects(
    service.run({
      onText(text) {
        deltas.push(text)
        socket.destroy()
      }
    }),
    /中断|断开/
  )
  assert.deepEqual(deltas, ['已收到'])
  assert.equal(service.requests, 1)
})

test('等待响应头、读取 SSE 或重试退避时，用户均可立即停止', async (t) => {
  for (const phase of ['响应头', 'SSE', '退避']) {
    await t.test(phase, async (t) => {
      const stop = new AbortController()
      const service = await endpoint(t, (req, res) => {
        if (phase === '响应头') return stop.abort()
        if (phase === '退避') return req.socket.destroy()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse(chatDelta('进行中')))
      })
      let retries = 0
      await assert.rejects(
        service.run({
          signal: stop.signal,
          onText: () => stop.abort(),
          async retryDelay(_retry, signal) {
            retries++
            if (phase !== '退避') throw Error('取消后仍发起了重试')
            stop.abort()
            await delay(500, undefined, { signal })
          }
        }),
        { name: 'AbortError' }
      )
      assert.equal(retries, phase === '退避' ? 1 : 0)
      assert.equal(service.requests, 1)
    })
  }
})
