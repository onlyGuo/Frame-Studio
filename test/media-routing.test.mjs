import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Settings } from '../desktop/services/settings.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { Commands } from '../desktop/services/commands.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { runWorkCommand } from '../desktop/services/work-command.mjs'
import { executeTool, toolsForSession } from '../desktop/agent/tools.mjs'
import { ffmpegPath } from '../desktop/services/media.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kc/oAAAAASUVORK5CYII=',
  'base64'
)
const commands = new Commands({
  node: process.execPath,
  python: path.resolve('runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  ffmpeg: ffmpegPath
})
const vault = { seal: (text) => text, open: (text) => text }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-routes-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const settings = new Settings(path.join(root, 'settings'), vault)
  const skills = new Skills(settings, path.resolve('resources/skills'), commands)
  const project = Project.create(root, '分镜验证', '16:9')
  return { settings, skills, project, signal: new AbortController().signal }
}

test('首次模型请求仅含就绪路由；旧配置、默认模型切换和缺少混元 SecretId 均得到正确处理', async (t) => {
  const { settings } = await fixture(t)
  const put = (id, model, active, secretId) =>
    settings.update({
      id,
      url: 'https://private.example/api',
      key: 'private-test-key',
      model,
      active,
      secretId
    })
  put('aliyun-image', 'qwen-image-3.0')
  put('aliyun-video', 'wan3.0-video-prime')
  put('hunyuan-image', 'hunyuan-image', false, '')
  delete settings.data.mediaDefaults
  settings.save()
  const restored = new Settings(settings.root, vault),
    restoredSkills = new Skills(restored, path.resolve('resources/skills'), commands)
  assert.equal(restoredSkills.resolveMedia('image').id, 'aliyun-image')
  assert.equal(restoredSkills.resolveMedia('video').id, 'aliyun-video')
  assert.equal(restored.view().profiles['hunyuan-image'].ready, false)
  const definitions = toolsForSession(restoredSkills)
  assert.ok(!definitions.some((tool) => tool.name === 'generate_media'))
  assert.ok(
    definitions.find((tool) => tool.name === 'run_command').parameters.properties.commands.items.properties
      .script
  )
  const descriptor = JSON.stringify(definitions)
  assert.ok(descriptor.includes('qwen-image-3.0'))
  assert.ok(descriptor.includes('wan3.0-video-prime'))
  for (const secret of [
    'private.example',
    'private-test-key',
    'openai-image',
    'hunyuan-image',
    'minimax-video'
  ])
    assert.ok(!descriptor.includes(secret))
  restored.update({
    id: 'openai-image',
    url: 'https://another.example/v1',
    model: 'image-model',
    key: 'another-key',
    active: true
  })
  assert.equal(restoredSkills.resolveMedia('image').id, 'openai-image')
  restoredSkills.manage('openai-image', 'disable')
  assert.throws(() => restoredSkills.resolveMedia('image'), /未启用/)
  restored.update({ id: 'openai-image', url: 'https://another.example/v1', model: 'image-model', key: '' })
  assert.equal(restoredSkills.resolveMedia('image').id, 'aliyun-image')
})

