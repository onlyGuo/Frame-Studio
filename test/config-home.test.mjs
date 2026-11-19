import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configHome } from '../desktop/core/config-home.mjs'

test('新配置目录首次复制旧配置，后续启动沿用新目录', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-config-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const old = path.join(home, '.ai-video-studio')
  const current = path.join(home, '.framestudio')
  assert.equal(configHome(home), current)
  assert.equal(fs.existsSync(current), false)
  const durable = [
    'config.json',
    path.join('prompts', 'AGENT.md'),
    path.join('skills', 'custom', 'example', 'SKILL.md'),
    path.join('desktop', 'Local State'),
    path.join('desktop', 'Local Storage', 'leveldb', 'CURRENT')
  ]
  const cache = path.join('desktop', 'GPUCache', 'data')
  for (const file of [...durable, cache]) {
    const full = path.join(old, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, file)
  }

  assert.equal(configHome(home), current)
  for (const file of durable) assert.equal(fs.readFileSync(path.join(current, file), 'utf8'), file)
  assert.equal(fs.existsSync(path.join(current, cache)), false)
  assert.equal(fs.readFileSync(path.join(old, 'config.json'), 'utf8'), 'config.json')

  fs.writeFileSync(path.join(current, 'config.json'), '新配置')
  configHome(home)
  assert.equal(fs.readFileSync(path.join(current, 'config.json'), 'utf8'), '新配置')
  assert.deepEqual(fs.readdirSync(home).sort(), ['.ai-video-studio', '.framestudio'])
})
