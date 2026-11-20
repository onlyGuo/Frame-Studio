import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeAudio, makeClip, makeProject, makeShot, validateProject } from '../shared/model.mjs'
import { roughCut, clipFromShot } from '../shared/rough-cut.mjs'
import { executeTool } from '../desktop/agent/tools.mjs'
import { Project } from '../desktop/services/projects.mjs'

const asset = (id, kind = 'video', duration = 4) => ({
  id,
  kind,
  ext: kind === 'video' ? '.mp4' : '.png',
  duration: kind === 'video' ? duration : 0,
  name: id
})
const shot = (id, assetId) => ({ ...makeShot(), id, assetId, title: id, dialogue: '字幕' + id, duration: 6 })

test('对白转字幕清除角色标签，分镜保留原文，正文人名及冒号保留', () => {
  const cards = [{ id: 'bai', type: '角色', name: '白小纯' }]
  const examples = [
    ['白小纯：父老乡亲们，我要去修仙了，可我舍不得你们啊。', '父老乡亲们，我要去修仙了，可我舍不得你们啊。'],
    ['@{card:bai:robe}：别走。\n旁白：天亮了。', '别走。\n天亮了。'],
    ['白小纯（低声）：记住：白小纯会回来。', '记住：白小纯会回来。'],
    ['@{card:deleted}：我会回来。白小纯：等你！', '我会回来。等你！'],
    ['注意：现在是12:30。', '注意：现在是12:30。'],
    ['我叫白小纯。', '我叫白小纯。'],
    ['', '']
  ]
  for (const [dialogue, expected] of examples) {
    const source = { ...shot('one', 'v'), dialogue }
    assert.equal(clipFromShot(source, asset('v'), cards).caption, expected)
    const e = { clips: [], shots: [source] }
    assert.equal(roughCut(e, [asset('v')], cards).clips[0].caption, expected)
    assert.equal(source.dialogue, dialogue)
  }
})

test('已有画面手工调序、裁切、音频与前后插片保留，复用同一源的分镜分别补入', () => {
  const p = makeProject('手工精剪'),
    e = p.episodes[0]
  p.assets = ['src', 'cut', 'manual'].map((id) => asset(id))
  e.shots = ['one', 'two', 'three', 'four', 'five'].map((id, i) => shot(id, i === 2 ? 'cut' : 'src'))
  const intro = makeClip('manual', 1),
    outro = makeClip('manual', 1)
  const legacy = { ...makeClip('src', 2), trim: 1, volume: 0.5, caption: '人工字幕' }
  const first = { ...makeClip('cut', 1), sourceShotId: 'three' },
    second = { ...makeClip('cut', 1), sourceShotId: 'three', trim: 1 }
  e.clips = [intro, legacy, first, second, outro]
  e.audio = [{ ...makeAudio('manual', 1), start: 3 }]
  const original = structuredClone(p)
  const result = roughCut(e, p.assets)
  assert.equal(result.linked, 1)
  assert.equal(result.added, 3)
  assert.deepEqual(
    result.clips.map((c) => c.sourceShotId || c.assetId),
    ['manual', 'one', 'two', 'three', 'three', 'four', 'five', 'manual']
  )
  assert.deepEqual(result.clips[1], { ...legacy, sourceShotId: 'one' })
  assert.equal(result.clips[2].duration, 4)
  assert.equal(result.clips[2].caption, '字幕two')
  assert.deepEqual(result.clips[3], first)
  assert.deepEqual(result.clips[4], second)
  assert.deepEqual(p, original)
  e.clips = result.clips
  assert.deepEqual(roughCut(e, p.assets).clips, e.clips)
  validateProject(p)
})

test('Agent 与工程领域共用粗剪，空镜及参考图跳过，重试保持修订号与手工操作', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-rough-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const project = Project.create(dir, '分镜粗剪', '16:9'),
    draft = structuredClone(project.data),
    e = draft.episodes[0]
  draft.assets = [asset('v'), asset('still', 'image')]
  e.shots = [shot('intro', 'still'), shot('action', 'v'), shot('empty', '')]
  e.shots[1].duration = 2
  e.shots[1].dialogue = '字幕'.repeat(270)
  project.save(draft)
  const ctx = { project, episodeId: e.id }
  const first = await executeTool('rough_cut', {}, ctx),
    rev = project.data.revision
  assert.equal(first.added, 1)
  assert.equal(first.subtitlesShortened, 1)
  assert.equal(first.pending, 2)
  const [clip] = project.data.episodes[0].clips
  assert.equal(clip.assetId, 'v')
  assert.equal(clip.sourceShotId, 'action')
  assert.equal(clip.duration, 2)
  assert.equal(clip.caption.length, 500)
  assert.equal((await executeTool('rough_cut', {}, ctx)).added, 0)
  assert.equal(project.data.revision, rev)
  assert.equal(project.data.episodes[0].shots[1].dialogue.length, 540)
})
