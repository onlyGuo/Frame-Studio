import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import * as tar from 'tar'
import { Commands } from '../desktop/services/commands.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { modelFixture } from './model-fixture.mjs'
import { runWorkCommand } from '../desktop/services/work-command.mjs'
import { runAgent } from '../desktop/services/agent.mjs'
import { makeClip, makeAudio } from '../shared/model.mjs'
import { ffmpegPath, probe, renderEpisode } from '../desktop/services/media.mjs'
import { mediaResponse } from '../desktop/core/protocol.mjs'
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-test-'))
const running = new AbortController()
const commands = new Commands({
  node: path.resolve('runtime/node', process.platform === 'win32' ? 'node.exe' : 'node'),
  python: path.resolve('runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  ffmpeg: ffmpegPath
})
const cfg = new Settings(path.join(scratch, 'home'), { seal: (s) => s, open: (s) => s })
const skills = new Skills(cfg, path.resolve('resources/skills'), commands, {
  formatVideo: async (_settings, _skill, _directory, spec) => spec.prompt
})
let host, port, url, project, png, mp4
const received = []
function encode(args) {
  const r = spawnSync(ffmpegPath, ['-loglevel', 'error', '-y', ...args])
  assert.equal(r.status, 0, String(r.stderr))
}
before(async () => {
  encode(['-f', 'lavfi', '-i', 'color=c=red:s=96x64', '-frames:v', '1', path.join(scratch, 'red.png')])
  encode([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:r=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=400',
    '-t',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    path.join(scratch, 'blue.mp4')
  ])
  encode(['-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '1', path.join(scratch, 'tone.wav')])
  png = await fs.readFile(path.join(scratch, 'red.png'))
  mp4 = await fs.readFile(path.join(scratch, 'blue.mp4'))
  host = http.createServer(async (req, res) => {
    let data = ''
    for await (const part of req) data += part
    received.push({ url: req.url, headers: req.headers, data })
    const raw = req.url
    const reply = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (raw === '/file.png' || raw === '/file.mp4') return res.end(raw.endsWith('png') ? png : mp4)
    if (raw === '/api/images/generations') return reply({ data: [{ b64_json: png.toString('base64') }] })
    if (raw.includes('/services/aigc'))
      return reply({ output: { task_id: raw.includes('video') ? 'video' : 'image' } })
    if (raw.includes('/tasks/'))
      return reply({
        output: {
          task_status: 'SUCCEEDED',
          video_url: url + '/file.mp4',
          results: [{ url: url + '/file.png' }]
        }
      })
    if (raw === '/api/video_generation') return reply({ task_id: 'job' })
    if (raw.startsWith('/api/query/')) return reply({ status: 'Success', file_id: 'file' })
    if (raw.startsWith('/api/files/')) return reply({ file: { download_url: url + '/file.mp4' } })
    if (req.headers['x-tc-action'])
      return reply({
        Response: req.headers['x-tc-action'].startsWith('Submit')
          ? { JobId: 'job' }
          : { JobStatusCode: '5', ResultImage: [url + '/file.png'] }
      })
    return reply(modelFixture(raw, JSON.parse(data)))
  })
  await new Promise((resolve, reject) => {
    host.once('error', reject)
    host.listen(0, '127.0.0.1', resolve)
  })
  port = host.address().port
  url = 'http://127.0.0.1:' + port
  project = Project.create(scratch, '本地短剧', '16:9')
})
after(async () => {
  if (host?.listening) await new Promise((r) => host.close(r))
  await fs.rm(scratch, { recursive: true, force: true })
})
test('五个内置 Skill 调用本机命令，完成提交、轮询及媒体入库', async () => {
  for (const s of skills.list().filter((skill) => skill.command && skill.kind !== 'guide')) {
    cfg.update({
      id: s.id,
      url: url + (s.id === 'hunyuan-image' ? '' : '/api'),
      model: s.id === 'minimax-video' ? 'MiniMax-Hailuo-2.3' : 'fixture',
      key: 'private-media-' + s.id,
      secretId: 'test-id'
    })
    const result = await skills.run(
      project,
      s.id,
      { prompt: '抽象色块过渡', assetFree: true, duration: s.id === 'minimax-video' ? 6 : 5 },
      running.signal
    )
    assert.equal(result[0].kind, s.kind)
    assert.ok((await fs.stat(project.assetPath(result[0]))).size)
  }
  assert.equal(project.data.assets.length, 5)
  assert.ok(received.filter((r) => r.url.startsWith('/file.')).every((r) => !r.headers.authorization))
  assert.throws(() => skills.manage('minimax-video', 'remove'))
  skills.manage('openai-image', 'disable')
  await assert.rejects(skills.run(project, 'openai-image', { prompt: 'x' }, running.signal))
  skills.manage('openai-image', 'enable')
})
test('三种 LLM 原生协议各自完成四轮推理，连续读取、修改、执行命令并看见实际结果', async () => {
  for (const id of ['chat', 'responses', 'anthropic']) {
    cfg.update({
      id,
      url: url + (id === 'anthropic' ? '/anthropic' : '/llm'),
      model: id,
      key: 'language-secret',
      active: true
    })
    const count = received.length
    const events = []
    const stats = await runAgent(
      {
        settings: cfg,
        project,
        skills,
        episodeId: project.data.episodes[0].id,
        signal: running.signal,
        event: (e) => events.push(e),
        approve: async () => true,
        command: (spec, sig) => runWorkCommand(project, cfg, commands, spec, sig)
      },
      '创建雨夜分镜并验证本机运行时'
    )
    assert.equal(stats.rounds, 4)
    assert.equal(project.data.episodes[0].shots.at(-1).id, 'shot-' + id)
    assert.match(project.data.messages.at(-1).text, /42/)
    assert.deepEqual(
      events.filter((e) => e.type === 'tool').map((e) => e.name),
      ['read_project', 'edit_project', 'run_command']
    )
    const requests = received.slice(count)
    assert.equal(requests.length, 4)
    for (const req of requests) {
      if (id === 'anthropic') assert.equal(req.url, '/anthropic/v1/messages')
      assert.ok(!req.data.includes('private-media'))
      assert.ok(!req.data.includes(url))
      assert.ok(!req.data.includes(project.root))
      assert.equal(
        req.headers.authorization || req.headers['x-api-key'],
        id === 'anthropic' ? 'language-secret' : 'Bearer language-secret'
      )
      assert.ok(JSON.parse(req.data).tools.some((t) => (t.function?.name || t.name) === 'rough_cut'))
    }
    const transcript = JSON.parse(requests[3].data)
    if (id === 'responses')
      assert.deepEqual(
        transcript.input.filter((v) => v.type === 'function_call_output').map((v) => v.call_id),
        ['call_0', 'call_1', 'call_2']
      )
    if (id === 'chat')
      assert.deepEqual(
        transcript.messages.filter((v) => v.role === 'tool').map((v) => v.tool_call_id),
        ['call_0', 'call_1', 'call_2']
      )
    if (id === 'anthropic')
      assert.deepEqual(
        transcript.messages.flatMap((v) =>
          Array.isArray(v.content)
            ? v.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
            : []
        ),
        ['call_0', 'call_1', 'call_2']
      )
  }
})
test('工具失败可在同一轮用户请求中恢复，用户取消后停止后续模型请求', async () => {
  cfg.update({ id: 'chat', url: url + '/llm', model: 'recover', key: 'language-secret', active: true })
  const events = []
  await runAgent(
    {
      settings: cfg,
      project,
      skills,
      episodeId: project.data.episodes[0].id,
      signal: running.signal,
      event: (e) => events.push(e)
    },
    '检查能力'
  )
  assert.ok(events.some((e) => e.type === 'result' && e.failed))
  assert.ok(project.data.messages.at(-1).text.includes(skills.catalog().length + ' 个可用能力'))
  const controller = new AbortController(),
    count = received.length
  await assert.rejects(
    runAgent(
      {
        settings: cfg,
        project,
        skills,
        signal: controller.signal,
        event: (e) => {
          if (e.type === 'result') controller.abort()
        }
      },
      '停止测试'
    ),
    /已停止/
  )
  assert.equal(received.length - count, 1)
})
test('通用命令包含随包运行时，可运行其他程序并取消进程', async () => {
  const cwd = project.root
  for (const executable of ['python', 'node', 'ffmpeg']) {
    const r = await commands.run(
      { executable, args: [executable === 'ffmpeg' ? '-version' : '--version'] },
      { cwd, signal: running.signal }
    )
    assert.equal(r.code, 0)
    assert.ok(r.stdout + r.stderr)
  }
  const r = await commands.run(
    { executable: process.execPath, args: ['-e', 'console.log(process.env.STUDIO_API_KEY)'] },
    { cwd, env: { STUDIO_API_KEY: 'one-run' }, signal: running.signal }
  )
  assert.equal(r.stdout.trim(), 'one-run')
  assert.notEqual(process.env.STUDIO_API_KEY, 'one-run')
  await assert.rejects(
    commands.run(
      { executable: 'node', args: ['-e', 'setTimeout(()=>{},99999)'] },
      { cwd, signal: running.signal, timeout: 100 }
    ),
    /取消|超时/
  )
})
test('自定义 Skill 安装、读取、执行及卸载', async () => {
  const dir = path.join(scratch, 'plugin')
  await fs.mkdir(dir)
  await fs.writeFile(
    path.join(dir, 'skill.json'),
    JSON.stringify({
      id: 'local-image',
      name: '本地测试',
      description: '复制参考帧',
      kind: 'image',
      extension: '.png',
      command: { executable: 'node', args: ['{skill}/copy.mjs'] }
    })
  )
  await fs.writeFile(path.join(dir, 'SKILL.md'), '本地命令')
  await fs.writeFile(
    path.join(dir, 'copy.mjs'),
    "import fs from 'node:fs';fs.copyFileSync(new URL('./red.png',import.meta.url),process.env.STUDIO_OUTPUT)"
  )
  await fs.copyFile(path.join(scratch, 'red.png'), path.join(dir, 'red.png'))
  skills.install(dir)
  assert.throws(() => skills.install(dir))
  assert.equal(
    (await skills.run(project, 'local-image', { prompt: 'test' }, running.signal))[0].kind,
    'image'
  )
  skills.manage('local-image', 'remove')
  assert.ok(!skills.list().some((s) => s.id === 'local-image'))
  const guide = path.join(scratch, 'guide')
  await fs.mkdir(guide)
  await fs.writeFile(
    path.join(guide, 'SKILL.md'),
    '---\nname: shot-review\ndescription: 复核分镜连续性\n---\n根据对白检查轴线。'
  )
  skills.install(guide)
  assert.equal(skills.list().find((s) => s.id === 'shot-review').kind, 'guide')
  skills.manage('shot-review', 'remove')
})
test('剪辑导出、工程包往返、素材范围读取与版本冲突', async () => {
  const [pic, video, sound] = await project.addMedia(
    ['red.png', 'blue.mp4', 'tone.wav'].map((f) => path.join(scratch, f)),
    probe
  )
  const d = structuredClone(project.data)
  const e = d.episodes[0]
  e.clips.push({ ...makeClip(pic.id, 0.4), caption: '测试' }, makeClip(video.id, 0.4))
  e.audio.push({ ...makeAudio(sound.id, 0.6), start: 0.1 })
  project.save(d)
  assert.throws(() => project.save(d), /版本/)
  const out = await renderEpisode(
    project,
    e.id,
    { [e.clips[0].id]: png.toString('base64') },
    running.signal,
    () => {}
  )
  assert.ok(Math.abs((await probe(out, 'video')) - 0.8) < 0.15)
  const req = new Request('studio-media://' + project.session + '/' + video.id, {
    headers: { range: 'bytes=1-10' }
  })
  assert.equal((await mediaResponse(project, req).arrayBuffer()).byteLength, 10)
  const preview = new Request('studio-media://' + project.session + '/exports/' + path.basename(out), {
    headers: { range: 'bytes=0-31' }
  })
  const exported = mediaResponse(project, preview)
  assert.equal(exported.status, 206)
  assert.equal(exported.headers.get('Content-Type'), 'video/mp4')
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), (await fs.readFile(out)).subarray(0, 32))
  await fs.mkdir(path.join(project.root, 'work', 'nested'))
  await fs.writeFile(path.join(project.root, 'work/nested/edit.js'), '// work')
  const file = path.join(scratch, 'studio.framepack')
  await project.archive(file)
  const restored = await Project.restore(file, scratch)
  assert.deepEqual(restored.data, project.data)
  assert.notEqual(restored.root, project.root)
  assert.equal(await fs.readFile(path.join(restored.root, 'work/nested/edit.js'), 'utf8'), '// work')
  assert.equal((await fs.readdir(path.join(restored.root, 'exports'))).length, 1)
  assert.deepEqual(Project.open(restored.root).data, project.data)
})
test('导入拒绝额外文件并清理临时目录', async () => {
  const file = path.join(scratch, 'invalid.framepack')
  await tar.c({ cwd: scratch, file, gzip: true }, ['red.png'])
  await assert.rejects(Project.restore(file, scratch), /无效条目/)
  assert.ok(!(await fs.readdir(scratch)).some((f) => f.startsWith('.frame-import-')))
})
