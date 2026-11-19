import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Commands } from '../desktop/services/commands.mjs'
import { runWorkCommand } from '../desktop/services/work-command.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { executeTool } from '../desktop/agent/tools.mjs'
import { ffmpegPath } from '../desktop/services/media.mjs'

/** 每次测试使用独立工程、真实内置解释器与临时源码。 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-command-group-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const settings = new Settings(path.join(dir, 'config'), { seal: (value) => value, open: (value) => value })
  const project = Project.create(dir, '分组命令', '16:9')
  const runner = new Commands({
    node: process.execPath,
    python: path.resolve('runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    ffmpeg: ffmpegPath
  })
  const controller = new AbortController()
  const approvals = [],
    steps = []
  const ctx = {
    project,
    settings,
    episodeId: project.data.episodes[0].id,
    signal: controller.signal,
    approve: async (spec) => {
      approvals.push(spec)
      return true
    },
    command: (spec, signal, scope) => runWorkCommand(project, settings, runner, spec, signal, scope),
    onCommandStep: (index, status, metadata) => steps.push({ index, status, metadata })
  }
  const group = (commands, extra) => executeTool('run_command', { commands, ...extra }, ctx)
  return { ctx, settings, project, group, controller, approvals, steps, runner }
}

test('一次授权 JS 与 Python，脚本读取制作快照、生成事务文件并返回每步回执', async (t) => {
  const { ctx, settings, project, group, approvals, steps } = await fixture(t)
  settings.update({
    id: 'aliyun-image',
    url: 'https://private.example/api',
    model: 'demo',
    key: 'private-fixture-only'
  })
  project.save({ ...project.data, synopsis: '内嵌待脱敏 private-fixture-only' })
  const js = `import fs from 'node:fs'
const doc=JSON.parse(fs.readFileSync(process.env.STUDIO_PROJECT))
if(doc.messages || doc.synopsis.includes('private-fixture-only') || process.env.STUDIO_API_KEY) process.exit(7)
fs.writeFileSync('next.txt',doc.episodes[0].id)
console.log(doc.title)`
  const py = `import os, json, pathlib
episode=pathlib.Path('next.txt').read_text(encoding='utf-8')
actions=[{'target':'shots','op':'add','id':'rain','episodeId':episode,'fields':{'title':'静夜'}}]
pathlib.Path(os.environ['STUDIO_EDITS']).write_text(json.dumps(actions),encoding='utf-8')
print('ok')`
  const result = await group([
    { executable: 'node', args: ['scripts/prep.mjs'], script: { path: 'scripts/prep.mjs', content: js } },
    {
      executable: 'python',
      args: ['-I', 'scripts/apply.py'],
      script: { path: 'scripts/apply.py', content: py },
      applyEdits: true
    }
  ])
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].commands[1].script.content, py)
  assert.equal(result.results[0].stdout.trim(), project.data.title)
  assert.equal(result.results[1].stdout.trim(), 'ok')
  assert.deepEqual(result.results[1].changed, [{ target: 'shots', op: 'add', id: 'rain' }])
  assert.equal(project.data.episodes[0].shots[0].title, '静夜')
  assert.equal(await fs.readFile(path.join(project.root, 'work/scripts/prep.mjs'), 'utf8'), js)
  assert.deepEqual(
    steps.map((s) => s.status),
    ['running', 'completed', 'running', 'completed']
  )
  assert.ok(!JSON.stringify(steps).includes('stdout'))
  const denied = {
    executable: 'node',
    args: ['never.mjs'],
    script: { path: 'never.mjs', content: 'throw Error()' }
  }
  ctx.approve = async () => false
  const refusal = await group([denied, denied])
  assert.deepEqual(
    refusal.results.map((r) => r.status),
    ['skipped', 'skipped']
  )
  await assert.rejects(fs.stat(path.join(project.root, 'work', 'never.mjs')), { code: 'ENOENT' })
})

test('失败、后续独立命令、脚本重试与取消分别保留有序的执行状态', async (t) => {
  const { ctx, group, controller } = await fixture(t)
  const failed = { executable: 'node', args: ['-e', 'console.error("具体错误");process.exit(3)'] }
  const ok = { executable: 'node', args: ['-p', '6*7'] }
  const first = await group([failed, ok])
  assert.deepEqual(
    first.results.map((r) => r.status),
    ['failed', 'skipped']
  )
  assert.equal(first.results[0].exitCode, 3)
  assert.match(first.results[0].stderr, /具体错误/)
  const retried = await group([failed, ok], { continueOnError: true })
  assert.equal(retried.results[1].stdout.trim(), '42')
  const script = (content, options = {}) => ({
    executable: 'node',
    args: ['mark.mjs'],
    script: { path: 'mark.mjs', content, ...options }
  })
  const repeated = await group(
    [
      script('console.log(1)'),
      script('console.log(1)'),
      script('console.log(2)'),
      script('console.log(3)', { overwrite: true })
    ],
    { continueOnError: true }
  )
  assert.deepEqual(
    repeated.results.map((r) => r.status),
    ['completed', 'completed', 'failed', 'completed']
  )
  const invalid = await group([
    { executable: 'node', args: [], script: { path: '../escape.mjs', content: 'x' } }
  ])
  assert.equal(invalid.results[0].status, 'failed')
  const statuses = []
  ctx.onCommandStep = (index, status) => {
    statuses.push([index, status])
    if (status === 'completed') controller.abort()
  }
  await assert.rejects(group([ok, ok]))
  assert.deepEqual(statuses, [
    [0, 'running'],
    [0, 'completed']
  ])
})

test('运行中的脚本保留人工修改，冲突或失败时工程不会提交一半', async (t) => {
  const { ctx, project, runner, settings, group } = await fixture(t)
  const script = {
    executable: 'node',
    args: [
      '-e',
      `const fs=require('fs');fs.writeFileSync(process.env.STUDIO_EDITS, JSON.stringify([{target:'project',op:'update',fields:{synopsis:'脚本修改'}}]))`
    ],
    applyEdits: true
  }
  let field = 'title'
  ctx.command = (spec, signal) =>
    runWorkCommand(
      project,
      settings,
      {
        async run(cmd, options) {
          const result = await runner.run(cmd, options)
          project.save({ ...project.data, [field]: '人工修改' })
          return result
        }
      },
      spec,
      signal
    )
  assert.equal((await group([script])).results[0].status, 'completed')
  assert.equal(project.data.title, '人工修改')
  assert.equal(project.data.synopsis, '脚本修改')
  field = 'synopsis'
  assert.match((await group([script])).results[0].error, /目标已被修改/)
  assert.equal(project.data.synopsis, '人工修改')
})

test('Skill 与普通终端命令共用一次调用，返回真实资源引用，实时摘要不含进程输出', async (t) => {
  const { ctx, settings, group, project, approvals, steps } = await fixture(t)
  settings.update({ id: 'aliyun-image', url: 'https://private.example/api', model: 'paint', key: 'testkey' })
  const skill = { id: 'aliyun-image', provider: 'aliyun-image', kind: 'image', model: 'paint' }
  ctx.skills = {
    resolveMedia: () => skill,
    async generate(p, id, input) {
      assert.equal(p, project)
      assert.equal(id, 'aliyun-image')
      assert.equal(input.prompt, '角色定妆')
      return { assets: [{ id: 'painted', kind: 'image', name: '定妆图' }] }
    }
  }
  const result = await group([
    { skill: 'image', prompt: '角色定妆' },
    { executable: 'node', args: ['-p', '"process-output"'] }
  ])
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].commands[0].model, 'paint')
  assert.equal(result.results[0].assetId, 'painted')
  assert.match(result.results[1].stdout, /process-output/)
  assert.deepEqual(steps[1].metadata.outputs, [{ id: 'painted', kind: 'image', name: '定妆图' }])
  assert.ok(!JSON.stringify(steps).includes('process-output'))
})

test('指令型 Skill 独立增加可执行脚本，通过命令原生参数定位、审批及执行', async (t) => {
  const { ctx, project, settings, runner, group, approvals } = await fixture(t)
  const source = path.join(path.dirname(project.root), 'extension')
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true })
  await fs.writeFile(
    path.join(source, 'SKILL.md'),
    '---\nname: line-counter\ndescription: 统计台词\n---\n运行 scripts/count.mjs'
  )
  await fs.writeFile(
    path.join(source, 'scripts/count.mjs'),
    "import fs from 'node:fs';console.log(fs.existsSync(process.env.STUDIO_SKILL_DIR+'/SKILL.md') ? 42 : 0)"
  )
  ctx.skills = new Skills(settings, path.resolve('resources/skills'), runner)
  ctx.skills.install(source)
  const read = await executeTool('read_skill', { id: 'line-counter' }, ctx)
  assert.deepEqual(read.files, ['SKILL.md', 'scripts/count.mjs'])
  assert.equal(JSON.stringify(read).includes(source), false)
  const command = { executable: 'node', args: ['{skill}/scripts/count.mjs'], fromSkill: 'line-counter' }
  assert.equal((await group([command])).results[0].stdout.trim(), '42')
  assert.equal(approvals[0].commands[0].fromSkill, 'line-counter')
  ctx.approve = async () => {
    ctx.skills.manage('line-counter', 'disable')
    return true
  }
  assert.equal((await group([command])).results[0].status, 'failed')
})

test('第二条进程运行时停止，第一条已提交的事务保存在检查点，后续命令未启动', async (t) => {
  const { ctx, project, group, controller } = await fixture(t)
  t.after(() => controller.abort())
  const checkpoints = []
  ctx.checkpoint = async (value) => checkpoints.push(structuredClone(value))
  const change =
    "require('fs').writeFileSync(process.env.STUDIO_EDITS,JSON.stringify([{target:'project',op:'update',fields:{synopsis:'提交后取消'}}]))"
  const work = path.join(project.root, 'work')
  const pending = group([
    { executable: 'node', args: ['-e', change], applyEdits: true },
    {
      executable: 'node',
      args: ['-e', "require('fs').writeFileSync('started','yes');setInterval(()=>{},200)"]
    },
    { executable: 'node', args: ['-e', "require('fs').writeFileSync('unexpected','yes')"] }
  ])
  const finish = assert.rejects(pending)
  for (let tries = 0; tries < 250; tries++) {
    if (
      await fs.access(path.join(work, 'started')).then(
        () => true,
        () => false
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await fs.access(path.join(work, 'started'))
  controller.abort()
  await finish
  assert.equal(checkpoints.length, 1)
  assert.equal(checkpoints[0].remaining, 2)
  assert.equal(checkpoints[0].results[0].status, 'completed')
  assert.equal(checkpoints[0].results[0].changed[0].target, 'project')
  assert.equal(project.data.synopsis, '提交后取消')
  await assert.rejects(fs.access(path.join(work, 'unexpected')), { code: 'ENOENT' })
})
