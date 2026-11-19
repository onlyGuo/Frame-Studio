import assert from 'node:assert/strict'
import test from 'node:test'
import { makeProject, makeShot, makeCard, validateProject } from '../shared/model.mjs'
import { mentionToken, removeSettingCard } from '../shared/mentions.mjs'
import {
  inspectShotAssets,
  setShotAssetFree,
  shotReferenceImages,
  linkNamedCard,
  applyUnavailableImages
} from '../shared/shot-assets.mjs'

test('无资产只对核对过的画面和对白生效，画外音不产生出镜角色', () => {
  const doc = makeProject('转场')
  doc.cards.push({ ...makeCard(), id: 'he', name: '阿荷' })
  const shot = { ...makeShot(), prompt: '纯黑场，画外音提到阿荷', dialogue: '阿荷，你还在吗？' }
  doc.episodes[0].shots.push(shot)
  assert.equal(inspectShotAssets(doc, shot).state, 'unreviewed')
  setShotAssetFree(shot, true)
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(doc))))
  assert.deepEqual(inspectShotAssets(doc, shot), { state: 'none', ready: true, cards: [], issues: [] })
  assert.ok(inspectShotAssets(doc, shot, '换成雨夜').issues.some((issue) => issue.code === 'changed_prompt'))
  shot.dialogue += '别怕。'
  assert.equal(inspectShotAssets(doc, shot).state, 'unreviewed')
  shot.prompt += '。阿荷走入画面。'
  setShotAssetFree(shot, true)
  assert.ok(inspectShotAssets(doc, shot).issues.some((i) => i.code === 'unlinked_card' && i.cardId === 'he'))
  setShotAssetFree(shot, false)
  assert.equal(inspectShotAssets(doc, shot).state, 'unreviewed')
})

test('每张出场卡均须有图，重名、重复出场和共用一个图片 ID 保留正确的角色映射', () => {
  const doc = makeProject('群像')
  const make = (id, name, assetId = '') => ({ ...makeCard(), id, name, assetId })
  doc.cards = [
    make('s1', '车站', 'pic'),
    make('s2', '新车站', 'pic'),
    make('a', '小芸', 'pic'),
    make('b', '小芸')
  ]
  doc.assets.push({ id: 'pic', kind: 'image' })
  const shot = {
    ...makeShot(),
    title: '到站',
    referenceId: 'pic',
    prompt: '@{card:s2}，@{card:a}回头看向@{card:a}。'
  }
  const good = inspectShotAssets(doc, shot)
  assert.equal(good.ready, true)
  const [ref] = shotReferenceImages(doc, shot, good)
  assert.equal(ref.type, '分镜参考')
  assert.deepEqual(
    ref.subjects.map((subject) => subject.cardId),
    ['s2', 'a']
  )
  assert.equal(shotReferenceImages(doc, shot, good).length, 1)
  const offline = applyUnavailableImages(doc, shot, good, new Set(['pic']))
  assert.equal(offline.ready, false)
  assert.deepEqual(
    offline.issues.map((i) => i.cardId),
    ['s2', 'a', undefined]
  )
  assert.ok(offline.cards.every((c) => !c.hasImage))
  assert.ok(good.cards.every((c) => c.hasImage))
  shot.prompt += '新车站亮灯。'
  assert.ok(inspectShotAssets(doc, shot).ready)
  shot.prompt += '@{card:b}'
  assert.deepEqual(
    inspectShotAssets(doc, shot).issues.map((issue) => [issue.code, issue.cardId]),
    [['missing_image', 'b']]
  )
  removeSettingCard(doc, 'b')
  assert.deepEqual(
    inspectShotAssets(doc, shot).issues.map((issue) => [issue.code, issue.cardId]),
    [['missing_card', 'b']]
  )
  shot.prompt = '新车站亮灯。@{card:'
  assert.deepEqual(
    inspectShotAssets(doc, shot)
      .issues.filter((i) => i.code === 'unlinked_card')
      .map((i) => i.cardId),
    ['s2']
  )
  assert.ok(inspectShotAssets(doc, shot).issues.some((i) => i.code === 'invalid_token'))
  assert.ok(
    inspectShotAssets(doc, shot, mentionToken('a')).issues.some((i) => i.code === 'supplemental_reference')
  )
  const line = '旁白：“车站。”新车站，车站前方。@{card:a}'
  assert.equal(linkNamedCard(line, doc.cards, 's1'), '旁白：“车站。”新车站，@{card:s1}前方。@{card:a}')
})
