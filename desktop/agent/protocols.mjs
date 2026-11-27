/** 每个适配器保留厂商原生工具调用及其 ID，下一轮按原协议关联真实结果。 */
export function conversation(protocol, { system, history, tools = [], model, maxTokens, baseUrl = '' }) {
  const turns = [...history]
  const common = tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  if (protocol === 'chat')
    return {
      turns,
      route: '/chat/completions',
      headers: (key) => ({ Authorization: 'Bearer ' + key }),
      body: () => ({
        model,
        messages: [{ role: 'system', content: system }, ...turns],
        ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
        ...(common.length ? { tools: common.map((fn) => ({ type: 'function', function: fn })) } : {})
      }),
      receive(data) {
        const choice = data.choices?.[0],
          msg = choice?.message
        if (!msg || choice.finish_reason === 'length') throw Error('语言模型输出不完整')
        turns.push(msg)
        return {
          text: msg.content || msg.refusal || '',
          calls: (msg.tool_calls || []).map((c) => ({
            id: c.id,
            name: c.function.name,
            input: c.function.arguments
          }))
        }
      },
      results(items) {
        for (const i of items) turns.push({ role: 'tool', tool_call_id: i.id, content: i.content })
      }
    }
  if (protocol === 'responses')
    return {
      turns,
      route: '/responses',
      headers: (key) => ({ Authorization: 'Bearer ' + key }),
      body: () => ({
        model,
        instructions: system,
        input: turns,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
        ...(common.length ? { tools: common.map((fn) => ({ type: 'function', ...fn, strict: false })) } : {})
      }),
      receive(data) {
        if (!Array.isArray(data.output) || data.status === 'incomplete' || data.status === 'failed')
          throw Error('Responses 返回了未完成结果')
        turns.push(...data.output)
        const text = data.output
          .flatMap((o) => o.content || [])
          .map((b) => b.text || b.refusal || '')
          .join('')
        return {
          text,
          calls: data.output
            .filter((o) => o.type === 'function_call')
            .map((o) => ({ id: o.call_id, name: o.name, input: o.arguments }))
        }
      },
      results(items) {
        for (const i of items) turns.push({ type: 'function_call_output', call_id: i.id, output: i.content })
      }
    }
  if (protocol !== 'anthropic') throw Error('不支持的语言模型协议')
  const isMiMo = /(?:xiaomimimo\.com|mimo\.mi\.com)$/i.test(new URL(baseUrl || 'http://localhost').hostname)
  // MiMo 的 max_tokens 同时计算 thinking 和最终答复，8192 容易在复杂工具回合中截断。
  const defaultMaxTokens = isMiMo ? 131072 : 8192
  return {
    turns,
    route: '/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: () => ({
      model,
      max_tokens: maxTokens || defaultMaxTokens,
      system,
      messages: turns,
      ...(isMiMo ? { thinking: { type: 'enabled' }, tool_choice: { type: 'auto' } } : {}),
      ...(common.length
        ? {
            tools: common.map(({ name, description, parameters }) => ({
              name,
              description,
              input_schema: parameters
            }))
          }
        : {})
    }),
    receive(data) {
      if (!Array.isArray(data.content) || data.stop_reason === 'max_tokens')
        throw Error('Anthropic 返回了未完成结果')
      turns.push({ role: 'assistant', content: data.content })
      return {
        text: data.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
        calls: data.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input }))
      }
    },
    results(items) {
      turns.push({
        role: 'user',
        content: items.map((i) => ({
          type: 'tool_result',
          tool_use_id: i.id,
          content: i.content,
          is_error: i.failed
        }))
      })
    }
  }
}
