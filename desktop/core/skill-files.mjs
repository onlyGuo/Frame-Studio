import fs from 'node:fs'
import path from 'node:path'

/** 返回已启用扩展可引用的包内文件，目录符号链接和隐藏的开发文件不进入指南。 */
export function skillFiles(directory) {
  const files = []
  const pending = ['']
  while (pending.length && files.length < 200) {
    const relative = pending.pop()
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['__pycache__', 'node_modules'].includes(entry.name)) continue
      const name = relative ? relative + '/' + entry.name : entry.name
      if (entry.isFile()) files.push(name)
      else if (entry.isDirectory()) pending.push(name)
      if (files.length === 200) break
    }
  }
  return files.sort()
}
