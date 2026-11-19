import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeCard, makeShot } from '../shared/model.mjs'
import { mentionToken } from '../shared/mentions.mjs'
import { setShotAssetFree } from '../shared/shot-assets.mjs'
import { applyPlan } from '../shared/plan.mjs'
import { ffmpegPath, probe } from '../desktop/services/media.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { executeTool } from '../desktop/agent/tools.mjs'
import { runWorkCommand } from '../desktop/services/work-command.mjs'
import { inspectProjectShotAssets } from '../desktop/services/shot-assets.mjs'
import { VideoBatch } from '../desktop/services/video-batch.mjs'

/** 使用真实视频文件及相同工具入口，替代供应商的联网与计费。 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-shot-target-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const png = path.join(dir, 'reference.png'),
    mp4 = path.join(dir, 'shot.mp4')
  for (const [out, args] of [
    [png, ['-frames:v', '1']],
    [mp4, ['-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']]
  ])
    execFileSync(ffmpegPath, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64',
      ...args,
      out
    ])
  const settings = new Settings(path.join(dir, 'settings'), { seal: (s) => s, open: (s) => s })
  for (const [id, model] of [
    ['aliyun-image', 'qwen-image-3.0'],
    ['aliyun-video', 'wan3.0-video-prime']
  ])
    settings.update({ id, model, url: 'https://example.invalid/api', key: 'local-only', active: true })
  const calls = []
  const commands = {
    async run(_command, options) {
      const spec = JSON.parse(options.input)
      calls.push(spec)
      await commands.beforeOutput?.()
      await fs.copyFile(spec.output.endsWith('.png') ? png : mp4, spec.output)
      return { code: 0 }
    }
  }
  const project = Project.create(dir, '视频归属', '16:9')
  const skills = new Skills(settings, path.resolve('resources/skills'), commands, {
    formatVideo: async (_settings, _skill, _directory, spec) => spec.prompt
  })
  const ctx = {
    project,
    skills,
    settings,
    episodeId: project.data.episodes[0].id,
    signal: new AbortController().signal
  }
  return { ctx, calls, commands, png, mp4 }
}

test('分镜视频与素材单次落盘，保留旧镜头参考图；Agent 收到镜头回执且 Skill 取得实际引用图片', async (t) => {
  const { ctx, calls, png } = await fixture(t)
  const { project, episodeId } = ctx
  const [reference, frame] = await project.addMedia([png, png], probe)
  const draft = structuredClone(project.data),
    card = makeCard(),
    shot = makeShot()
  Object.assign(card, { name: '旅行者', notes: '蓝色围巾', assetId: reference.id })
  Object.assign(shot, { prompt: mentionToken(card.id) + '进入车站', assetId: frame.id })
  delete shot.referenceId
  draft.cards.push(card)
  draft.episodes[0].shots.push(shot)
  project.save(draft)
  const revision = project.data.revision
  const result = await executeTool('generate_media', { kind: 'video', shotId: shot.id }, ctx)
  assert.deepEqual([result.episodeId, result.shotId], [episodeId, shot.id])
  assert.equal(project.data.revision, revision + 1)
  const saved = Project.open(project.root).data
  assert.equal(saved.episodes[0].shots[0].assetId, result.assetId)
  assert.equal(saved.episodes[0].shots[0].referenceId, frame.id)
  assert.equal(saved.episodes[0].shots[0].prompt, shot.prompt)
  assert.match(calls[0].prompt, /旅行者进入车站/)
  assert.doesNotMatch(calls[0].prompt, /蓝色围巾/)
  assert.deepEqual(
    calls[0].references.map((r) => r.assetId),
    [frame.id, reference.id]
  )
  assert.ok(await fs.stat(calls[0].references[0].path))
  assert.ok(!JSON.stringify(result).includes(project.root))
  const image = await executeTool('generate_media', { kind: 'image', shotId: shot.id }, ctx)
  assert.equal(project.data.episodes[0].shots[0].assetId, result.assetId)
  assert.equal(project.data.episodes[0].shots[0].referenceId, image.assetId)
  const reused = applyPlan(project.data, [
    { target: 'shots', episodeId, op: 'update', id: shot.id, fields: { assetId: frame.id } }
  ])
  assert.equal(reused.episodes[0].shots[0].assetId, result.assetId)
  assert.equal(reused.episodes[0].shots[0].referenceId, frame.id)
})

test('自动视频建立新镜头，多候选时计费前要求目标，显式独立视频留在库中', async (t) => {
  const { ctx, calls } = await fixture(t)
  const gen = (args) =>
    executeTool('generate_media', { kind: 'video', prompt: '纯色淡出', assetFree: true, ...args }, ctx)
  const initial = await gen({})
  assert.equal(ctx.project.data.episodes[0].shots[0].id, initial.shotId)
  assert.equal(ctx.project.data.episodes[0].shots[0].assetId, initial.assetId)
  const d = structuredClone(ctx.project.data)
  d.episodes[0].shots.push(makeShot(), makeShot())
  ctx.project.save(d)
  await assert.rejects(gen({}), /多个待制作分镜/)
  await assert.rejects(gen({ shotId: 'missing' }), /目标分镜不存在/)
  assert.equal(calls.length, 1)
  const extra = await gen({ destination: 'library' })
  assert.equal(extra.shotId, undefined)
  assert.ok(!ctx.project.data.episodes[0].shots.some((s) => s.assetId === extra.assetId))
  const added = await gen({ destination: 'newShot', shotTitle: '片尾' })
  assert.equal(ctx.project.data.episodes[0].shots.at(-1).id, added.shotId)
  assert.equal(ctx.project.data.episodes[0].shots.at(-1).title, '片尾')
})

test('同镜头并行生成只调用一次；工作期间目标改绑保留人工选择，同时回报已生成的素材', async (t) => {
  const { ctx, calls, commands, mp4 } = await fixture(t)
  const { project } = ctx
  const [other] = await project.addMedia([mp4], probe)
  const draft = structuredClone(project.data),
    shot = makeShot()
  shot.prompt = '纯色淡入'
  setShotAssetFree(shot, true)
  draft.episodes[0].shots.push(shot)
  project.save(draft)
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  commands.beforeOutput = async () => {
    entered.resolve()
    await release.promise
  }
  const args = { kind: 'video', shotId: shot.id }
  const running = executeTool('generate_media', args, ctx)
  await entered.promise
  await assert.rejects(executeTool('generate_media', args, ctx), /正在生成同类媒体/)
  const manual = structuredClone(project.data)
  manual.episodes[0].shots[0].assetId = other.id
  project.save(manual)
  release.resolve()
  const output = await running
  assert.match(output.warning, /素材库/)
  assert.equal(project.data.episodes[0].shots[0].assetId, other.id)
  assert.equal(calls.length, 1)
  assert.equal(project.data.assets.at(-1).id, output.assetId)
})

test('单镜、整批、独立视频及通用命令在缺图、缺文件和模型丢图时均不启动供应商命令', async (t) => {
  const { ctx, calls, png } = await fixture(t)
  const { project, episodeId, settings, skills, signal } = ctx
  const [image] = await project.addMedia([png], probe)
  const card = { ...makeCard(), name: '阿荷' }
  const ready = { ...makeShot(), title: '淡入', prompt: '纯白渐显' }
  setShotAssetFree(ready, true)
  const shot = { ...makeShot(), title: '返程', prompt: mentionToken(card.id) + '探出头' }
  const d = structuredClone(project.data)
  d.cards.push(card)
  d.episodes[0].shots.push(ready, shot)
  project.save(d)
  const target = { episodeId, shotId: shot.id }
  const gen = () => skills.generate(project, 'aliyun-video', target, signal)
  await assert.rejects(gen(), /阿荷.*缺少参考图/)
  assert.throws(
    () =>
      new VideoBatch(() => {}).start(project, skills, {
        episodeId,
        shotIds: [ready.id, shot.id],
        skillId: 'aliyun-video'
      }),
    /返程.*阿荷/
  )
  const commands = {
    async run() {
      throw Error('不应启动命令')
    }
  }
  const cmd = (args) =>
    runWorkCommand(
      project,
      settings,
      commands,
      { executable: 'node', args: [], provider: 'aliyun-video', ...args },
      signal
    )
  await assert.rejects(cmd(target), /视频产物扩展名/)
  await assert.rejects(cmd({ extension: '.png', ...target }), /视频产物扩展名/)
  await assert.rejects(cmd({ extension: '.mp4', ...target }), /阿荷.*缺少参考图/)
  await assert.rejects(
    cmd({ extension: '.mp4', destination: 'library', prompt: '阿荷入画', assetFree: true }),
    /阿荷.*引用/
  )
  const bound = structuredClone(project.data)
  bound.cards[0].assetId = image.id
  project.save(bound)
  settings.update({ id: 'aliyun-video', model: 'wan2.6-t2v', url: 'https://example.invalid/api' })
  await assert.rejects(gen(), /无法向该型号提交参考图/)
  await assert.rejects(cmd({ extension: '.mp4', ...target }), /无法向该型号提交参考图/)
  settings.update({ id: 'aliyun-video', model: 'wan3.0-video', url: 'https://example.invalid/api' })
  const file = project.assetPath(image)
  const bytes = await fs.readFile(file)
  await fs.writeFile(file, bytes.subarray(0, 24))
  await assert.rejects(gen(), /无法完整解码/)
  const finished = Promise.withResolvers()
  new VideoBatch((event) => {
    if (event.status === 'failed') finished.resolve(event)
  }).start(project, skills, { episodeId, shotIds: [ready.id, shot.id], skillId: 'aliyun-video' })
  assert.match((await finished.promise).error, /无法完整解码/)
  await fs.unlink(file)
  const reopened = Project.open(project.root)
  assert.equal(inspectProjectShotAssets(reopened, shot).issues[0].code, 'missing_file')
  await assert.rejects(gen(), /阿荷.*丢失或损坏/)
  assert.equal(calls.length, 0)
})

test('自定义视频 Skill 仅按声明的实图容量交付全部图片，可实现自行支持的供应商型号', async (t) => {
  const { ctx, png, calls } = await fixture(t)
  const { project, episodeId, skills, signal, settings } = ctx
  const [image] = await project.addMedia([png], probe)
  const card = { ...makeCard(), name: '旅人', assetId: image.id }
  const shot = { ...makeShot(), prompt: mentionToken(card.id) + '推门' }
  const d = structuredClone(project.data)
  d.cards.push(card)
  d.episodes[0].shots.push(shot)
  project.save(d)
  settings.update({ id: 'aliyun-video', model: 'custom-r2v', url: 'https://example.invalid/api' })
  const source = path.join(path.dirname(project.root), 'extension')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'SKILL.md'), '# 自定义视频')
  const manifest = {
    id: 'custom-video',
    name: '自定义视频',
    description: '接收参考图片',
    kind: 'video',
    provider: 'aliyun-video',
    extension: '.mp4',
    command: { executable: 'node', args: [] }
  }
  const install = async (args) => {
    await fs.writeFile(path.join(source, 'skill.json'), JSON.stringify({ ...manifest, ...args }))
    skills.install(source)
  }
  const target = { shotId: shot.id, episodeId }
  await install({})
  await assert.rejects(skills.generate(project, manifest.id, target, signal), /声明可提交 0 张/)
  assert.equal(calls.length, 0)
  skills.manage(manifest.id, 'remove')
  await install({ maxReferenceImages: 1 })
  assert.equal(skills.resolveMedia('video', manifest.id).maxReferenceImages, 1)
  await skills.generate(project, manifest.id, target, signal)
  assert.equal(calls[0].references[0].cardId, card.id)
})

test('命令产物按审核目标绑定，并向受信脚本提供角色图的真实文件', async (t) => {
  const { ctx, png, mp4 } = await fixture(t)
  const { project, episodeId, settings, signal } = ctx
  const [image] = await project.addMedia([png], probe)
  const card = { ...makeCard(), name: '邮差', assetId: image.id }
  const shot = { ...makeShot(), prompt: mentionToken(card.id) + '走入画面' }
  const d = structuredClone(project.data)
  d.cards.push(card)
  d.episodes[0].shots.push(shot)
  project.save(d)
  let submitted
  const commands = {
    async run(_args, { env }) {
      submitted = JSON.parse(env.STUDIO_REFERENCES)
      await fs.copyFile(mp4, env.STUDIO_OUTPUT)
      return { code: 0 }
    }
  }
  const out = await runWorkCommand(
    project,
    settings,
    commands,
    { executable: 'node', args: [], provider: 'aliyun-video', extension: '.mp4', episodeId, shotId: shot.id },
    signal
  )
  assert.equal(out.binding.shotId, shot.id)
  assert.equal(submitted[0].cardId, card.id)
  assert.deepEqual(await fs.readFile(submitted[0].path), await fs.readFile(png))
})
