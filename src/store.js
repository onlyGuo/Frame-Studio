import { computed, nextTick, reactive, shallowRef } from 'vue'
import { reconcile } from '../shared/reconcile.mjs'
import { validateProject } from '../shared/model.mjs'
export const api = window.studio
export const doc = shallowRef(null)
export const ui = reactive({
  page: 'home',
  modal: '',
  agent: false,
  session: '',
  root: '',
  episodeId: '',
  focusCardId: '',
  offlineImageIds: [],
  shotId: '',
  busy: '',
  canCancel: false,
  error: '',
  notice: '',
  saved: '',
  recent: [],
  skills: [],
  config: null,
  generation: null,
  agentTask: null,
  videoBatch: null,
  agentRunning: false,
  agentEvents: [],
  exported: ''
})
export const episode = computed(
  () => doc.value?.episodes.find((e) => e.id === ui.episodeId) || doc.value?.episodes[0]
)
export const asset = (id) => doc.value?.assets.find((a) => a.id === id)
/** 在素材所属的工程会话内生成预览 URL。 */
export const media = (id, session = ui.session) =>
  id && session ? 'studio-media://' + session + '/' + id : ''
const past = [],
  future = []
export const history = reactive({ back: 0, forward: 0 })
let timer,
  pending = false,
  saving = null,
  baseDoc = null,
  delayedState = null
