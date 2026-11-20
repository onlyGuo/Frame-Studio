import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Project } from '../desktop/services/projects.mjs'
import { describeRun, traceToolStart, traceToolResult } from '../shared/agent-trace.mjs'
import { splitSteps, elapsedText, activityGroup } from '../src/components/assistant/transcript.mjs'

const start = '2026-11-18T10:00:00.000Z'
const end = '2026-11-18T10:21:39.000Z'
const events = [
  { type: 'thinking', round: 1, time: start },
  { type: 'message', phase: 'commentary', text: '先整理分镜。' },
  { type: 'tool', name: 'edit_project', id: 'c1', arguments: '{"actions":[]}' },
  {
    type: 'result',
    name: 'edit_project',
    id: 'c1',
    summary: '{"changed":[{"op":"add","target":"shots","id":"shot1"}]}'
  },
  { type: 'thinking', round: 2 },
  {
    type: 'result',
    name: 'generate_media',
    id: 'c2',
    summary: '{"assetId":"a","name":"夜雨","kind":"video","model":"test","shotId":"shot1"}'
  },
  { type: 'thinking', round: 3 },
  { type: 'delta', text: '片段' },
  { type: 'message', phase: 'final', text: '片段已完成。', time: end }
]
test('步骤、最终回答、媒体和已提交的编辑可独立展示，停止时保留部分工作', () => {
  const complete = { id: 'turn', startedAt: start, endedAt: end, status: 'completed', events }
  const view = splitSteps(events, complete.status)
  assert.equal(view.finalText, '片段已完成。')
  assert.deepEqual(
    view.rounds.map((r) => r.text),
    ['先整理分镜。', '']
  )
  const summary = describeRun(complete)
  assert.deepEqual(summary.changes, [{ op: 'add', target: 'shots', count: 1 }])
  assert.equal(summary.outputs[0].shotId, 'shot1')
  assert.equal(elapsedText(start, end), '21 分钟 39 秒')
  const partial = splitSteps(events.slice(0, 3), 'cancelled')
  assert.equal(partial.finalText, '')
  assert.equal(partial.rounds[0].calls[0].state, 'stopped')
})
test('工程重开与打包导入能分别读取多次运行及旧版一次轨迹', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-history-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const project = Project.create(parent, '会话', '16:9')
  const messages = ['old', 'one', 'two'].flatMap((id) => [
    { id, role: 'user', text: '相同的问题' },
    { id: id + '-reply', role: 'assistant', text: '片段已完成。' }
  ])
  project.save({ ...project.data, messages })
  await fs.writeFile(path.join(project.root, 'last-run.json'), JSON.stringify(events))
  project.runs.save({ id: 'one', status: 'completed', startedAt: start, endedAt: end, events })
  project.runs.save({
    id: 'two',
    status: 'cancelled',
    startedAt: start,
    endedAt: end,
    error: '本轮已停止。',
    events: events.slice(0, 3)
  })
  const bundle = path.join(parent, 'archive.framepack')
  await project.archive(bundle)
  for (const opened of [Project.open(project.root), await Project.restore(bundle, parent)]) {
    const history = opened.agentHistory()
    assert.deepEqual(history.map((r) => r.id).sort(), ['old', 'one', 'two'])
    assert.ok(history.every((r) => !Object.hasOwn(r, 'events')))
    assert.equal(history.find((r) => r.id === 'two').status, 'cancelled')
    assert.equal(opened.agentTrace('two').length, 3)
    assert.equal(opened.agentTrace('old').length, events.length)
    assert.equal(opened.agentTrace('one').at(-1).text, '片段已完成。')
    assert.throws(() => opened.agentTrace('../../outside'))
  }
})

