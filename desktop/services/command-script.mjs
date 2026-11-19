import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { localDir, localFile } from '../core/files.mjs'
import { validWorkPath } from '../core/work-path.mjs'
import { applyPlan } from '../../shared/plan.mjs'

/** 脚本路径相对于 work/，可随工程归档；源码与写入意图均随命令授权展示。 */
export function validateScript(script) {
  if (
    !script ||
    typeof script.path !== 'string' ||
    !validWorkPath('work/' + script.path) ||
    typeof script.content !== 'string' ||
    script.content.length > 250000 ||
    (script.overwrite !== undefined && typeof script.overwrite !== 'boolean')
  ) {
    throw Error('脚本需要可移植的相对路径和源码（最多 250000 字符）')
  }
}

/** 逐层验证目录，脚本重试可复用相同源码，覆盖既有代码需要在请求中声明。 */
export function writeWorkScript(work, script) {
  validateScript(script)
  const parts = script.path.split('/')
  const name = parts.pop()
  const directory = parts.reduce((parent, part) => localDir(parent, part), work)
  const output = path.join(directory, name)
  if (fs.lstatSync(output, { throwIfNoEntry: false })) {
    localFile(directory, name)
    if (
      fs.statSync(output).size === Buffer.byteLength(script.content) &&
      fs.readFileSync(output, 'utf8') === script.content
    )
      return
    if (!script.overwrite) throw Error('脚本已存在。请使用新文件名，或声明 script.overwrite=true 替换源码。')
    const temporary = path.join(directory, '.script-' + randomUUID())
    try {
      fs.writeFileSync(temporary, script.content, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, output)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  } else fs.writeFileSync(output, script.content, { flag: 'wx', mode: 0o600 })
}

/** 建立单次命令的制作资料快照，保持原工程清单独立于脚本文件操作。 */
export function writeScriptSnapshot(directory, projectData, redact) {
  const { messages, ...production } = projectData
  const filename = path.join(directory, 'project.json')
  const text = JSON.stringify(production, (_, value) =>
    typeof value === 'string' && redact ? redact(value) : value
  )
  fs.writeFileSync(filename, text, { flag: 'wx', mode: 0o400 })
  return filename
}

/** 只读取本次命令临时目录中的操作清单，拒绝路径替换、过大的计划及格式错误。 */
export function readScriptEdits(directory, episodeId) {
  if (!fs.existsSync(path.join(directory, 'edits.json'))) throw Error('脚本未将工程变更写入 STUDIO_EDITS')
  const file = localFile(directory, 'edits.json')
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw Error('脚本生成的工程变更超过 2 MiB')
  const actions = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(actions)) throw Error('STUDIO_EDITS 文件必须包含 edit_project 的 actions 数组')
  return actions.map((action) => ({ ...action, episodeId: action.episodeId || episodeId }))
}

/** 在最新工程上应用事务。编辑中碰到同一对象的人工更改时交回模型重新读取；其他对象可并行修改。 */
export function applyScriptEdits(base, draft, actions) {
  const list = (doc, action) =>
    ['cards', 'episodes'].includes(action.target)
      ? doc[action.target]
      : doc.episodes.find((ep) => ep.id === action.episodeId)?.[action.target]
  const conflict = () => {
    throw Error('脚本运行期间目标已被修改。请重新读取工程后生成新的变更清单。')
  }
  if (base.revision !== draft.revision) {
    for (const action of actions) {
      if (action.target === 'project') {
        if (Object.keys(action.fields || {}).some((key) => !isDeepStrictEqual(base[key], draft[key])))
          conflict()
        continue
      }
      const before = list(base, action)
      const now = list(draft, action)
      if (Boolean(before) !== Boolean(now)) conflict()
      if (!Array.isArray(before) || !Array.isArray(now)) continue
      if (
        (action.op === 'move' || action.index !== undefined) &&
        !isDeepStrictEqual(
          before.map((row) => row.id),
          now.map((row) => row.id)
        )
      )
        conflict()
      if (
        !isDeepStrictEqual(
          before.find((row) => row.id === action.id),
          now.find((row) => row.id === action.id)
        )
      )
        conflict()
    }
  }
  return applyPlan(draft, actions)
}
