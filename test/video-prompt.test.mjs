import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { Skills } from '../desktop/services/skills.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { Commands } from '../desktop/services/commands.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { ffmpegPath, probe } from '../desktop/services/media.mjs'
import { executeTool } from '../desktop/agent/tools.mjs'
import { makeCard, makeShot } from '../shared/model.mjs'
import { mentionToken } from '../shared/mentions.mjs'
import { setShotAssetFree } from '../shared/shot-assets.mjs'

/** 按各供应商实际的工具回执格式模拟整理模型。 */
function formattedReply(protocol, input) {
  const name = 'return_video_prompt'
  if (protocol === 'anthropic')
    return { content: [{ type: 'tool_use', id: 'format', name, input }], stop_reason: 'tool_use' }
  const args = JSON.stringify(input)
  if (protocol === 'responses')
    return {
      status: 'completed',
      output: [{ type: 'function_call', name, call_id: 'format', arguments: args }]
    }
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'format', type: 'function', function: { name, arguments: args } }]
        }
      }
    ]
  }
}

test('同一 H3 Skill 整理手动与 Agent 制片，按模式发送原对白和已选服饰，校验失败时不提交视频', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-video-prompt-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const fixtureFiles = {
    portrait: path.join(dir, 'red.png'),
    travel: path.join(dir, 'blue.png'),
    video: path.join(dir, 'test.mp4'),
    voice: path.join(dir, 'voice.wav')
  }
  for (const [name, color] of [
    ['portrait', 'red'],
    ['travel', 'blue'],
    ['video', 'blue']
  ])
    execFileSync(ffmpegPath, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=' + color + ':s=320x320',
      ...(name === 'video' ? ['-t', '0.25', '-pix_fmt', 'yuv420p'] : ['-frames:v', '1']),
      fixtureFiles[name]
    ])
  const bytes = await fs.readFile(fixtureFiles.video)
  execFileSync(ffmpegPath, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220',
    '-t',
    '4',
    fixtureFiles.voice
  ])
  const voiceBytes = await fs.readFile(fixtureFiles.voice)
  const travelBytes = await fs.readFile(fixtureFiles.travel)
  const submissions = [],
    inputs = [],
    problems = [],
    localRequests = [],
    wanRequests = [],
    voiceUploads = []
  let breakFormat = false
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const data = body.toString()
    const reply = (body) => res.setHeader('content-type', 'application/json').end(JSON.stringify(body))
    try {
      if (req.url.startsWith('/local/v1/videos')) {
        assert.equal(req.headers.authorization, 'Bearer private-local-key')
        if (req.method === 'POST') {
          const form = await new Response(body, {
            headers: { 'content-type': req.headers['content-type'] }
          }).formData()
          localRequests.push(form)
          return reply({ id: 'local-test' })
        }
        if (req.url.endsWith('/content')) return res.end(bytes)
        return reply({ status: 'completed' })
      }
      if (req.url === '/wan/api/v1/uploads?action=getPolicy&model=wan3.0-video') {
        assert.equal(req.headers.authorization, 'Bearer private-wan-key')
        return reply({
          data: {
            upload_host: base + '/oss',
            upload_dir: 'dashscope-instant/test',
            policy: 'test-policy',
            signature: 'test-signature',
            oss_access_key_id: 'test-oss-key',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true'
          }
        })
      }
      if (req.url === '/oss') {
        assert.equal(req.headers.authorization, undefined)
        voiceUploads.push(
          await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData()
        )
        return res.end()
      }
      if (req.url === '/wan/api/v1/services/aigc/video-generation/video-synthesis') {
        assert.equal(req.headers['x-dashscope-ossresourceresolve'], 'enable')
        wanRequests.push(JSON.parse(data))
        return reply({ output: { task_id: 'wan-test' } })
      }
      if (req.url === '/wan/api/v1/tasks/wan-test')
        return reply({ output: { task_status: 'SUCCEEDED', video_url: base + '/video.mp4' } })
      if (req.url === '/video.mp4') {
        assert.equal(req.headers.authorization, undefined)
        return res.end(bytes)
      }
      if (req.url === '/proxy/v2/video_generation') {
        assert.equal(req.headers.authorization, 'Bearer private-media-key')
        submissions.push(JSON.parse(data))
        return reply({ task_id: 'h3-test' })
      }
      if (req.url === '/proxy/v2/query/video_generation/h3-test')
        return reply({ task: { status: 'succeeded', content: { url: base + '/video.mp4' } } })
      const request = JSON.parse(data)
      const protocol = req.url.endsWith('/messages')
        ? 'anthropic'
        : req.url.endsWith('/responses')
          ? 'responses'
          : 'chat'
      const source = JSON.parse((request.messages || request.input).at(-1).content)
      const tool = request.tools[0].function || request.tools[0]
      assert.equal(tool.name, 'return_video_prompt')
      assert.doesNotMatch(data, /白鼠狼|不会发给整理模型的原台词|private-media-key|红色常服|private-episode/)
      if (source.skill === 'aliyun-video')
        return reply(formattedReply(protocol, { visual: '图1中的人物走向门口。\n[[DIALOGUE]]' }))
      const rules = request.system || request.instructions || request.messages[0].content
      assert.match(rules, /4\.4 Speakers, Dialogue, and Singing|H3 prompt construction in Frame Studio/)
      if (source.mode === 'references') assert.match(rules, /retention_analysis/)
      inputs.push({ protocol, source })
      const fields = Object.fromEntries(
        (tool.parameters || tool.input_schema).required.map((key) => [key, 'N/A'])
      )
      const detail =
        source.mode === 'references'
          ? '[Shot 1] <Subject 1> wearing the travel outfit approaches the doorway.'
          : '[Shot 1] A continuous pan across the doorway.'
      fields[source.dialogueField] = detail + (source.hasDialogue && !breakFormat ? '\n[[DIALOGUE]]' : '')
      return reply(formattedReply(protocol, fields))
    } catch (error) {
      problems.push(error)
      res.statusCode = 500
      return reply({ error: { message: error.message } })
    }
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  )
  const base = 'http://127.0.0.1:' + server.address().port
  const settings = new Settings(path.join(dir, 'settings'), {
    seal: (value) => value,
    open: (value) => value
  })
  const commands = new Commands({
    node: path.resolve('runtime/node', process.platform === 'win32' ? 'node.exe' : 'node'),
    python: path.resolve('runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    ffmpeg: ffmpegPath
  })
  const publicSkills = path.join(dir, 'public-skills')
  await fs.cp(path.resolve('resources/skills'), publicSkills, {
    recursive: true,
    filter: (file) => path.basename(file) !== 'h3-prompt-writing'
  })
  const skills = new Skills(settings, publicSkills, commands)
  settings.update({
    id: 'minimax-video',
    url: base + '/proxy/v1',
    model: 'MiniMax-H3',
    key: 'private-media-key'
  })
  const project = Project.create(dir, '制片测试')
  const [portrait, travel, voice] = await project.addMedia(
    [fixtureFiles.portrait, fixtureFiles.travel, fixtureFiles.voice],
    probe
  )
  const actor = {
    ...makeCard(),
    name: '阿荷',
    notes: '远处的村民大喊白鼠狼终于走了。',
    voiceAssetId: voice.id,
    outfits: [
      { id: 'regular', name: '红色常服', notes: '', assetId: portrait.id },
      { id: 'travel', name: '旅行服', notes: '', assetId: travel.id }
    ],
    defaultOutfitId: 'regular'
  }
  const refShot = {
    ...makeShot(),
    prompt: mentionToken(actor.id, 'travel') + '走向门口',
    dialogue: '阿荷：不会发给整理模型的原台词。旁白：他停了下来。'
  }
  const frameShot = {
    ...makeShot(),
    prompt: '镜头平移经过门框',
    referenceId: travel.id,
    dialogue: '（风吹动门帘）'
  }
  const textShot = { ...makeShot(), prompt: '黑色缓慢淡出' }
  const other = { ...makeShot(), prompt: 'private-episode', dialogue: '村民：白鼠狼终于走了' }
  for (const shot of [frameShot, textShot]) setShotAssetFree(shot, true)
  const episode = {
    ...project.data.episodes[0],
    script: 'private-episode',
    shots: [refShot, frameShot, textShot, other]
  }
  project.save({ ...project.data, cards: [actor], episodes: [episode] })
  const signal = new AbortController().signal
  const ctx = { settings, skills, project, episodeId: episode.id, signal }
  const selectLLM = (id) =>
    settings.update({
      id,
      url: base + '/llm/v1',
      model: id + '-format-fixture',
      key: 'private-language-key',
      active: true
    })
  selectLLM('chat')
  await skills.generate(project, 'minimax-video', { episodeId: episode.id, shotId: refShot.id }, signal)
  assert.equal(submissions[0].model, 'MiniMax-H3')
  assert.equal(submissions[0].duration, 5)
  assert.equal(submissions[0].content.length, 3)
  const [promptItem, image, audio] = submissions[0].content
  assert.deepEqual(image, {
    type: 'image_url',
    role: 'reference_image',
    image_url: { url: 'data:image/png;base64,' + travelBytes.toString('base64') }
  })
  assert.match(promptItem.text, /^subject_definitions: <Subject 1> is visually grounded in <Picture 1>/)
  assert.match(promptItem.text, /<Audio 1> is the voice-timbre reference for <Subject 1>/)
  assert.deepEqual(audio, {
    type: 'audio_url',
    role: 'reference_audio',
    audio_url: { url: 'data:audio/wav;base64,' + voiceBytes.toString('base64') }
  })
  assert.match(promptItem.text, /detailed_description: \[Shot 1\].*travel outfit/)
  assert.match(promptItem.text, /<Subject 1> says: <d>\[Chinese\] 不会发给整理模型的原台词。<\/d>/)
  assert.match(
    promptItem.text,
    /The narrator says in an off-screen voiceover: <d>\[Chinese\] 他停了下来。<\/d>/
  )
  assert.doesNotMatch(promptItem.text, /白鼠狼|\[\[DIALOGUE\]\]/)
  assert.equal(project.data.episodes[0].shots[0].prompt, refShot.prompt)
  assert.equal(project.data.episodes[0].shots[0].dialogue, refShot.dialogue)
  assert.match(inputs[0].source.visual, /阿荷 · 旅行服/)
  assert.equal(inputs[0].source.references[0].name, '阿荷 · 旅行服')

  selectLLM('responses')
  const group = await executeTool(
    'run_command',
    { commands: [{ skill: 'minimax-video', shotId: frameShot.id }] },
    ctx
  )
  assert.equal(group.results[0].status, 'completed', JSON.stringify(group))
  assert.equal(submissions[1].ratio, 'adaptive')
  assert.equal(submissions[1].content[1].role, 'first_frame')
  assert.match(submissions[1].content[0].text, /^For the target video, at 0\.00 seconds/)
  assert.doesNotMatch(submissions[1].content[0].text, /<d>/)
  assert.equal(inputs[1].source.hasDialogue, false)
  assert.deepEqual(inputs[1].source.performanceNotes, ['风吹动门帘'])

  selectLLM('anthropic')
  settings.update({ id: 'minimax-video', url: base + '/proxy/v2', model: 'MiniMax-H3-Max' })
  await skills.generate(project, 'minimax-video', { episodeId: episode.id, shotId: textShot.id }, signal)
  assert.equal(submissions[2].content.length, 1)
  assert.equal(submissions[2].model, 'MiniMax-H3-Max')
  assert.deepEqual(submissions[2].extra, { prompt_expansion_mode: 'disabled' })
  assert.match(submissions[2].content[0].text, /^integrated_multimodal_description: \[Shot 1\]/)
  assert.deepEqual(
    inputs.map(({ protocol, source }) => [protocol, source.mode]),
    [
      ['chat', 'references'],
      ['responses', 'first-frame'],
      ['anthropic', 'text']
    ]
  )

  settings.update({
    id: 'vllm-h3',
    model: 'custom-h3',
    url: base + '/local/v1',
    key: 'private-local-key'
  })
  assert.equal(settings.view().profiles['vllm-h3'].steps, 10)
  await skills.generate(project, 'vllm-h3', { episodeId: episode.id, shotId: refShot.id }, signal)
  const form = localRequests[0]
  assert.equal(form.get('model'), 'custom-h3')
  assert.equal(form.get('num_inference_steps'), '10')
  assert.deepEqual(JSON.parse(form.get('extra_params')), { task: 'ref2va', duration: 5 })
  assert.match(form.get('prompt'), /<Audio 1> is the voice-timbre reference for <Subject 1>/)
  const files = form.getAll('input_references')
  assert.deepEqual(
    files.map((file) => file.type),
    ['image/png', 'audio/wav']
  )
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), travelBytes)
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), voiceBytes)

  settings.update({
    id: 'aliyun-video',
    model: 'wan3.0-video',
    url: base + '/wan/api/v1',
    key: 'private-wan-key'
  })
  await skills.generate(project, 'aliyun-video', { episodeId: episode.id, shotId: refShot.id }, signal)
  const upload = voiceUploads[0]
  assert.equal(upload.get('x-oss-object-acl'), 'private')
  assert.deepEqual(Buffer.from(await upload.get('file').arrayBuffer()), voiceBytes)
  assert.deepEqual(wanRequests[0].input.media[1], {
    type: 'reference_audio',
    url: 'oss://' + upload.get('key')
  })
  assert.match(wanRequests[0].input.prompt, /图1中的角色「阿荷」音色参考 音频1/)

  breakFormat = true
  await assert.rejects(
    skills.generate(project, 'minimax-video', { episodeId: episode.id, shotId: refShot.id }, signal),
    /对白.*占位符/
  )
  assert.equal(inputs.length, 6)
  assert.equal(submissions.length, 3)
  assert.deepEqual(problems, [])
  const ref = await executeTool(
    'read_skill',
    { id: 'minimax-video', file: 'references/h3-reference-en.md' },
    ctx
  )
  assert.match(ref.text, /retention_analysis/)
  await assert.rejects(
    executeTool('read_skill', { id: 'minimax-video', file: '../aliyun-video/SKILL.md' }, ctx),
    /文本参考/
  )
})
