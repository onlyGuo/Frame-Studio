import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Project } from '../desktop/services/projects.mjs'
import { Settings } from '../desktop/services/settings.mjs'

test('列表移除保留工程，彻底删除限定已确认的工程目录且不跟随链接', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-remove-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const settings = new Settings(path.join(root, 'config'), { seal: (v) => v, open: (v) => v })
  const project = Project.create(root, '删除测试', '16:9')
  const other = Project.create(root, '保留工程', '16:9')
  settings.remember(project.root, project.data)
  settings.remember(other.root, other.data)
  settings.forget(project.root)
  assert.equal(settings.data.recent.length, 1)
  assert.equal(Project.open(project.root).data.id, project.data.id)
  const reloaded = new Settings(settings.root, settings.vault)
  assert.deepEqual(reloaded.data.recent, settings.data.recent)
  const target = Project.deletionTarget(project.root)
  const wrong = { ...target, id: other.data.id }
  assert.throws(() => Project.deleteFiles(wrong), /已改变/)
  await fs.writeFile(path.join(project.root, 'work', 'test.txt'), '待删除')
  await fs.symlink(other.root, path.join(project.root, 'linked-project'), 'junction')
  Project.deleteFiles(target)
  await assert.rejects(fs.access(project.root), { code: 'ENOENT' })
  assert.equal(Project.open(other.root).data.id, other.data.id)
  assert.throws(() => Project.deletionTarget(root))
  assert.throws(() => Project.deletionTarget(os.homedir()), /无法删除/)
})
