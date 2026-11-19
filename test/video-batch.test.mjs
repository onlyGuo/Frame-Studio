import test from 'node:test'
import assert from 'node:assert/strict'
import { VideoBatch } from '../desktop/services/video-batch.mjs'

test('批量制作遵循镜头顺序，中断后只补尚未完成的镜头', async () => {
  const shots = ['a', 'b', 'c'].map((id) => ({ id, title: id, assetId: '' }))
  const data = { title: '故事', episodes: [{ id: 'e', title: '首集', shots }], assets: [] }
  const project = { data, root: '/project', snapshot: () => structuredClone(data) }
  const entered = Promise.withResolvers(),
    calls = []
  let end = Promise.withResolvers(),
    interrupt = true
  const batch = new VideoBatch((task) => {
    if (task.status !== 'running') end.resolve(structuredClone(task))
  })
  const skills = {
    resolveMedia: () => ({ id: 'local', model: 'fixture' }),
    preflightVideo: () => [],
    async generate(_project, _skill, { shotId }, signal) {
      calls.push(shotId)
      if (interrupt && shotId === 'b') {
        entered.resolve()
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
      const assetId = 'video-' + shotId
      shots.find((s) => s.id === shotId).assetId = assetId
      data.assets.push({ id: assetId, kind: 'video' })
      return { shotId }
    }
  }
  const options = { episodeId: 'e', shotIds: ['c', 'b', 'a', 'a'], skillId: 'local' }
  const first = batch.start(project, skills, options)
  await entered.promise
  assert.throws(() => batch.start(project, skills, options), /已有一批/)
  batch.cancel(first.id)
  assert.equal((await end.promise).status, 'cancelled')
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(shots[0].assetId, 'video-a')
  end = Promise.withResolvers()
  interrupt = false
  batch.start(project, skills, options)
  const final = await end.promise
  assert.equal(final.done, 2)
  assert.equal(final.skipped, 1)
  assert.deepEqual(calls, ['a', 'b', 'b', 'c'])
})
