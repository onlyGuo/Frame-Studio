import { setTimeout as delay } from 'node:timers/promises'
import { Agent, EnvHttpProxyAgent } from 'undici'
import { agentDefaults, maxResponseRetries } from '../../shared/agent-settings.mjs'
import { receiveModelResponse } from './stream.mjs'

// 建连到响应头由工作室统一计时，已建立的模型流可持续等待，含经环境代理的连接。
const Pool = process.env.NODE_USE_ENV_PROXY === '1' ? EnvHttpProxyAgent : Agent
const dispatcher = new Pool({
  connectTimeout: 0,
  headersTimeout: 0,
  bodyTimeout: 0,
  proxyTls: { timeout: 0 },
  requestTls: { timeout: 0 }
})

/** Anthropic 兼容代理可使用 SDK 风格基址、版本基址或完整接口，三个协议分别保留其路由。 */
function endpointFor(protocol, baseUrl, route) {
  const base = baseUrl.replace(/\/+$/, '')
  const pathname = new URL(base).pathname
  if (base.endsWith(route)) return base
  return (
    base +
    (protocol === 'anthropic' && (pathname === '/' || pathname.endsWith('/anthropic')) ? '/v1' : '') +
    route
  )
}

/** 识别服务商的上下文溢出，与模型名、权限错误及普通限流区分。 */
function contextLimit(status, error) {
  return (
    [400, 413, 422].includes(status) &&
    /context_length_exceeded|prompt_too_long|maximum context length|context window|prompt is too long|input is too long|输入.{0,10}超过.{0,8}(长度|限制)/i.test(
      [error?.code, error?.type, error?.message].join(' ')
    )
  )
}

// 一次对话内记住兼容代理的能力，避免每轮重复发送代理已明确拒绝的参数。
const omitStreamUsage = new WeakSet()

const connectionErrors = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH'
])

/** Node 的 fetch 会包装套接字错误，多地址连接失败时还会保留每次连接的原因。 */
function isConnectionError(error) {
  return Boolean(
    error &&
      (connectionErrors.has(error.code) ||
        isConnectionError(error.cause) ||
        (Array.isArray(error.errors) && error.errors.length > 0 && error.errors.every(isConnectionError)))
  )
}

/** 只包住等待最终 HTTP 响应头的阶段。读取正文始终保留用户取消信号。 */
async function openResponse(url, init, signal, responseTimeoutMs) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), responseTimeoutMs)
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([signal, deadline.signal]) })
  } catch (error) {
    signal.throwIfAborted()
    if (!deadline.signal.aborted && !isConnectionError(error)) throw error
    const message = deadline.signal.aborted
      ? '等待语言模型首次响应超时（' + Math.ceil(responseTimeoutMs / 1000) + ' 秒）'
      : '收到语言模型响应前网络连接失败'
    throw Object.assign(new Error(message, { cause: error }), { retryableBeforeHeaders: true })
  } finally {
    clearTimeout(timer)
  }
}

/** 模型未响应时逐步延长重试间隔，退避期间也能立刻停止。 */
function retryDelay(retry, signal) {
  return delay(500 * 2 ** (retry - 1), undefined, { signal })
}

/** 解释提供商明确返回的错误，并保留原生协议协商与上下文压缩的信号。 */
async function providerError(res, url, redact, signal) {
  const detail = await res.json().catch(() => null)
  signal.throwIfAborted()
  const error = detail?.error || detail
  const hint =
    typeof error?.message === 'string' ? redact(error.message).slice(0, 400) : '请检查协议、模型及账户权限'
  return Object.assign(
    Error('语言模型返回 HTTP ' + res.status + ' · ' + new URL(url).pathname + ' · ' + hint),
    {
      status: res.status,
      contextLimit: contextLimit(res.status, error),
      unsupportedStreamUsage:
        [400, 422].includes(res.status) &&
        /stream_options|include_usage/i.test([error?.param, error?.message].join(' '))
    }
  )
}

/** 重试当前推理的同一份请求，收到响应头后离开重试路径，避免重复交付文本或工具调用。 */
export async function requestModel(session, options) {
  const {
    protocol,
    cfg,
    signal,
    redact,
    onText = () => {},
    responseTimeoutMs = agentDefaults.responseTimeoutSeconds * 1000
  } = options
  const url = endpointFor(protocol, cfg.url, session.route)
  const body = { ...session.body(), stream: true }
  if (protocol === 'chat' && !omitStreamUsage.has(cfg)) body.stream_options = { include_usage: true }
  const serialize = () =>
    JSON.stringify(body, (_, value) => (typeof value === 'string' ? redact(value) : value))
  const init = {
    method: 'POST',
    dispatcher,
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...session.headers(cfg.key, cfg.url) },
    body: serialize()
  }
  let retries = 0
  for (;;) {
    signal.throwIfAborted()
    let res
    try {
      res = await openResponse(url, init, signal, responseTimeoutMs)
    } catch (error) {
      signal.throwIfAborted()
      if (!error.retryableBeforeHeaders) throw error
      if (retries >= maxResponseRetries)
        throw new Error(error.message + '。已重试 ' + retries + ' 次，请检查模型服务或网络连接。', {
          cause: error
        })
      retries++
      await (options.retryDelay || retryDelay)(retries, signal)
      signal.throwIfAborted()
      options.onRetry?.(retries, maxResponseRetries)
      continue
    }
    if (!res.ok) {
      const error = await providerError(res, url, redact, signal)
      if (!body.stream_options || !error.unsupportedStreamUsage) throw error
      // 仅在 Chat 兼容代理明确拒绝可选用量字段时重新协商，沿用同一份重试预算。
      omitStreamUsage.add(cfg)
      delete body.stream_options
      init.body = serialize()
      continue
    }
    try {
      return await receiveModelResponse(res, protocol, onText)
    } catch (error) {
      signal.throwIfAborted()
      if (isConnectionError(error)) throw new Error('语言模型的连接在回复完成前断开。', { cause: error })
      throw error
    }
  }
}
