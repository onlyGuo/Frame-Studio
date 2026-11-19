import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { studioRuntime } from '../desktop/agent/studio-runtime.mjs'
import { conversation } from '../desktop/agent/protocols.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { Skills } from '../desktop/services/skills.mjs'
import { agentDefaults } from '../shared/agent-settings.mjs'

/** 使用旧版设备配置启动，修改助手运行参数并重启读取。 */
test('助手运行设置支持旧配置、单独保存和校验', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-config-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'config.json')
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, llm: 'anthropic', profiles: {}, disabled: [], recent: [] })
  )
  const settings = new Settings(root, {})
  assert.deepEqual(settings.view().agent, agentDefaults)
  const legacy = { contextThreshold: 150000, idleTimeoutSeconds: 450 }
  await fs.writeFile(file, JSON.stringify({ ...settings.data, agent: legacy }))
  const migrated = new Settings(root, {})
  const carriedOver = { contextThreshold: 150000, responseTimeoutSeconds: 450 }
  assert.deepEqual(migrated.view().agent, carriedOver)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).agent, carriedOver)
  const updated = { contextThreshold: 180000, responseTimeoutSeconds: 480 }
  migrated.setAgentPreferences(updated)
  assert.throws(() => migrated.setAgentPreferences({ ...updated, contextThreshold: NaN }), /阈值/)
  assert.throws(() => migrated.setAgentPreferences({ ...updated, responseTimeoutSeconds: 0 }), /超时/)
  assert.deepEqual(new Settings(root, {}).view().agent, updated)
  assert.equal(migrated.view().llm, 'anthropic')
})

test('启停创作指南和更新本机提示词可改变下一轮指令，工具定义保持原生协议', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-guides-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const settings = new Settings(root, {})
  const skills = new Skills(settings, path.resolve('resources/skills'), {})
  const runtime = () => studioRuntime({ settings, skills, episodeId: 'episode-1' })
  assert.match(runtime().system, /复用同一设定卡/)
  skills.manage('story-production', 'disable')
  assert.doesNotMatch(runtime().system, /复用同一设定卡/)
  await fs.mkdir(path.join(root, 'prompts'), { recursive: true })
  await fs.writeFile(path.join(root, 'prompts', 'AGENT.md'), '按试映版流程完成工作。')
  const { system, tools } = runtime()
  assert.match(system, /按试映版流程/)
  assert.ok(tools.some((tool) => tool.name === 'run_command'))
  assert.ok(!tools.some((tool) => tool.name === 'generate_media'))
  const content = '{"name":"run_command","commands":[{"executable":"node","args":["--version"]}]}'
  for (const [protocol, response] of [
    ['chat', { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }],
    [
      'responses',
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }]
      }
    ],
    ['anthropic', { stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }]
  ]) {
    const session = conversation(protocol, { system, tools, history: [], model: 'fixture' })
    assert.ok(session.body().tools.length)
    assert.deepEqual(session.receive(response), { text: content, calls: [] })
  }
})