test('千问图片使用选定模型、临时环境变量与多模态协议，失败只回传服务状态', async (t) => {
  const ctx = await fixture(t)
  const requests = []
  let reject = false,
    base,
    submittedModel
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
    if (req.url === '/generated.png') {
      res.setHeader('content-type', 'image/png')
      return res.end(png)
    }
    if (reject) {
      res.statusCode = 401
      return res.end('server may echo a private-test-key')
    }
    res.setHeader('content-type', 'application/json')
    if (req.headers['x-dashscope-async'] === 'enable') {
      submittedModel = JSON.parse(body).model
      return res.end(JSON.stringify({ output: { task_id: 'test-task' } }))
    }
    if (req.url.endsWith('/tasks/test-task')) {
      const url = base + '/generated.png'
      const asset =
        submittedModel === 'wan2.6-image'
          ? { choices: [{ message: { content: [{ text: '生成结果' }, { image: url }] } }] }
          : { results: [{ url }] }
      return res.end(JSON.stringify({ output: { task_status: 'SUCCEEDED', ...asset } }))
    }
    res.end(
      JSON.stringify({
        output: { choices: [{ message: { content: [{ image: base + '/generated.png' }] } }] }
      })
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  base = 'http://127.0.0.1:' + server.address().port
  ctx.settings.update({
    id: 'aliyun-image',
    model: 'qwen-image-3.0',
    key: 'private-test-key',
    url: base + '/api/v1'
  })
  const result = await executeTool('generate_media', { kind: 'image', prompt: '车站雨景' }, ctx)
  assert.equal(result.model, 'qwen-image-3.0')
  assert.equal(result.skillId, 'aliyun-image')
  assert.equal(ctx.project.data.assets[0].id, result.assetId)
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/api/v1/services/aigc/multimodal-generation/generation', '/generated.png']
  )
  assert.equal(requests[0].headers.authorization, 'Bearer private-test-key')
  assert.equal(requests[1].headers.authorization, undefined)
  assert.equal(requests[0].body.model, 'qwen-image-3.0')
  assert.deepEqual(requests[0].body.input, { messages: [{ role: 'user', content: [{ text: '车站雨景' }] }] })
  assert.equal(requests[0].headers['x-dashscope-async'], undefined)
  reject = true
  await assert.rejects(
    executeTool('generate_media', { kind: 'image', prompt: '雨滴' }, ctx),
    (err) =>
      /提交请求返回 HTTP 401/.test(err.message) &&
      !err.message.includes('private-test-key') &&
      !err.message.includes(base)
  )
  assert.equal(requests.length, 3)
  reject = false
  for (const [model, route, size] of [
    ['wan2.6-t2i', '/services/aigc/multimodal-generation/generation', '1920*1080'],
    ['wan2.6-image', '/services/aigc/image-generation/generation', '1280*720'],
    ['wan2.5-t2i-preview', '/services/aigc/text2image/image-synthesis', '1920*1080']
  ]) {
    ctx.settings.update({ id: 'aliyun-image', model, url: base + '/api/v1' })
    const before = requests.length
    const asset = await executeTool('generate_media', { kind: 'image', prompt: '车站雨景' }, ctx)
    assert.equal(asset.model, model)
    const call = requests[before]
    assert.equal(call.path, '/api/v1' + route)
    assert.equal(call.body.parameters.size, size)
    if (model === 'wan2.6-image') {
      assert.equal(call.body.parameters.enable_interleave, true)
      assert.equal(call.body.parameters.max_images, 1)
    }
  }
})

test('通用命令按 mediaKind 解析已配置服务，审批参数显示 provider，JS 及 Python 子进程均能读取当次凭据', async (t) => {
  const ctx = await fixture(t)
  ctx.settings.update({
    id: 'aliyun-image',
    model: 'qwen-image-3.0',
    key: 'local-only',
    url: 'https://private.example/api'
  })
  const approved = []
  ctx.approve = async (spec) => {
    approved.push(spec.provider)
    return true
  }
  ctx.command = (spec, signal) => runWorkCommand(ctx.project, ctx.settings, commands, spec, signal)
  for (const [executable, args] of [
    [
      'node',
      [
        '-e',
        "if(!process.env.STUDIO_API_KEY||!process.env.STUDIO_API_URL||process.env.STUDIO_MODEL!=='qwen-image-3.0')process.exit(9); console.log(process.env.STUDIO_API_KEY)"
      ]
    ],
    [
      'python',
      [
        '-I',
        '-c',
        "import os;assert os.environ['STUDIO_MODEL']=='qwen-image-3.0' and os.environ['STUDIO_API_URL'];print(os.environ['STUDIO_API_KEY'])"
      ]
    ]
  ]) {
    const result = await executeTool('run_command', { mediaKind: 'image', executable, args }, ctx)
    assert.deepEqual(result, {
      executed: true,
      exitCode: 0,
      stdout: '[已隐藏]\n',
      stderr: ''
    })
  }
  assert.deepEqual(approved, ['aliyun-image', 'aliyun-image'])
  const plain = await executeTool(
    'run_command',
    { executable: 'node', args: ['-e', "console.log(process.env.STUDIO_API_KEY||'empty')"] },
    ctx
  )
  assert.equal(plain.stdout.trim(), 'empty')
})
