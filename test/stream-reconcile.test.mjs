import test from 'node:test'
import assert from 'node:assert/strict'
import { receiveModelResponse } from '../desktop/agent/stream.mjs'
import { reconcile } from '../shared/reconcile.mjs'

/** 任意 UTF-8 字节、事件与 CRLF 都可能跨越网络分片。 */
function sse(events) {
  const bytes = new TextEncoder().encode(
    events.map((e) => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join('')
  )
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
        c.close()
      }
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
test('三协议流式文本及完整工具输入', async () => {
  const chat = (d) => ({ choices: [{ delta: d }] })
  const chatEvents = [
    chat({ content: '正在' }),
    chat({ reasoning_content: 'reason' }),
    chat({ tool_calls: [{ index: 0, id: 'call', function: { name: 'edit_project', arguments: '{"x":' } }] }),
    chat({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ]
  let parts = []
  const c = await receiveModelResponse(sse(chatEvents), 'chat', (v) => parts.push(v))
  assert.deepEqual(parts, ['正在'])
  assert.equal(c.choices[0].message.reasoning_content, 'reason')
  assert.equal(c.choices[0].message.tool_calls[0].function.arguments, '{"x":1}')
  const a = await receiveModelResponse(
    sse([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', input: {}, name: 'read', id: 'c1' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"id":3}' }
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'thinking', thinking: '' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'thinking_delta', thinking: '先核对' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'signature_delta', signature: 'sig' }
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 12, cache_read_input_tokens: 8 }
      },
      { type: 'message_stop' }
    ]),
    'anthropic',
    (v) => parts.push(v)
  )
  assert.equal(a.content[1].input.id, 3)
  assert.equal(a.content[2].thinking, '先核对')
  assert.equal(a.content[2].signature, 'sig')
  assert.equal(a.usage.cache_read_input_tokens, 8)
  const final = {
    status: 'completed',
    output: [{ type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' }]
  }
  const r = await receiveModelResponse(
    sse([
      { type: 'response.output_text.delta', delta: '好' },
      { type: 'response.completed', response: final }
    ]),
    'responses',
    (v) => parts.push(v)
  )
  assert.deepEqual(r, final)
  assert.deepEqual(parts, ['正在', '你好', '好'])
  await assert.rejects(
    receiveModelResponse(sse(chatEvents.slice(0, -1)), 'chat', () => {}),
    /中断/
  )
})
test('同项目人工输入和后台修改按实体合并，不回滚新消息与新镜头', () => {
  const base = {
    revision: 1,
    episodes: [{ id: 'e', script: '', shots: [{ id: 's', title: '初稿' }] }],
    messages: []
  }
  const local = structuredClone(base)
  local.episodes[0].script = '剧本'
  local.episodes[0].shots[0].title = '定稿'
  const remote = structuredClone(base)
  remote.revision++
  remote.episodes[0].shots.push({ id: 's2', title: '结尾' })
  remote.messages.push({ id: 'm', text: '完成' })
  const result = reconcile(base, local, remote)
  assert.equal(result.episodes[0].script, '剧本')
  assert.equal(result.episodes[0].shots[0].title, '定稿')
  assert.deepEqual(result.episodes[0].shots[1], remote.episodes[0].shots[1])
  assert.equal(result.revision, 2)
  assert.deepEqual(result.messages, remote.messages)
})
