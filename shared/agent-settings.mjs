/** 所有工程共享上下文阈值与等待 HTTP 响应头的时限。 */
export const agentDefaults = Object.freeze({ contextThreshold: 270000, responseTimeoutSeconds: 300 })
export const agentLimits = Object.freeze({ minTokens: 1024, maxResponseSeconds: 2147483 })
export const maxResponseRetries = 5

/** 加载旧配置时补齐默认值；保存时拒绝无效数字，避免静默采用其他阈值。 */
export function agentPreferences(value, { strict = false } = {}) {
  const contextThreshold = value?.contextThreshold
  // 0.4.0 的等待设置保存在 idleTimeoutSeconds，升级时沿用创作者选择的秒数。
  const responseTimeoutSeconds = value?.responseTimeoutSeconds ?? value?.idleTimeoutSeconds
  const validTokens = Number.isSafeInteger(contextThreshold) && contextThreshold >= agentLimits.minTokens
  const validResponseTimeout =
    Number.isInteger(responseTimeoutSeconds) &&
    responseTimeoutSeconds > 0 &&
    responseTimeoutSeconds <= agentLimits.maxResponseSeconds
  if (strict && !validTokens) throw Error('上下文压缩阈值须为至少 1024 的整数')
  if (strict && !validResponseTimeout)
    throw Error('模型首次响应超时须为 1 至 ' + agentLimits.maxResponseSeconds + ' 之间的整数秒')
  return {
    contextThreshold: validTokens ? contextThreshold : agentDefaults.contextThreshold,
    responseTimeoutSeconds: validResponseTimeout
      ? responseTimeoutSeconds
      : agentDefaults.responseTimeoutSeconds
  }
}
