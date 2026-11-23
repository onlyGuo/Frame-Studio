<script>
import MarkdownIt from 'markdown-it'
import { mentionName } from '../../editor/mention-dom.mjs'
// 只解析 Markdown，禁用原始 HTML。MarkdownIt 自带协议校验，会拒绝 javascript 等危险地址。
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
const mentionPattern = /^@\{card:([A-Za-z0-9_-]{1,80})(?::([A-Za-z0-9_-]{1,80}))?\}/
const mentionPatternGlobal = /@\{card:([A-Za-z0-9_-]{1,80})(?::([A-Za-z0-9_-]{1,80}))?\}/g
const mentionMarker = (index) => 'FRAMEASSETMENTION' + index + 'X'
function mentionMarkup(part, cards) {
  const card = cards.get(part.id)
  const type = card?.type || '缺失'
  const name = mentionName(part, card)
  const title = card ? type + ' · ' + name : '引用已缺失 · ' + part.id
  const escape = markdown.utils.escapeHtml
  return `<span class="mention-chip assistant-mention" data-card-id="${escape(part.id)}" data-kind="${escape(type)}" title="${escape(title)}"><span class="mention-chip-type">@ ${escape(type)} · </span>${escape(name)}</span>`
}
markdown.inline.ruler.before('text', 'asset_mention', (state, silent) => {
  const match = mentionPattern.exec(state.src.slice(state.pos))
  if (!match) return false
  if (silent) return true
  const token = state.push('asset_mention', 'span', 0)
  token.meta = { id: match[1], outfitId: match[2] }
  state.pos += match[0].length
  return true
})
markdown.renderer.rules.asset_mention = (tokens, index, options, env) => {
  const token = tokens[index]
  const part = token.meta || {}
  return mentionMarkup(part, env?.cards || new Map())
}
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, index, options)
}
</script>
<script setup vapor>
import { computed } from 'vue'
const props = defineProps({
  text: { type: String, default: '' },
  cards: { type: Array, default: () => [] }
})
const content = computed(() => {
  const cards = new Map(props.cards.map((card) => [card.id, card]))
  const mentions = []
  const source = props.text.replace(mentionPatternGlobal, (_, id, outfitId) => {
    const index = mentions.push(mentionMarkup({ id, outfitId }, cards)) - 1
    return mentionMarker(index)
  })
  let html = markdown.render(source, { cards })
  mentions.forEach((markup, index) => {
    html = html.replaceAll(mentionMarker(index), markup)
  })
  return html
})
</script>
<template><div class="ac-prose" v-html="content" /></template>
