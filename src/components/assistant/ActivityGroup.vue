<script setup vapor>
import { computed } from 'vue'
import Glyph from '../Glyph.vue'
import { activityGroup } from './transcript.mjs'

const props = defineProps({ calls: { type: Array, required: true } })
const group = computed(() => activityGroup(props.calls))
const statuses = {
  pending: '待执行',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
  skipped: '已跳过'
}
</script>
<template>
  <details class="ac-tool">
    <summary>
      <Glyph :name="group.icon" :size="15" />
      <span>{{ group.title }}</span>
      <span class="ac-operation-count">{{ group.steps.length }} 项</span>
      <small v-if="group.state !== 'done'" :data-state="group.state">{{ statuses[group.state] }}</small>
      <Glyph name="chevron" :size="11" />
    </summary>
    <ol class="ac-action-list" aria-label="本组操作">
      <li v-for="step in group.steps" :key="step.key" :data-state="step.state">
        <Glyph :name="step.icon" :size="14" />
        <span class="ac-action-caption">
          <span>{{ step.title }}</span>
          <small v-if="step.detail">{{ step.detail }}</small>
        </span>
        <span class="ac-action-state">{{ statuses[step.state] }}</span>
      </li>
    </ol>
  </details>
</template>
