<script>
import MarkdownIt from 'markdown-it'
// 模型输出是文档文本；只生成 Markdown 排版标签，HTML、图片和可导航链接不会进入页面。
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false })
markdown.renderer.rules.link_open = () => ''
markdown.renderer.rules.link_close = () => ''
markdown.renderer.rules.image = (tokens, i) => markdown.utils.escapeHtml(tokens[i].content)
</script>
<script setup vapor>
import { computed } from 'vue'
const props = defineProps({ text: { type: String, default: '' } })
const content = computed(() => markdown.render(props.text))
</script>
<template><div class="ac-prose" v-html="content" /></template>