test('一组命令的操作标题与状态按序展示，非媒体输出和脚本源码不进入轨迹', () => {
  const args = {
    commands: [
      {
        executable: 'node',
        args: ['inspect.mjs'],
        script: { path: 'inspect.mjs', content: 'console.log("PRIVATE_CODE")' }
      },
      { executable: 'python', args: ['-c', 'print("PRIVATE_CODE")'] },
      { skill: 'image' }
    ]
  }
  const start = { type: 'tool', id: 'group', name: 'run_command', ...traceToolStart('run_command', args) }
  const partial = [
    start,
    { type: 'command_step', id: 'group', index: 0, status: 'completed' },
    { type: 'command_step', id: 'group', index: 1, status: 'running' }
  ]
  const group = (trace, status) => activityGroup(splitSteps(trace, status).rounds[0].calls)
  assert.deepEqual(
    group(partial, 'running').steps.map((s) => s.state),
    ['done', 'running', 'pending']
  )
  assert.deepEqual(
    group(partial, 'cancelled').steps.map((s) => s.state),
    ['done', 'stopped', 'skipped']
  )
  const value = {
    results: [
      { status: 'completed', stdout: 'PRIVATE_STDOUT' },
      { status: 'failed', exitCode: 7, stderr: 'PRIVATE_STDERR' },
      { status: 'skipped' }
    ]
  }
  const complete = [
    ...partial,
    { type: 'result', id: 'group', name: 'run_command', ...traceToolResult('run_command', value) }
  ]
  assert.deepEqual(
    group(complete, 'completed').steps.map((s) => s.state),
    ['done', 'failed', 'skipped']
  )
  assert.equal(group(complete, 'completed').steps[1].detail, '退出码 7')
  assert.ok(!JSON.stringify(complete).includes('PRIVATE_'))
  const legacy = [
    { type: 'tool', name: 'run_command', id: 'g', arguments: JSON.stringify(args) },
    { type: 'result', name: 'run_command', id: 'g', summary: JSON.stringify(value) }
  ]
  assert.ok(!JSON.stringify(group(legacy, 'completed')).includes('PRIVATE_'))
})

test('压缩状态穿插在助手说明与操作之间，分组中断后仍能展示已经生成的素材', () => {
  const image = { id: 'portrait', kind: 'image', name: '林夕' }
  const history = [
    { type: 'message', phase: 'commentary', text: '先检查工程。' },
    { type: 'compaction', phase: 'started', beforeTokens: 270450 },
    { type: 'compaction', phase: 'completed', beforeTokens: 270450, afterTokens: 3400 },
    { type: 'thinking', round: 1 },
    {
      type: 'tool',
      name: 'run_command',
      id: 'a',
      ...traceToolStart('run_command', { commands: [{ skill: 'image' }, { executable: 'ffmpeg' }] })
    },
    { type: 'command_step', id: 'a', index: 0, status: 'completed', asset: image },
    { type: 'command_step', id: 'a', index: 1, status: 'running' }
  ]
  const view = splitSteps(history, 'cancelled')
  assert.equal(view.rounds.length, 3)
  assert.equal(view.rounds[0].text, '先检查工程。')
  assert.equal(view.rounds[1].compaction, 'completed')
  assert.equal(view.rounds[1].afterTokens, 3400)
  assert.equal(view.rounds[2].calls[0].steps[1].state, 'stopped')
  assert.deepEqual(
    describeRun({ events: history }).outputs.map((o) => o.id),
    ['portrait']
  )
})

test('清空会话同时移除模型上下文及新旧轨迹，重开和重试仍为空', async (t) => {
  const { loadHistory, saveHistory } = await import('../desktop/services/conversation-store.mjs')
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-clear-chat-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const project = Project.create(parent, '清空会话', '16:9')
  const other = Project.create(parent, '其他工程', '16:9')
  const messages = [{ id: 'turn', role: 'user', text: '旧提问' }]
  project.save({ ...project.data, messages })
  other.save({ ...other.data, messages })
  project.runs.save({ id: 'turn', status: 'completed', events })
  await fs.writeFile(path.join(project.root, 'last-run.json'), JSON.stringify(events))
  saveHistory(project, [{ role: 'user', content: '旧压缩上下文' }])
  await fs.writeFile(path.join(project.root, 'work', 'keep.txt'), '工程文件')
  const episodes = structuredClone(project.data.episodes)
  const save = project.save
  project.save = () => {
    throw Error('模拟提交失败')
  }
  assert.throws(() => project.clearChat(), /模拟提交失败/)
  assert.deepEqual(project.data.messages, messages)
  assert.equal(loadHistory(project)[0].content, '旧压缩上下文')
  assert.ok(project.agentHistory().length)
  project.save = save
  project.clearChat()
  const reopened = Project.open(project.root)
  assert.deepEqual(reopened.data.messages, [])
  assert.deepEqual(loadHistory(reopened), [])
  assert.deepEqual(reopened.agentHistory(), [])
  assert.deepEqual(reopened.agentTrace('turn'), [])
  assert.deepEqual(reopened.data.episodes, episodes)
  assert.equal(await fs.readFile(path.join(project.root, 'work', 'keep.txt'), 'utf8'), '工程文件')
  assert.deepEqual(Project.open(other.root).data.messages, messages)
  assert.ok(!(await fs.readdir(project.root)).some((name) => name.startsWith('.clear-chat-')))
  reopened.clearChat()
  assert.deepEqual(reopened.data.messages, [])
})
