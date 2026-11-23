/** 所有工程共享上下文阈值、响应等待和命令审批策略。 */
export const agentDefaults = Object.freeze({
  contextThreshold: 270000,
  responseTimeoutSeconds: 300,
  approvalMode: 'auto'
})
export const agentLimits = Object.freeze({ minTokens: 1024, maxResponseSeconds: 2147483 })
export const maxResponseRetries = 5
export const agentApprovalModes = Object.freeze(['auto', 'ask', 'full'])

/** 加载旧配置时补齐默认值；保存时拒绝无效数字，避免静默采用其他阈值。 */
export function agentPreferences(value, { strict = false } = {}) {
  const contextThreshold = value?.contextThreshold
  // 0.4.0 的等待设置保存在 idleTimeoutSeconds，升级时沿用创作者选择的秒数。
  const responseTimeoutSeconds = value?.responseTimeoutSeconds ?? value?.idleTimeoutSeconds
  const approvalMode = value?.approvalMode
  const validTokens = Number.isSafeInteger(contextThreshold) && contextThreshold >= agentLimits.minTokens
  const validResponseTimeout =
    Number.isInteger(responseTimeoutSeconds) &&
    responseTimeoutSeconds > 0 &&
    responseTimeoutSeconds <= agentLimits.maxResponseSeconds
  const validApprovalMode = agentApprovalModes.includes(approvalMode)
  if (strict && !validTokens) throw Error('上下文压缩阈值须为至少 1024 的整数')
  if (strict && !validResponseTimeout)
    throw Error('模型首次响应超时须为 1 至 ' + agentLimits.maxResponseSeconds + ' 之间的整数秒')
  if (strict && !validApprovalMode) throw Error('命令审批策略无效')
  return {
    contextThreshold: validTokens ? contextThreshold : agentDefaults.contextThreshold,
    responseTimeoutSeconds: validResponseTimeout
      ? responseTimeoutSeconds
      : agentDefaults.responseTimeoutSeconds,
    approvalMode: validApprovalMode ? approvalMode : agentDefaults.approvalMode
  }
}
