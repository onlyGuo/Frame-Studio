import { estimateTokens, toolRecord } from './context.mjs'
import { requestModel } from './transport.mjs'

/** 每次模型推理前检查上下文；厂商明确拒绝过长的输入时，可提早执行一次模型压缩。 */
async function infer(memory, options, threshold, event) {
  await memory.compact(options, threshold, event)
  let recovered = false
  for (;;) {
    const estimate = estimateTokens(memory.session.body())
    try {
      const response = await requestModel(memory.session, options)
      memory.observeUsage(estimate, response)
      return response
    } catch (err) {
      if (!err.contextLimit || recovered) throw err
      const budget = Math.min(threshold, Math.max(256, Math.floor(memory.inputTokens() / 2)))
      recovered = await memory.compact(options, budget, event, true)
      if (!recovered) throw err
    }
  }
}

/** 通用原生工具循环，只在收到完整的工具调用后执行并配对回传结果。 */
export async function runToolLoop({ memory, runtime, options, threshold, event, append, sanitized }) {
  const { signal, redact } = options
  const completed = new Map()
  for (let round = 1; round <= 48; round++) {
    signal.throwIfAborted()
    event({ type: 'thinking', round })
    const response = await infer(memory, options, threshold, event)
    const session = memory.session
    const start = session.turns.length
    const { text, calls } = session.receive(response)
    if (text) {
      append('assistant', redact(text))
      event({ type: 'message', phase: calls.length ? 'commentary' : 'final', text })
    }
    if (!calls.length) {
      if (!text) throw Error('模型没有返回文本或工具调用')
      return { rounds: round }
    }
    if (
      calls.length > 64 ||
      calls.some((c) => !c.id || !c.name) ||
      new Set(calls.map((c) => c.id)).size !== calls.length
    )
      throw Error('模型工具调用批次无效')
    const results = [],
      transactions = []
    for (const call of calls) {
      signal.throwIfAborted()
      const signature = JSON.stringify([call.name, call.input])
      const previous = completed.get(call.id)
      if (previous) {
        if (previous.signature !== signature) throw Error('模型复用了不同工具调用的编号')
        results.push(previous.result)
        transactions.push(previous.receipt)
        continue
      }
      let args,
        value,
        partialResult,
        failed = false
      try {
        args = typeof call.input === 'string' ? JSON.parse(call.input) : call.input
        event({ type: 'tool', name: call.name, id: call.id, ...runtime.describeCall?.(call.name, args) })
        // 组合工具可逐步登记已生效的工作。仅整个调用结束后才发送厂商协议的最终工具回执。
        const checkpoint = (partial) => {
          const receipt = sanitized({
            id: call.id,
            tool: call.name,
            arguments: args,
            partial: true,
            result: partial
          })
          partialResult = receipt.result
          memory.save(toolRecord(redact(text), [...transactions, receipt]))
        }
        value = await runtime.execute(call.name, args, call.id, checkpoint)
      } catch (err) {
        signal.throwIfAborted()
        if (!args) event({ type: 'tool', name: call.name, id: call.id })
        failed = true
        value = {
          error: err.message,
          ...(partialResult !== undefined ? { partialResult } : {}),
          ...runtime.describeError?.(err)
        }
      }
      const result = { id: call.id, failed, content: JSON.stringify(sanitized(value ?? null)) }
      const receipt = sanitized({
        id: call.id,
        tool: call.name,
        arguments: args ?? call.input,
        failed,
        result: value ?? null
      })
      results.push(result)
      transactions.push(receipt)
      completed.set(call.id, { signature, result, receipt })
      memory.save(toolRecord(redact(text), transactions))
      event({
        type: 'result',
        name: call.name,
        id: call.id,
        failed,
        ...runtime.describeResult?.(call.name, value, failed)
      })
    }
    session.results(results)
    memory.groups.push({ record: toolRecord(redact(text), transactions), native: session.turns.slice(start) })
  }
  throw Error('已达到 48 轮执行上限。已完成的工作保存在工程中，可发送新消息继续')
}
