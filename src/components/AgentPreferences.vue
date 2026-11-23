<script setup vapor>
import { ref } from 'vue'
import { ui, api, notify, perform } from '../store.js'
import { agentLimits, maxResponseRetries } from '../../shared/agent-settings.mjs'

const contextThreshold = ref(ui.config.agent.contextThreshold)
const responseTimeoutSeconds = ref(ui.config.agent.responseTimeoutSeconds)
const approvalMode = ref(ui.config.agent.approvalMode || 'auto')

/** 单独保存运行参数，不要求重新填写模型地址或凭据。 */
function save() {
  return perform('正在保存助手设置', async () => {
    ui.config = await api.agentPreferences({
      contextThreshold: Number(contextThreshold.value),
      responseTimeoutSeconds: Number(responseTimeoutSeconds.value),
      approvalMode: approvalMode.value
    })
    notify('助手运行设置已保存')
  })
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <label>
      自动压缩阈值（tokens）
      <input
        v-model="contextThreshold"
        type="number"
        :min="agentLimits.minTokens"
        step="1"
        required
        aria-describedby="agent-context-help"
      />
    </label>
    <p id="agent-context-help" class="hint">
      上下文达到阈值时，当前语言模型会总结较早的对话和工具记录。请为模型的上下文窗口预留回复空间。
    </p>
    <label>
      模型首次响应超时（秒）
      <input
        v-model="responseTimeoutSeconds"
        type="number"
        min="1"
        :max="agentLimits.maxResponseSeconds"
        step="1"
        required
        aria-describedby="agent-response-help"
      />
    </label>
    <p id="agent-response-help" class="hint">
      仅在等待 HTTP 响应头时计时。无响应超时后最多重试
      {{ maxResponseRetries }} 次。收到响应头后，即使暂时没有新文字，也会持续等待。可随时停止。
    </p>
    <label>
      命令审批策略
      <select v-model="approvalMode" aria-describedby="agent-approval-help">
        <option value="auto">帮我批准</option>
        <option value="ask">每次询问</option>
        <option value="full">完全访问权限</option>
      </select>
    </label>
    <p id="agent-approval-help" class="hint">
      帮我批准会用独立审核会话批量检查命令，并自动放行安全操作。请求批准会在外部文件、网络或高风险操作前询问。完全访问权限会直接执行所有命令。
    </p>
    <div class="modal-actions"><button class="primary">保存助手设置</button></div>
  </form>
</template>
