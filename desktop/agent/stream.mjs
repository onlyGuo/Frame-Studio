/** 从 SSE 任意网络分片重组事件，兼容 LF、CRLF 和多行 data。 */
async function* frames(body) {
  let buffer = '',
    data = []
  const decoder = new TextDecoder()
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '')
      buffer = buffer.slice(i + 1)
      if (!line) {
        if (data.length) yield data.join('\n')
        data = []
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  buffer += decoder.decode()
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart())
  if (data.length) yield data.join('\n')
}

/** 逐段呈现可见文本，直到完整结束事件到达后才允许执行工具。 */
export async function receiveModelResponse(res, protocol, onText) {
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    if (!res.body) throw Error('模型返回了空响应')
    const decoder = new TextDecoder()
    let raw = ''
    for await (const bytes of res.body) {
      raw += decoder.decode(bytes, { stream: true })
    }
    return JSON.parse(raw + decoder.decode())
  }
  let final,
    finished = false,
    reason,
    text = '',
    reasoning = '',
    partial = new Map()
  const calls = [],
    blocks = []
  let usage
  for await (const raw of frames(res.body)) {
    if (raw === '[DONE]') break
    const e = JSON.parse(raw)
    if (e.error || e.type === 'error' || e.type === 'response.failed')
      throw Error('模型流返回错误：' + (e.error?.message || e.response?.error?.message || '请求中止'))
    if (protocol === 'responses') {
      if (e.type === 'response.output_text.delta') onText(e.delta)
      if (e.type === 'response.completed') {
        final = e.response
        finished = true
        break
      }
    } else if (protocol === 'anthropic') {
      if (e.type === 'message_start') usage = e.message?.usage
      if (e.type === 'content_block_start') blocks[e.index] = e.content_block
      if (e.type === 'content_block_delta') {
        const block = blocks[e.index],
          delta = e.delta
        if (delta.type === 'text_delta') {
          block.text += delta.text
          onText(delta.text)
        }
        if (delta.type === 'input_json_delta')
          partial.set(e.index, (partial.get(e.index) || '') + delta.partial_json)
        if (delta.type === 'thinking_delta') block.thinking += delta.thinking
        if (delta.type === 'signature_delta') block.signature = delta.signature
      }
      if (e.type === 'content_block_stop' && partial.has(e.index))
        blocks[e.index].input = JSON.parse(partial.get(e.index))
      if (e.type === 'message_delta') reason = e.delta.stop_reason
      if (e.type === 'message_stop') {
        finished = true
        final = { content: blocks, stop_reason: reason }
        break
      }
    } else {
      if (e.usage) usage = e.usage
      const choice = e.choices?.[0]
      if (!choice) continue
      const delta = choice.delta || {}
      if (delta.content) {
        text += delta.content
        onText(delta.content)
      }
      reasoning += delta.reasoning_content || ''
      for (const chunk of delta.tool_calls || []) {
        const c = (calls[chunk.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
        if (chunk.id) c.id = chunk.id
        c.function.name += chunk.function?.name || ''
        c.function.arguments += chunk.function?.arguments || ''
      }
      if (choice.finish_reason) {
        finished = true
        final = {
          choices: [
            {
              finish_reason: choice.finish_reason,
              message: {
                role: 'assistant',
                content: text,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
                ...(calls.length ? { tool_calls: calls } : {})
              }
            }
          ]
        }
      }
    }
  }
  if (!finished) throw Error('模型连接在回复完成前中断')
  if (usage) final.usage = usage
  return final
}
