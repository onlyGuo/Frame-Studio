import { mentionToken, parseMentions } from '../../shared/mentions.mjs'
import { roleOutfit } from '../../shared/outfits.mjs'

export const chipToken = (chip) => mentionToken(chip.dataset.cardId, chip.dataset.outfitId)

/** 用实际选中的服饰显示标签，旧角色引用也能在设置默认服饰后刷新。 */
export function mentionName(part, card) {
  if (!card) return part.id
  const outfit = roleOutfit(card, part.outfitId)
  if (part.outfitId && !outfit) return card.name + ' · 服饰缺失'
  return outfit && (part.outfitId || card.outfits) ? card.name + ' · ' + outfit.name : card.name
}

/** 以工程标记长度计算 DOM 选区；浏览器生成的换行和不可编辑标签均可往返。 */
export function scriptFromDom(parent) {
  let result = ''
  let previousBlock = false
  for (const node of parent.childNodes) {
    const block = node.nodeName === 'DIV' || node.nodeName === 'P'
    if ((block || previousBlock) && result && !result.endsWith('\n')) result += '\n'
    if (node.nodeType === Node.TEXT_NODE) result += node.data
    else if (node.dataset?.cardId) result += chipToken(node)
    else if (node.nodeName === 'BR') result += '\n'
    else result += scriptFromDom(node)
    previousBlock = block
  }
  return result
}

/** 读取相对整个正文的选区位置；工具栏可以在失焦后恢复原来的插入点。 */
export function scriptSelection(editor) {
  const selection = window.getSelection()
  if (!selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.commonAncestorContainer)) return null
  const before = document.createRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  const start = scriptFromDom(before.cloneContents()).length
  const end = start + scriptFromDom(range.cloneContents()).length
  return { start, end }
}

/** 从标记字符串恢复到不可编辑标签边界或真实文本中的光标。 */
export function setScriptSelection(editor, start, end = start) {
  const point = (offset) => {
    let position = 0
    for (const [index, node] of Array.from(editor.childNodes).entries()) {
      const textNode = node.nodeType === Node.TEXT_NODE
      const length = textNode ? node.length : chipToken(node).length
      if (offset <= position + length)
        return textNode ? [node, Math.max(0, offset - position)] : [editor, index + Number(offset > position)]
      position += length
    }
    return [editor, editor.childNodes.length]
  }
  const range = document.createRange()
  range.setStart(...point(start))
  range.setEnd(...point(end))
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 只以文本节点和已知属性构建正文；粘贴内容和资产名不会被当作 HTML。 */
export function paintScript(editor, text, cards) {
  const fragment = document.createDocumentFragment()
  for (const part of parseMentions(text)) {
    if (part.type === 'text') {
      fragment.append(document.createTextNode(part.text))
      continue
    }
    const card = cards.get(part.id)
    const chip = document.createElement('span')
    chip.className = 'mention-chip'
    chip.contentEditable = 'false'
    chip.dataset.cardId = part.id
    if (part.outfitId) chip.dataset.outfitId = part.outfitId
    chip.dataset.kind = card?.type || ''
    const name = mentionName(part, card)
    chip.title = card ? card.type + ' · ' + name + '，点击更换' : '引用已缺失，点击重新选择'
    const type = document.createElement('span')
    type.className = 'mention-chip-type'
    type.textContent = '@ ' + (card?.type || '缺失') + ' · '
    const close = document.createElement('span')
    close.className = 'mention-chip-remove'
    close.dataset.remove = 'true'
    close.textContent = '×'
    close.title = '移除此处引用'
    chip.append(type, document.createTextNode(name), close)
    fragment.append(chip)
  }
  editor.replaceChildren(fragment)
}
