import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { Settings } from '../desktop/services/settings.mjs'
import { Commands } from '../desktop/services/commands.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { ffmpegPath, probe } from '../desktop/services/media.mjs'
import { executeTool } from '../desktop/agent/tools.mjs'
import { makeCard, makeShot } from '../shared/model.mjs'
import { mentionToken } from '../shared/mentions.mjs'
import { setShotAssetFree } from '../shared/shot-assets.mjs'
import { validateVideoInputs } from '../resources/skills/_lib/video-inputs.mjs'

test('千问、万相与海螺从分镜读取实际参考图，按模型组装请求；只向对话返回工程回执', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-reference-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const frame = path.join(dir, '构图.png'),
    actor = path.join(dir, '演员.png'),
    video = path.join(dir, 'video.mp4')
  for (const [filename, color, args] of [
    [frame, 'blue', ['-frames:v', '1']],
    [actor, 'red', ['-frames:v', '1']],
    [video, 'red', ['-t', '0.3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264']]
  ])
    execFileSync(ffmpegPath, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=' + color + ':s=400x400',
      ...args,
      filename
    ])
  const frameUrl = 'data:image/png;base64,' + (await fs.readFile(frame)).toString('base64')
  const actorUrl = 'data:image/png;base64,' + (await fs.readFile(actor)).toString('base64')
  const bytes = await fs.readFile(video),
    requests = [],
    downloadHeaders = []
  let base
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url === '/frame.png') {
      downloadHeaders.push(req.headers.authorization)
      return res.end(await fs.readFile(frame))
    }
    if (req.url === '/video.mp4') {
      downloadHeaders.push(req.headers.authorization)
      return res.end(bytes)
    }
    let result
    if (req.method === 'POST') {
      requests.push({ path: req.url, body: JSON.parse(raw), auth: req.headers.authorization })
      if (req.url.endsWith('/multimodal-generation/generation'))
        result = { output: { choices: [{ message: { content: [{ image: base + '/frame.png' }] } }] } }
      else result = req.url.endsWith('/video_generation') ? { task_id: 'v' } : { output: { task_id: 'v' } }
    } else if (req.url.startsWith('/api/query/')) result = { status: 'Success', file_id: 'ready' }
    else if (req.url.startsWith('/api/files/')) result = { file: { download_url: base + '/video.mp4' } }
    else result = { output: { task_status: 'SUCCEEDED', video_url: base + '/video.mp4' } }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((r) => server.close(r)))
  base = 'http://127.0.0.1:' + server.address().port
  const commands = new Commands({
    node: path.resolve('runtime/node', process.platform === 'win32' ? 'node.exe' : 'node'),
    python: path.resolve('runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    ffmpeg: ffmpegPath
  })
  const settings = new Settings(path.join(dir, 'settings'), { seal: (v) => v, open: (v) => v })
  const skills = new Skills(settings, path.resolve('resources/skills'), commands, {
    formatVideo: async (_settings, _skill, _directory, spec) => spec.prompt
  })
  const project = Project.create(dir, '山中', '16:9')
  const [bg, person] = await project.addMedia([frame, actor], probe)
  const card = {
    ...makeCard(),
    type: '角色',
    name: '阿荷',
    notes: '背着竹篓。之后村民欢呼：白鼠狼终于走了，今天过年了。',
    assetId: person.id
  }
  project.save({ ...project.data, cards: [card] })
  const ctx = {
    project,
    skills,
    settings,
    episodeId: project.data.episodes[0].id,
    signal: new AbortController().signal
  }
  async function generate(model, withPerson = true, withFrame = true, scene) {
    const provider = model.startsWith('MiniMax') ? 'minimax-video' : 'aliyun-video'
    settings.update({ id: provider, model, url: base + '/api', key: 'mock-provider-secret', active: true })
    const shot = {
      ...makeShot(),
      title: '山门',
      prompt: withPerson
        ? mentionToken(card.id) + '穿过' + (scene ? mentionToken(scene.id) : '画面')
        : '黑场渐变为白场',
      dialogue: withPerson ? '阿荷：父老乡亲们，我舍不得你们啊。' : '',
      referenceId: withFrame ? bg.id : '',
      duration: 6
    }
    if (!withPerson) setShotAssetFree(shot, true)
    const data = structuredClone(project.data)
    data.episodes[0].shots.push(shot)
    project.save(data)
    const result = await executeTool('generate_media', { kind: 'video', shotId: shot.id }, ctx)
    assert.equal(result.shotId, shot.id)
    assert.equal(result.model, model)
    for (const secret of [base, 'mock-provider-secret', dir, 'base64,'])
      assert.ok(!JSON.stringify(result).includes(secret))
    const submission = requests.at(-1)
    assert.equal(submission.auth, 'Bearer mock-provider-secret')
    assert.ok(!JSON.stringify(submission.body).includes(dir))
    return submission.body
  }
  const multi = await generate('wan3.0-video-prime')
  assert.deepEqual(multi.input.media, [
    { type: 'reference_image', url: frameUrl },
    { type: 'reference_image', url: actorUrl }
  ])
  assert.match(multi.input.prompt, /图1对应分镜参考「山门」.*图2对应角色「阿荷」/)
  assert.match(multi.input.prompt, /父老乡亲们，我舍不得你们啊。/)
  assert.doesNotMatch(multi.input.prompt, /白鼠狼|今天过年了|背着竹篓/)
  assert.deepEqual(multi.parameters, { duration: 6, resolution: '720P', ratio: '16:9', prompt_extend: false })
  const still = await generate('wan3.0-video', false)
  assert.deepEqual(still.input.media, [{ type: 'first_frame', url: frameUrl }])
  const text = await generate('wan3.0-video', false, false)
  assert.equal(text.input.media, undefined)
  assert.match(text.input.prompt, /本镜无对白或旁白/)
  const r2v = await generate('wan2.7-r2v')
  assert.deepEqual(r2v.input.media, [
    { type: 'first_frame', url: frameUrl },
    { type: 'reference_image', url: actorUrl }
  ])
  assert.match(r2v.input.prompt, /图1对应角色「阿荷」/)
  const i2v = await generate('wan2.7-i2v', false, true)
  assert.deepEqual(i2v.input.media, [{ type: 'first_frame', url: frameUrl }])
  assert.equal(i2v.parameters.ratio, undefined)
  const older = await generate('wan2.6-i2v', false, true)
  assert.equal(older.input.img_url, frameUrl)
  const t2v = await generate('wan2.6-t2v', false, false)
  assert.deepEqual(Object.keys(t2v.input), ['prompt'])
  const hailuo = await generate('MiniMax-Hailuo-2.3', false, true)
  assert.equal(hailuo.first_frame_image, frameUrl)
  assert.equal(hailuo.prompt_optimizer, false)
  assert.equal(hailuo.resolution, '768P')
  const accepted = requests.length
  await assert.rejects(generate('wan2.7-i2v'), /参考图.*超过/)
  await assert.rejects(generate('wan2.7-i2v', true, false), /仅接收分镜首帧/)
  await assert.rejects(generate('MiniMax-Hailuo-2.3'), /参考图.*超过/)
  await assert.rejects(generate('wan2.6-t2v'), /无法.*提交参考图/)
  assert.equal(requests.length, accepted)
  const scene = { ...makeCard(), name: '石阶', type: '场景', notes: '山门前有三级石阶', assetId: bg.id }
  project.save({ ...project.data, cards: [...project.data.cards, scene] })
  const before = await generate('wan3.0-video-prime', true, false, scene)
  const renamed = { ...scene, name: '北门石阶' }
  project.save({ ...project.data, cards: [card, renamed] })
  const after = await generate('wan3.0-video-prime', true, false, renamed)
  assert.deepEqual(after.input.media, before.input.media)
  assert.deepEqual(
    after.input.media.map((ref) => ref.url),
    [actorUrl, frameUrl]
  )
  assert.match(before.input.prompt, /图1对应角色「阿荷」.*图2对应场景「石阶」/)
  assert.match(after.input.prompt, /图1对应角色「阿荷」.*图2对应场景「北门石阶」/)
  settings.update({
    id: 'aliyun-image',
    model: 'qwen-image-3.0',
    url: base + '/api',
    key: 'mock-image-secret',
    active: true
  })
  const image = await executeTool(
    'generate_media',
    { kind: 'image', shotId: project.data.episodes[0].shots[0].id },
    ctx
  )
  const submission = requests.at(-1)
  assert.equal(submission.auth, 'Bearer mock-image-secret')
  assert.ok(!JSON.stringify(image).includes('base64,') && !JSON.stringify(image).includes(dir))
  const content = submission.body.input.messages[0].content
  assert.equal(content[0].image, actorUrl)
  assert.equal(content.length, 2)
  assert.match(content[1].text, /图1对应角色「阿荷」/)
  assert.doesNotMatch(content[1].text, /白鼠狼|今天过年了/)
  const outfit = (id, name, assetId) => ({ id, name, assetId, notes: name + '的衣料' })
  const outfitted = {
    ...card,
    outfits: [
      outfit('regular', '常服', person.id),
      outfit('travel', '行装', bg.id),
      outfit('formal', '礼服', '')
    ],
    defaultOutfitId: 'regular',
    assetId: ''
  }
  const explicit = {
    ...makeShot(),
    title: '行装镜头',
    prompt: mentionToken(card.id, 'travel') + '走向出口',
    dialogue: '阿荷：再会。'
  }
  const implicit = { ...makeShot(), title: '常服镜头', prompt: mentionToken(card.id) + '回头' }
  const missing = { ...makeShot(), title: '缺图镜头', prompt: mentionToken(card.id, 'formal') + '作揖' }
  const next = structuredClone(project.data)
  next.cards[0] = outfitted
  next.episodes[0].shots.push(explicit, implicit, missing)
  project.save(next)
  settings.update({ id: 'aliyun-video', model: 'wan3.0-video', url: base + '/api', active: true })
  const submit = (shot, prompt) =>
    executeTool('generate_media', { kind: 'video', shotId: shot.id, prompt }, ctx)
  await submit(explicit)
  assert.deepEqual(
    requests.at(-1).body.input.media.map((item) => item.url),
    [frameUrl]
  )
  assert.match(requests.at(-1).body.input.prompt, /阿荷 · 行装/)
  await submit(implicit)
  assert.deepEqual(
    requests.at(-1).body.input.media.map((item) => item.url),
    [actorUrl]
  )
  const beforeFailures = requests.length
  await assert.rejects(submit(missing), /礼服.*缺少参考图/)
  await assert.rejects(submit(explicit, '今天过年了'), /已保存的画面和对白/)
  assert.equal(requests.length, beforeFailures)
  const generated = await executeTool(
    'generate_media',
    { kind: 'image', cardId: card.id, outfitId: 'formal' },
    ctx
  )
  const roleContent = requests.at(-1).body.input.messages[0].content
  assert.equal(roleContent[0].image, actorUrl)
  assert.match(roleContent[1].text, /礼服的衣料/)
  assert.match(roleContent[1].text, /正面上身、正面全身、面部特写、左侧全身和右侧全身/)
  assert.equal(
    Project.open(project.root).data.cards[0].outfits.find((o) => o.id === 'formal').assetId,
    generated.assetId
  )
  assert.equal(project.data.cards[0].outfits.find((o) => o.id === 'regular').assetId, person.id)
  const extra = await project.addMedia([frame, actor, frame], probe)
  const cards = extra.map((a) => ({ ...makeCard(), assetId: a.id }))
  project.save({ ...project.data, cards: [...project.data.cards, ...cards] })
  const submitted = requests.length
  await assert.rejects(generate('wan2.7-i2v', false, false), /需要参考图/)
  await assert.rejects(
    executeTool(
      'generate_media',
      { kind: 'image', prompt: [card, ...cards].map((c) => mentionToken(c.id)).join('合影') },
      ctx
    ),
    /参考图超过/
  )
  assert.equal(requests.length, submitted)
  assert.ok(downloadHeaders.length === submitted && downloadHeaders.every((v) => v === undefined))
})

test('本机提交前按视频模型核对图片容量，万相 2.7 的额外位置只属于首帧', () => {
  const cards = Array.from({ length: 11 }, (_, i) => ({ type: '角色', name: '角色' + i }))
  const frame = { type: '分镜参考' }
  const check = (model, refs) => validateVideoInputs('aliyun-video', model, refs)
  check('wan3.0-video-prime', cards.slice(0, 10))
  assert.throws(() => check('wan3.0-video-prime', cards), /11 张.*10 张/)
  check('wan2.7-r2v', [frame, ...cards.slice(0, 5)])
  assert.throws(() => check('wan2.7-r2v', cards.slice(0, 6)), /6 张.*5 张/)
  assert.throws(() => check('wan2.7-r2v', [frame, ...cards.slice(0, 6)]), /7 张.*6 张/)
  assert.throws(() => check('wan2.6-r2v', [frame]), /远程素材/)
})
