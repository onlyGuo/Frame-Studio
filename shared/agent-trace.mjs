/** 兼容早期执行轨迹里嵌套 JSON 的参数和回执。 */
export function readPayload(value) {
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value)
    } catch {
      break
    }
  }
  return value
}

/** 只统计已落盘的工程修改。 */
export function changeCounts(actions = []) {
  const counts = new Map()
  for (const entry of actions) {
    if (!entry || typeof entry.target !== 'string' || typeof entry.op !== 'string') continue
    const { target, op } = entry
    const key = target + '/' + op
    const row = counts.get(key) || { target, op, count: 0 }
    row.count++
    counts.set(key, row)
  }
  return [...counts.values()]
}

const collections = {
  overview: '工程概览',
  episode: '分集',
  episodes: '分集',
  shots: '分镜',
  shot_assets: '出场资产',
  cards: '设定卡',
  assets: '素材库',
  clips: '剪辑轨',
  audio: '音轨',
  project: '工程设置'
}
const operations = { add: '新建', update: '修改', remove: '移除', move: '调整顺序' }
const mediaNames = { image: '图片', video: '视频', audio: '音频' }
const clean = (text, max = 100) =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const filename = (text) => clean(text).split(/[\\/]/).at(-1)

/** 用程序或脚本名称标识操作。内联代码与参数只在授权界面完整展示。 */
export function commandTitle(spec = {}) {
  if (spec.skill)
    return '运行 ' + (mediaNames[spec.skill] ? mediaNames[spec.skill] + '生成' : clean(spec.skill)) + ' Skill'
  const exe = filename(spec.executable) || '本机命令'
  const filenameArg =
    spec.script?.path ||
    spec.args?.find?.(
      (v) =>
        typeof v === 'string' &&
        !v.startsWith('-') &&
        !/[\s\n]/.test(v) &&
        /\.(?:m?js|cjs|py|sh|ps1|bat)$/i.test(v)
    )
  if (filenameArg) return exe + ' · ' + filename(filenameArg)
  return '运行 ' + exe
}

/** 从原生工具调用提取可展示的动作标题。协议执行器无需理解业务参数。 */
export function traceToolStart(name, input) {
  const args = readPayload(input) || {}
  let steps
  switch (name) {
    case 'run_command':
      steps = (Array.isArray(args.commands) ? args.commands : [args]).map((spec) => ({
        kind: 'command',
        title: commandTitle(spec || {})
      }))
      break
    case 'read_project':
      steps = [{ kind: 'read', title: '读取' + (collections[args.section] || '工程资料') }]
      break
    case 'edit_project':
      steps = Array.isArray(args.actions)
        ? args.actions.map((action) => ({
            kind: 'edit',
            title:
              (operations[action?.op] || '编辑') +
              (collections[action?.target] || '工程') +
              (action?.fields?.title || action?.fields?.name
                ? ' · ' + clean(action.fields.title || action.fields.name)
                : '')
          }))
        : []
      if (!steps.length) steps = [{ kind: 'edit', title: '编辑工程' }]
      break
    case 'list_skills':
      steps = [{ kind: 'skill', title: '查看可用 Skill' }]
      break
    case 'read_skill':
      steps = [{ kind: 'skill', title: '读取 Skill' + (args.id ? ' · ' + clean(args.id) : '') }]
      break
    case 'generate_media':
      steps = [{ kind: 'media', title: '制作' + (mediaNames[args.kind] || '素材') }]
      break
    case 'rough_cut':
      steps = [{ kind: 'edit', title: '按分镜粗剪' }]
      break
    case 'export_episode':
      steps = [{ kind: 'export', title: '导出分集视频' }]
      break
    default:
      steps = [{ kind: 'tool', title: clean(name) || '调用工具' }]
  }
  return { steps }
}

/** 仅将具有工程 ID 的媒体回执投影到会话，避免回显路径和命令输出。 */
export function traceMedia(value) {
  const id = value?.assetId || value?.id
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || !Object.hasOwn(mediaNames, value.kind)) return
  return {
    id,
    kind: value.kind,
    name: clean(value.name, 300),
    model: clean(value.model),
    skill: clean(value.skillId || value.skill),
    shotId: value.shotId
  }
}

/** 把逐命令回执精简为状态；标准输出、标准错误及模型工具结果仅留在执行上下文。 */
export function traceToolResult(name, raw, failed = false) {
  const value = readPayload(raw)
  const commands = name === 'run_command' ? (Array.isArray(value?.results) ? value.results : [value]) : []
  const result = {}
  if (commands.length) {
    result.steps = commands.map((row) => {
      let state =
        row?.status ||
        (failed || row?.executed === false || Number(row?.exitCode || row?.code) > 0 || row?.error
          ? 'failed'
          : 'completed')
      if (!['completed', 'failed', 'skipped', 'cancelled'].includes(state)) state = 'failed'
      let detail = ''
      if (state === 'failed') {
        const code = row?.exitCode ?? row?.code
        detail = Number.isInteger(code) && code !== 0 ? '退出码 ' + code : '执行未成功'
      }
      return { state, ...(detail ? { detail } : {}) }
    })
  }
  const outputs = (name === 'generate_media' ? [value] : commands.map((row) => row?.asset || row))
    .map(traceMedia)
    .filter(Boolean)
  if (outputs.length) result.outputs = outputs
  const changed = name === 'edit_project' ? value?.changed : commands.flatMap((row) => row?.changed || [])
  if (Array.isArray(changed) && changed.length) result.changes = changeCounts(changed)
  if (name === 'rough_cut' && value?.added > 0)
    result.changes = [{ target: 'clips', op: 'add', count: value.added }]
  if (name === 'export_episode' && typeof value?.file === 'string') result.file = filename(value.file)
  if (failed) result.error = name === 'run_command' ? '命令未完成' : clean(value?.error, 180) || '工具未完成'
  return result
}

/** 目录只传耗时、媒体及工程变更计数。当前任务中断也能保留此前完成的产物。 */
export function describeRun(run) {
  const events = run.events || []
  const outputs = new Map(),
    changes = new Map(),
    files = new Set()
  let hasSteps = false
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (
      ['tool', 'result', 'command_step', 'compaction', 'progress'].includes(event.type) ||
      event.phase === 'commentary'
    )
      hasSteps = true
    if (event.type !== 'result' && event.type !== 'command_step') continue
    const legacy =
      event.type === 'result' && event.summary !== undefined
        ? traceToolResult(event.name, event.summary, event.failed)
        : {}
    const media = event.outputs || legacy.outputs || (event.asset ? [event.asset] : [])
    for (const item of media) {
      const asset = traceMedia(item)
      if (asset) outputs.set(asset.id, asset)
    }
    if (event.type !== 'result') continue
    const file = event.file || legacy.file
    if (file) files.add(file)
    for (const row of event.changes || legacy.changes || []) {
      if (
        !row ||
        typeof row.target !== 'string' ||
        typeof row.op !== 'string' ||
        !Number.isSafeInteger(row.count)
      )
        continue
      const key = row.target + '/' + row.op
      const total = changes.get(key) || { target: row.target, op: row.op, count: 0 }
      total.count += row.count
      changes.set(key, total)
    }
  }
  return {
    id: run.id,
    startedAt: run.startedAt || events[0]?.time,
    endedAt: run.endedAt || events.at(-1)?.time,
    status: run.status,
    error: run.error,
    hasSteps,
    outputs: [...outputs.values()],
    changes: [...changes.values()],
    files: [...files]
  }
}
