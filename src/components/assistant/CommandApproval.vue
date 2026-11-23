<script setup vapor>
import { computed } from 'vue'
import Glyph from '../Glyph.vue'
import { commandTitle } from '../../../shared/agent-trace.mjs'

const props = defineProps({ approval: { type: Object, required: true }, projectTitle: String })
const emit = defineEmits(['answer'])
const steps = computed(() => props.approval.commands || [props.approval])
const names = {
  provider: '服务',
  mediaKind: '媒体类型',
  model: '模型',
  extension: '产物格式',
  prompt: '提示词',
  shotId: '分镜',
  cardId: '设定卡',
  episodeId: '分集',
  destination: '目标',
  skillId: 'Skill',
  kind: '类型',
  assetFree: '无出场资产',
  duration: '时长',
  regenerate: '重新生成',
  applyEdits: '写入工程变更',
  executionMode: '执行模式',
  approvalRisk: '审批风险'
}

/** 授权时展示完整参数及即将写入的脚本；数组的边界和空参数都能核对。 */
function commandLine(step) {
  if (!step.executable) return ''
  return [step.executable, ...(step.args || [])]
    .map((arg) => (/^[a-z\d_./:=+@\\-]+$/i.test(arg) ? arg : JSON.stringify(arg)))
    .join(' ')
}
function properties(step) {
  return Object.entries(step).filter(
    ([key, value]) =>
      !['id', 'commands', 'continueOnError', 'executable', 'args', 'script', 'skill'].includes(key) &&
      value !== undefined &&
      value !== ''
  )
}
function propertyValue(value) {
  return value === true
    ? '是'
    : value === false
      ? '否'
      : typeof value === 'string'
        ? value === 'low'
          ? '低风险外部操作'
          : value === 'high'
            ? '高风险外部操作'
            : value
        : JSON.stringify(value)
}
</script>
<template>
  <section class="ac-approval" aria-label="命令授权">
    <div class="ac-approval-head">
      <Glyph name="lock" :size="15" />
      <strong>{{ steps.length > 1 ? '请求运行 ' + steps.length + ' 个步骤' : '请求运行本机命令' }}</strong>
    </div>
    <p>
      {{ projectTitle }} · work
      <span v-if="approval.continueOnError">· 失败后继续后续步骤</span>
      <span v-if="approval.executionMode === 'parallel'">· 并行执行</span>
    </p>
    <div v-if="approval.approvalReview?.length" class="ac-approval-review">
      <strong>独立审核建议确认以下命令</strong>
      <ul>
        <li v-for="row in approval.approvalReview" :key="row.index">
          第 {{ row.index + 1 }} 项 · {{ row.reason }}
        </li>
      </ul>
    </div>
    <p v-else-if="approval.approvalReviewError" class="ac-approval-review-error">
      {{ approval.approvalReviewError }}
    </p>
    <ol class="ac-approval-list">
      <li v-for="(step, index) in steps" :key="index">
        <span class="ac-approval-title">{{ commandTitle(step) }}</span>
        <pre v-if="step.executable" class="ac-approval-code">{{ commandLine(step) }}</pre>
        <dl v-if="properties(step).length" class="ac-approval-properties">
          <template v-for="[key, value] in properties(step)" :key="key">
            <dt>{{ names[key] || key }}</dt>
            <dd>{{ propertyValue(value) }}</dd>
          </template>
        </dl>
        <details v-if="step.script" open class="ac-script-preview">
          <summary>写入 {{ step.script.path }}</summary>
          <pre class="ac-approval-code">{{ step.script.content }}</pre>
        </details>
      </li>
    </ol>
    <div class="ac-approval-actions">
      <button class="ac-decline" @click="emit('answer', false)">拒绝</button>
      <button class="ac-allow" @click="emit('answer', true)">允许运行</button>
    </div>
  </section>
</template>
