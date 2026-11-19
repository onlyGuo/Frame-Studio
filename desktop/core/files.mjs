import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 相同目录内先写入临时文件再替换，读者只能看到完整版本。 */
export function writeJson(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx', flush: true })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
/** 文件必须是位于指定目录内的普通文件，拒绝经符号链接跳转。 */
export function localFile(root, relative) {
  const base = fs.realpathSync(root)
  const target = path.resolve(base, relative)
  if (
    !target.startsWith(base + path.sep) ||
    fs.realpathSync(target) !== target ||
    !fs.statSync(target).isFile()
  )
    throw Error('无效的本地文件')
  return target
}
export function localDir(root, name) {
  const dir = path.join(fs.realpathSync(root), name)
  fs.mkdirSync(dir, { recursive: true })
  if (fs.realpathSync(dir) !== dir) throw Error('目录不能使用符号链接')
  return dir
}