function counts() {
  history.back = past.length
  history.forward = future.length
}
export function error(err) {
  ui.error = errorMessage(err)
}
/** 提取桌面主进程返回的用户提示，供窗口和局部对话框共同使用。 */
export function errorMessage(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
export function notify(text) {
  ui.notice = text
  setTimeout(() => {
    if (ui.notice === text) ui.notice = ''
  }, 4500)
}
/** 每次修改生成独立快照，支持撤销、重做和有序落盘。 */
export function edit(change) {
  try {
    const draft = structuredClone(doc.value)
    change(draft)
    validateProject(draft)
    past.push(doc.value)
    if (past.length > 60) past.shift()
    future.length = 0
    counts()
    changed(draft)
    return true
  } catch (err) {
    error(err)
    return false
  }
}
export function editEpisode(change) {
  const id = episode.value.id
  return edit((d) => change(d.episodes.find((e) => e.id === id)))
}
function changed(draft) {
  doc.value = draft
  pending = true
  ui.saved = '待保存'
  clearTimeout(timer)
  timer = setTimeout(() => flush().catch(error), 350)
}
export function travel(forward = false) {
  const from = forward ? future : past,
    to = forward ? past : future
  if (from.length) {
    to.push(doc.value)
    changed(from.pop())
    counts()
  }
}
/** 保证切换项目、生成、导出和关闭窗口前所有编辑写入同一版本。 */
export async function flush() {
  clearTimeout(timer)
  if (saving) await saving
  if (!pending || !doc.value) return
  pending = false
  const sent = doc.value
  const base = baseDoc
  ui.saved = '保存中'
  saving = api
    .save({ session: ui.session, data: { ...sent, revision: base.revision }, base })
    .then((state) => {
      // 等待 IPC 期间仍可继续键入。按确认的版本重新应用未提交输入。
      const newest =
        delayedState?.session === state.session && delayedState.data.revision > state.data.revision
          ? delayedState
          : state
      delayedState = null
      const merged = validateProject(reconcile(sent, doc.value, newest.data))
      const external =
        JSON.stringify({ ...sent, revision: 0 }) !== JSON.stringify({ ...newest.data, revision: 0 })
      if (external) {
        past.length = future.length = 0
        counts()
      }
      baseDoc = newest.data
      ui.offlineImageIds = newest.offlineImageIds || []
      doc.value = merged
      ui.saved = '已保存至本地'
    })
    .catch((err) => {
      pending = true
      ui.saved = '保存失败'
      throw err
    })
    .finally(() => (saving = null))
  await saving
  if (pending) await flush()
}
export function accept(state, reset = false) {
  if (!state) return
  const switched = ui.session !== state.session
  if (!switched && baseDoc && state.data.revision < baseDoc.revision) return
  doc.value = state.data
  baseDoc = state.data
  delayedState = null
  pending = false
  ui.root = state.root
  ui.session = state.session
  ui.offlineImageIds = state.offlineImageIds || []
  ui.saved = '已保存至本地'
  if (switched || reset) {
    past.length = future.length = 0
    counts()
  }
  if (switched) {
    ui.page = 'overview'
    ui.episodeId = state.data.episodes[0].id
    ui.shotId = ''
    ui.modal = ''
    ui.agentEvents = state.activity || []
    ui.exported = ''
  }
}
export async function perform(label, action, cancel = false) {
  if (ui.busy) return
  ui.busy = label
  ui.canCancel = cancel
  ui.error = ''
  try {
    await flush()
    return await action()
  } catch (err) {
    error(err)
  } finally {
    ui.busy = ''
    ui.canCancel = false
  }
}
export async function openProject(method, payload) {
  await perform('正在打开工程', async () => {
    const result = await api[method](payload)
    if (result) accept(result)
  })
}
export async function home() {
  await perform('正在关闭工程', async () => {
    ui.recent = await api.closeProject()
    ui.page = 'home'
    // 先卸载仍在监听分集的工作区，再释放工程快照。
    await nextTick()
    doc.value = null
    baseDoc = delayedState = null
    pending = false
    past.length = future.length = 0
    counts()
    ui.session = ''
    ui.root = ''
    ui.episodeId = ''
    ui.shotId = ''
    ui.focusCardId = ''
    ui.offlineImageIds = []
    ui.agentEvents = []
  })
}
export async function importMedia(kind) {
  return perform('正在导入素材', async () => {
    const result = await api.addMedia({ session: ui.session, kind: kind === 'image' ? kind : undefined })
    if (result) {
      accept(result, true)
      notify('素材已加入工程')
      const imported = new Set(result.importedIds)
      return result.data.assets.filter((item) => imported.has(item.id))
    }
  })
}
/** 上传时由主进程将样音导入和角色绑定原子提交。 */
export async function uploadVoice(cardId) {
  return perform('正在导入角色样音', async () => {
    const result = await api.addMedia({ session: ui.session, cardId })
    if (result) {
      accept(result, true)
      notify(result.warning || '样音已绑定至角色卡')
    }
  })
}
/** 保留目标分集与分镜，使生成弹窗能够准确显示即将制作的内容。 */
export function generate(prompt = '', shotId = '', cardId = '', kind = '', outfitId) {
  ui.generation = { prompt, shotId, cardId, kind, outfitId, episodeId: episode.value.id }
  ui.modal = 'generate'
}
export async function runGeneration(g) {
  const result = await api.runSkill({
    session: ui.session,
    id: g.skillId,
    episodeId: g.episodeId,
    shotId: g.shotId,
    cardId: g.cardId,
    outfitId: g.outfitId,
    destination: g.destination,
    assetFree: g.assetFree,
    prompt: g.prompt,
    sampleText: g.sampleText,
    voiceId: g.voiceId,
    duration: g.duration
  })
  accept(result.state, true)
  return result
}
/** 合并来自同一工程的后台修改，项目切换后只更新全局对话卡。 */
function backgroundState(state) {
  if (!state || ui.session !== state.session || (baseDoc && state.data.revision <= baseDoc.revision)) return
  if (saving) {
    delayedState = state
    return
  }
  try {
    const merged = pending ? validateProject(reconcile(baseDoc, doc.value, state.data)) : state.data
    doc.value = merged
    baseDoc = state.data
    ui.offlineImageIds = state.offlineImageIds || []
    past.length = future.length = 0
    counts()
  } catch (err) {
    error(err)
  }
}
export function setAgent(task) {
  ui.agentTask = task
  ui.agentRunning = task?.status === 'running'
}
/** 批量视频更新只合并发起工程的内容，其它工程仅显示进度。 */
export function videoBatchUpdate({ task, state }) {
  ui.videoBatch = task
  backgroundState(state)
  if (task.status === 'failed') error(task.shotTitle + ' · ' + task.error)
  else if (task.status !== 'running')
    notify(
      task.episodeTitle +
        (task.status === 'cancelled' ? ' · 已停止，' : ' · ') +
        '已生成 ' +
        task.done +
        ' 个镜头'
    )
}
export function agentUpdate(update) {
  if (ui.agentTask && update.sequence <= ui.agentTask.sequence) return
  if (update.type === 'started') {
    setAgent(update.task)
    return
  }
  if ((update.id ?? update.task?.id) !== ui.agentTask?.id || !ui.agentTask) return
  ui.agentTask.sequence = update.sequence
  if (update.type === 'approval') {
    ui.agentTask.approval = update.approval
    if (update.approval && !ui.agent) notify(ui.agentTask.title + ' · 助手正在等待命令授权')
    return
  }
  if (update.type === 'activity') {
    const events = ui.agentTask.events
    if (update.row.type === 'delta' && events.at(-1)?.type === 'delta') events.at(-1).text += update.row.text
    else {
      if (update.row.type === 'message' && events.at(-1)?.type === 'delta') events.pop()
      events.push(update.row)
    }
  } else if (update.type === 'finished') {
    setAgent(update.task)
    if (update.task.status === 'failed') error(update.task.error)
    else
      notify(update.task.title + ' · ' + (update.task.status === 'cancelled' ? '助手已停止' : '助手已完成'))
    if (ui.root === update.task.root) ui.agentEvents = update.task.events
  }
  backgroundState(update.state)
}
export function answerAgentApproval(allowed) {
  const task = ui.agentTask
  if (task?.approval) return api.agentApproval({ taskId: task.id, id: task.approval.id, allowed })
}
export function cancelAgent() {
  if (ui.agentTask?.status === 'running') return api.cancelAgent({ id: ui.agentTask.id })
}
let starting = false
export async function chat(question) {
  if (starting || ui.agentRunning || ui.busy || !doc.value) return
  starting = true
  try {
    await flush()
    const task = await api.agent({ session: ui.session, episodeId: episode.value.id, question })
    if (ui.agentTask?.id !== task.id) setAgent(task)
  } catch (err) {
    error(err)
  } finally {
    starting = false
  }
}
export function archive() {
  return perform('正在导出工程包', async () => {
    if (await api.archive({ session: ui.session })) notify('工程包已导出')
  })
}
export const time = (sec) =>
  Math.floor(sec / 60)
    .toString()
    .padStart(2, '0') +
  ':' +
  (sec % 60).toFixed(2).padStart(5, '0')
