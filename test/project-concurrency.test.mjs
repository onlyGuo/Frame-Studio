import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeCard, makeClip, makeShot } from '../shared/model.mjs'
import { mentionToken } from '../shared/mentions.mjs'
import { prepareMediaTarget, commitMediaTarget } from '../shared/shot-media.mjs'
import { inspectProjectShotAssets } from '../desktop/services/shot-assets.mjs'
import { mediaResponse } from '../desktop/core/protocol.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { ffmpegPath, probe, renderEpisode } from '../desktop/services/media.mjs'
import { runWorkCommand } from '../desktop/services/work-command.mjs'
import { executeTool } from '../desktop/agent/tools.mjs'

/** 建立独立工程与能够实际编码的测试帧。 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-concurrency-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const project = Project.create(dir, '并行制作', '16:9')
  const image = path.join(dir, 'frame.png')
  execFileSync(ffmpegPath, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=s=64x64',
    '-frames:v',
    '1',
    image
  ])
  return { project, image, signal: new AbortController().signal }
}

test('探测中的两批素材先后提交，同时保留期间保存的工程编辑', async (t) => {
  const { project, image } = await fixture(t)
  const releases = [],
    ready = Promise.withResolvers()
  function pausedProbe() {
    const pending = Promise.withResolvers()
    releases.push(pending.resolve)
    if (releases.length === 2) ready.resolve()
    return pending.promise
  }
  const imports = ['手动素材', '生成素材'].map((label) => project.addMedia([image], pausedProbe, label))
  await ready.promise
  project.save({ ...project.data, synopsis: '制作中更新的梗概' })
  for (const done of releases) done(0)
  const batches = await Promise.all(imports)
  const saved = Project.open(project.root)
  assert.equal(saved.data.synopsis, '制作中更新的梗概')
  assert.deepEqual(new Set(saved.data.assets.map((a) => a.id)), new Set(batches.flat().map((a) => a.id)))
  assert.equal(saved.data.assets.length, 2)
})

test('恢复丢失原图后两镜重新可用，保持同一 ID，也不会覆盖已找回的文件', async (t) => {
  const { project, image } = await fixture(t)
  const [picture] = await project.addMedia([image], probe)
  const card = { ...makeCard(), name: '阿荷', assetId: picture.id }
  const shots = [1, 2].map(() => ({ ...makeShot(), prompt: mentionToken(card.id) + '走出画面' }))
  project.save({ ...project.data, cards: [card], episodes: [{ ...project.data.episodes[0], shots }] })
  await fs.unlink(project.assetPath(picture))
  const opened = Project.open(project.root)
  const request = new Request('studio-media://' + opened.session + '/' + picture.id, { method: 'HEAD' })
  assert.equal(mediaResponse(opened, request).status, 404)
  assert.ok(shots.every((s) => !inspectProjectShotAssets(opened, s).ready))
  await opened.recoverImage(picture.id, image)
  assert.equal(mediaResponse(opened, request).status, 200)
  assert.ok(shots.every((s) => inspectProjectShotAssets(opened, s).ready))
  await assert.rejects(opened.recoverImage(picture.id, image), /原文件仍在/)
  const pack = path.join(path.dirname(image), 'recovered.framepack')
  await opened.archive(pack)
  const restored = await Project.restore(pack, path.dirname(image))
  assert.equal(restored.data.cards[0].assetId, picture.id)
  assert.deepEqual(await fs.readFile(restored.assetPath(picture)), await fs.readFile(image))
})

test('在途视频仅在引用图、分镜内容及画面设置仍匹配时绑定', async (t) => {
  const { project, image } = await fixture(t)
  const [portrait, revision] = await project.addMedia([image, image], probe)
  const card = { ...makeCard(), assetId: portrait.id }
  const shot = { ...makeShot(), prompt: mentionToken(card.id) + '走近' }
  const data = structuredClone(project.data)
  data.cards.push(card)
  data.episodes[0].shots.push(shot)
  const target = prepareMediaTarget(data, 'video', { shotId: shot.id })
  const video = { id: 'completed', kind: 'video' }
  card.assetId = revision.id
  assert.match(commitMediaTarget(data, video, target).warning, /出场资产已更改/)
  assert.equal(shot.assetId, '')
  card.assetId = portrait.id
  shot.prompt += '，回头'
  assert.match(commitMediaTarget(data, video, target).warning, /脚本/)
  shot.prompt = mentionToken(card.id) + '走近'
  data.synopsis = '其他编辑可以继续'
  assert.equal(commitMediaTarget(data, video, target).shotId, shot.id)
})

test('后台命令返回本次生成的素材，即使同时入库的手动素材排在末尾', async (t) => {
  const { project, image, signal } = await fixture(t)
  const register = project.addMedia.bind(project)
  // 控制交错顺序：命令完成入库后、读取界面快照前，另一个导入也已经完成。
  project.addMedia = async (...args) => {
    const generated = await register(...args)
    await register([image], probe, '手动素材')
    return generated
  }
  const commands = {
    async run(spec, options) {
      await fs.copyFile(image, options.env.STUDIO_OUTPUT)
      return { code: 0, stderr: '', stdout: '' }
    }
  }
  const result = await executeTool(
    'run_command',
    { executable: 'node', args: [], extension: '.png' },
    {
      project,
      signal,
      approve: async () => true,
      command: (spec) => runWorkCommand(project, {}, commands, spec, signal)
    }
  )
  assert.equal(project.data.assets.at(-1).name, '手动素材')
  assert.equal(result.asset.id, project.data.assets[0].id)
})

test('同一分集并行导出分别使用各自发起时的字幕、画幅及时间线', async (t) => {
  const { project, image, signal } = await fixture(t)
  const [asset] = await project.addMedia([image], probe)
  const edited = structuredClone(project.data),
    episode = edited.episodes[0]
  episode.clips = [{ ...makeClip(asset.id, 0.32), caption: '初版字幕' }]
  project.save(edited)

  const overlay = (await fs.readFile(image)).toString('base64')
  const firstPass = Promise.withResolvers()
  const seen = []
  async function captions(ratio, quality, [clip]) {
    seen.push([ratio, clip.caption, clip.duration])
    if (clip.caption === '初版字幕') await firstPass.promise
    return { [clip.id]: overlay }
  }
  const first = renderEpisode(project, episode.id, captions, signal, () => {})
  const next = structuredClone(project.data)
  Object.assign(next.episodes[0].clips[0], { duration: 0.8, caption: '新版字幕' })
  project.save({ ...next, ratio: '9:16' })
  const second = renderEpisode(project, episode.id, captions, signal, () => {})
  firstPass.resolve()

  const [firstFile, secondFile] = await Promise.all([first, second])
  assert.notEqual(firstFile, secondFile)
  assert.deepEqual(seen, [
    ['16:9', '初版字幕', 0.32],
    ['9:16', '新版字幕', 0.8]
  ])
  assert.ok(Math.abs((await probe(firstFile, 'video')) - 0.32) < 0.05)
  assert.ok(Math.abs((await probe(secondFile, 'video')) - 0.8) < 0.05)
  assert.equal((await fs.readdir(path.join(project.root, 'exports'))).length, 2)
})
