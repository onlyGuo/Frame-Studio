import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fail } from './http.mjs'

/** 使用随包 FFmpeg 读取尺寸，再在子进程内将工程图片编码为供应商需要的 data URL。 */
export async function referenceUrl(reference, { megabytes, minSide = 1, maxRatio = 10 }) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[
    path.extname(reference.path).toLowerCase()
  ]
  if (!mime || (await fs.stat(reference.path)).size > megabytes * 1024 ** 2)
    return fail('submit', 'reference_format')
  const header = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', reference.path], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true
  })
  const match = header.stderr?.match(/Video:[^\r\n]*?\b(\d{1,8})x(\d{1,8})\b/)
  const width = Number(match?.[1]),
    height = Number(match?.[2])
  if (
    !match ||
    Math.min(width, height) < minSide ||
    Math.max(width, height) > 8000 ||
    Math.max(width, height) / Math.min(width, height) > maxRatio
  )
    return fail('submit', 'reference_format')
  return 'data:' + mime + ';base64,' + (await fs.readFile(reference.path)).toString('base64')
}

/** 图号与传入媒体的排序一致，角色卡改名后仍从工程解析出当前名称。 */
export function numberedPrompt(references, prompt) {
  if (!references.length) return prompt
  const mapping = references
    .map((ref, i) => '图' + (i + 1) + '对应' + ref.type + '「' + ref.name + '」')
    .join('，')
  return mapping + '。\n' + prompt
}
