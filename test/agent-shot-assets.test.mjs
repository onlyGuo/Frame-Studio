import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { executeTool } from '../desktop/agent/tools.mjs'
import { runAgent } from '../desktop/services/agent.mjs'
import { ffmpegPath, probe } from '../desktop/services/media.mjs'
import { Project } from '../desktop/services/projects.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { makeCard, makeProject, makeShot } from '../shared/model.mjs'
import { mentionToken } from '../shared/mentions.mjs'
import { applyPlan } from '../shared/plan.mjs'
import { inspectShotAssets } from '../shared/shot-assets.mjs'

test('工具可在写入镜头时确认无资产，镜头改稿后需按新脚本复查', () => {
  const doc = makeProject('片尾')
  const episodeId = doc.episodes[0].id
  const update = (draft, op, fields) =>
    applyPlan(draft, [{ op, fields, episodeId, target: 'shots', id: 'end' }])
  const review = (draft) => inspectShotAssets(draft, draft.episodes[0].shots[0])
  const signed = update(doc, 'add', { assetFree: true, prompt: '全黑转场' })
  assert.equal(review(signed).state, 'none')
  const edited = update(signed, 'update', { prompt: '白色片尾字幕' })
  assert.equal(review(edited).ready, false)
  assert.equal(review(update(edited, 'update', { assetFree: true })).ready, true)
  assert.throws(() => update(edited, 'update', { assetFree: 'true' }), /布尔/)
})

