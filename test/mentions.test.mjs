import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mentionToken,
  parseMentions,
  resolveMentions,
  removeSettingCard,
  indexShotMentions
} from '../shared/mentions.mjs'
import { makeProject, makeShot, makeCard } from '../shared/model.mjs'
import { applyPlan } from '../shared/plan.mjs'

test('存量分镜原样传给生成；稳定引用保留段落且同名资产仅按 ID 匹配', () => {
  const first = { ...makeCard(), id: 'actor_01', name: '阿宁', notes: '蓝色风衣', assetId: 'portrait' }
  const other = { ...makeCard(), id: 'actor_02', name: '阿宁', notes: '白色制服' }
  const prop = { ...makeCard(), id: 'object', type: '道具', name: '罗盘' }
  const plain = '推近镜头。\n\n收住。'
  assert.deepEqual(resolveMentions(plain, []), { text: plain, cards: [] })
  assert.deepEqual(parseMentions(''), [])
  const source =
    mentionToken(first.id) + '走入画面\n' + mentionToken(first.id) + '拿起' + mentionToken(prop.id)
  const result = resolveMentions(source, [other, first, prop])
  assert.deepEqual(result.cards, [first, prop])
  assert.equal(result.text, '阿宁走入画面\n阿宁拿起罗盘\n\n视觉设定\n【角色】阿宁：蓝色风衣\n【道具】罗盘')
  first.name = '叶宁'
  assert.match(resolveMentions(source, [first, prop]).text, /^叶宁走入画面/)
  assert.throws(() => resolveMentions(source, [prop]), /actor_01/)
})
test('人工与智能体删除设定时，各分集保留可发现、可替换的缺失引用', () => {
  const project = makeProject('资产引用')
  const card = { ...makeCard(), name: '旧城剧场' }
  project.cards.push(card)
  project.episodes[0].shots.push({ ...makeShot(), prompt: '全景 ' + mentionToken(card.id) })
  project.episodes.push({ ...structuredClone(project.episodes[0]), id: 'ep2' })
  const manual = structuredClone(project)
  removeSettingCard(manual, card.id)
  const agent = applyPlan(project, [{ op: 'remove', target: 'cards', id: card.id }])
  assert.deepEqual(manual, agent)
  assert.deepEqual(
    agent.episodes.map((e) => e.shots[0].prompt),
    ['全景 ' + mentionToken(card.id), '全景 ' + mentionToken(card.id)]
  )
  assert.equal(agent.cards.length, 0)
})

test('本集资产和设定卡引用索引按分集镜头定位，重复出场只计一个镜头', () => {
  const token = mentionToken('station')
  const first = {
    id: 'e1',
    title: '上集',
    shots: [
      { id: 's1', title: '车站外景', prompt: token + token },
      { id: 's2', title: '空镜', prompt: '夜景' }
    ]
  }
  const second = { id: 'e2', title: '下集', shots: [{ id: 's3', title: '返程', prompt: token }] }
  assert.deepEqual(indexShotMentions([first, second]).get('station'), [
    { episodeId: 'e1', episodeTitle: '上集', shotId: 's1', shotTitle: '车站外景', number: 1 },
    { episodeId: 'e2', episodeTitle: '下集', shotId: 's3', shotTitle: '返程', number: 1 }
  ])
})
