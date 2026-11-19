/** 支持常见中英文场记、场次号和 Markdown 标题；普通剧本按空行划分段落。 */
const heading =
  /^(?:#{1,6}\s+|第[零〇一二三四五六七八九十百千\d]+场(?:景)?(?:\s|[：:·.、—-]|$)|场(?:景|次)\s*[零〇一二三四五六七八九十百千\d]+|(?:内|外|内\/外|内外)景\b|(?:内|外|内\/外|内外)景(?:\s|[：:.·、—-]|$)|(?:INT\.?\/EXT|INT|EXT|I\/E)\.(?:\s|$)|\d+[-－]\d+(?:\s|[.、：:]|$))/i

export function screenplayOutline(script) {
  const scenes = [],
    paragraphs = []
  let offset = 0,
    newParagraph = true,
    lineNumber = 1
  for (const line of script.split('\n')) {
    const title = line.trim()
    if (title) {
      const row = { title: title.slice(0, 70), offset: offset + line.indexOf(title), line: lineNumber }
      if (heading.test(title)) scenes.push(row)
      if (newParagraph) paragraphs.push(row)
    }
    newParagraph = !title
    offset += line.length + 1
    lineNumber++
  }
  return scenes.length ? { label: '场景', rows: scenes } : { label: '段落', rows: paragraphs }
}