test('助手依据真实预检补建场景卡、绑定用户定妆、补图一次，两个镜头复用同一组图片', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-agent-assets-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const image = path.join(dir, '林夕定妆.png'),
    video = path.join(dir, '片段.mp4')
  for (const [file, options] of [
    [image, ['-frames:v', '1']],
    [video, ['-t', '0.2', '-c:v', 'libx264']]
  ])
    execFileSync(ffmpegPath, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64',
      ...options,
      file
    ])
  const settings = new Settings(path.join(dir, 'settings'), { seal: (s) => s, open: (s) => s })
  for (const [id, model] of [
    ['chat', 'mock-chat'],
    ['aliyun-image', 'qwen-image-3.0'],
    ['aliyun-video', 'wan3.0-video']
  ])
    settings.update({
      id,
      model,
      url: 'https://example.invalid/' + id,
      key: 'test-private-key',
      active: true
    })
  const project = Project.create(dir, '车站', '16:9')
  const [portrait] = await project.addMedia([image], probe)
  const actor = { ...makeCard(), name: '林夕' }
  const shots = ['走向站台', '在站台停下'].map((action) => ({
    ...makeShot(),
    prompt: '林夕在旧车站' + action
  }))
  const episode = { ...project.data.episodes[0], shots }
  project.save({ ...project.data, cards: [actor], episodes: [episode] })
  const commands = []
  const skills = new Skills(
    settings,
    path.resolve('resources/skills'),
    {
      async run(_command, { input }) {
        const spec = JSON.parse(input)
        commands.push(spec)
        await fs.copyFile(spec.output.endsWith('.png') ? image : video, spec.output)
        return { code: 0 }
      }
    },
    { formatVideo: async (_settings, _skill, _directory, spec) => spec.prompt }
  )

  // 每一轮均从上一轮实际回执取数据，模型和计费服务均由本地响应代替。
  const call = (name, args) => ({ name, args })
  const check = (shot) => call('read_project', { section: 'shot_assets', shotId: shot.id })
  const generate = (shot) => ({ skill: 'video', shotId: shot.id })
  const run = (...commands) => call('run_command', { commands })
  const sceneId = 'station'
  let suppliedImageId
  const turns = [
    () => [check(shots[0])],
    ([report]) => {
      assert.equal(report.ready, false)
      assert.ok(report.issues.some((i) => i.code === 'unlinked_card' && i.cardId === actor.id))
      return [run(generate(shots[0]))]
    },
    ([
      {
        results: [rejected]
      }
    ]) => {
      assert.equal(rejected.status, 'failed')
      assert.ok(rejected.error)
      assert.ok(rejected.issues.every((i) => i.code && i.message))
      assert.equal(commands.length, 0)
      return [call('read_project', { section: 'assets', kind: 'image', query: '林夕定妆' })]
    },
    ([assets]) => {
      assert.deepEqual(
        assets.items.map((a) => a.id),
        [portrait.id]
      )
      return [
        call('edit_project', {
          actions: [
            {
              op: 'add',
              target: 'cards',
              id: sceneId,
              fields: { name: '旧车站', type: '场景', notes: '青砖站台与旧钟' }
            },
            { op: 'update', target: 'cards', id: actor.id, fields: { assetId: assets.items[0].id } },
            ...shots.map((shot) => ({
              op: 'update',
              target: 'shots',
              id: shot.id,
              fields: {
                prompt: shot.prompt
                  .replace('林夕', mentionToken(actor.id))
                  .replace('旧车站', mentionToken(sceneId))
              }
            }))
          ]
        })
      ]
    },
    () => [check(shots[0])],
    ([report]) => {
      assert.deepEqual(
        report.issues.map((i) => [i.code, i.cardId]),
        [['missing_image', sceneId]]
      )
      return [run({ skill: 'image', cardId: report.issues[0].cardId })]
    },
    ([
      {
        results: [image]
      }
    ]) => {
      assert.equal(image.cardId, sceneId)
      suppliedImageId = image.assetId
      return [run({ skill: 'image', cardId: sceneId }), check(shots[0]), check(shots[1])]
    },
    ([
      {
        results: [existing]
      },
      ...reports
    ]) => {
      assert.equal(existing.reused, true)
      assert.equal(existing.assetId, suppliedImageId)
      for (const report of reports) {
        assert.equal(report.ready, true)
        assert.deepEqual(
          report.cards.map((c) => c.assetId),
          [portrait.id, suppliedImageId]
        )
      }
      return [run(...shots.map(generate))]
    },
    ([{ results: receipts }]) => {
      assert.deepEqual(
        receipts.map((r) => r.shotId),
        shots.map((s) => s.id)
      )
      return []
    }
  ]
  let round = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.match(body.messages[0].content, /同一设定卡/)
    assert.ok(!init.body.includes(dir))
    assert.ok(!init.body.includes('test-private-key'))
    const results = []
    for (const message of body.messages.toReversed()) {
      if (message.role !== 'tool') break
      results.unshift(JSON.parse(message.content))
    }
    const calls = turns[round++](results)
    const message = calls.length
      ? {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(({ name, args }, n) => ({
            type: 'function',
            id: 'call-' + round + '-' + n,
            function: { name, arguments: JSON.stringify(args) }
          }))
        }
      : { role: 'assistant', content: '两个镜头已使用同一角色和场景定稿。' }
    return Response.json({ choices: [{ message, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
  })
  const ctx = { settings, skills, project, episodeId: episode.id, signal: new AbortController().signal }
  await runAgent(ctx, '完成林夕在旧车站的两个镜头，使用我导入的林夕定妆图。')
  assert.equal(round, turns.length)
  assert.equal(commands.length, 3)
  for (const spec of commands.slice(1))
    assert.deepEqual(
      spec.references.map((r) => r.assetId),
      [portrait.id, suppliedImageId]
    )
  assert.ok(Project.open(project.root).data.episodes[0].shots.every((s) => s.assetId))
  const { items } = await executeTool('read_project', { section: 'cards', query: '林夕' }, ctx)
  assert.equal(items[0].referenceImage.id, portrait.id)
  assert.equal(items[0].referenceImage.available, true)
  settings.update({ id: 'aliyun-video', model: 'wan2.6-t2v', url: 'https://example.invalid/aliyun-video' })
  const unavailable = await executeTool('read_project', check(shots[0]).args, ctx)
  assert.equal(unavailable.ready, false)
  assert.equal(unavailable.videoModel.model, 'wan2.6-t2v')
  assert.equal(unavailable.issues[0].code, 'reference_unsupported')
  assert.equal(commands.length, 3)
  await t.test('图片从磁盘消失或只剩合法文件头时，补图替换失效绑定', async () => {
    settings.update({
      id: 'aliyun-video',
      model: 'wan3.0-video',
      url: 'https://example.invalid/aliyun-video'
    })
    const repairs = [
      { cardId: actor.id, assetId: portrait.id, damage: (file) => fs.unlink(file) },
      { cardId: sceneId, assetId: suppliedImageId, damage: (file) => fs.truncate(file, 24) }
    ]
    for (const { cardId, assetId, damage } of repairs) {
      const original = project.data.assets.find((a) => a.id === assetId)
      await damage(project.assetPath(original))
      const checkResult = await executeTool('read_project', check(shots[0]).args, ctx)
      assert.equal(checkResult.ready, false)
      assert.ok(checkResult.issues.some((issue) => issue.code === 'missing_file' && issue.cardId === cardId))
      assert.equal(checkResult.cards.find((c) => c.cardId === cardId).hasImage, false)
      const fixed = await executeTool('generate_media', { kind: 'image', cardId }, ctx)
      assert.notEqual(fixed.assetId, assetId)
      assert.equal(fixed.cardId, cardId)
      assert.equal(project.data.cards.find((c) => c.id === cardId).assetId, fixed.assetId)
      const reuse = await executeTool('generate_media', { kind: 'image', cardId }, ctx)
      assert.equal(reuse.reused, true)
      assert.equal(reuse.assetId, fixed.assetId)
    }
    assert.equal(commands.length, 5)
    assert.ok(Project.open(project.root).data.cards.every((c) => c.assetId))
  })
})
