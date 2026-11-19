import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as tar from 'tar'
import { makeProject, validateProject, uid, mediaKinds } from '../../shared/model.mjs'
import { validWorkPath } from '../core/work-path.mjs'
import { readJson, writeJson, localDir, localFile } from '../core/files.mjs'
import { AgentHistory, isRunFile } from './agent-history.mjs'
import { contextFile } from './conversation-store.mjs'
import { hasImageHeader, decodeReferenceImage } from './media.mjs'

const manifest = 'studio.json'
const assetName = (a) => a.id + a.ext
/** 目录名跨平台可用；遇到同名工程会分配独立目录。 */
function folderName(title) {
  const name = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return 'Frame-' + (name || 'Project')
}
function newRoot(parent, title) {
  const base = path.join(parent, folderName(title))
  let dir = base
  for (let i = 2; fs.existsSync(dir); i++) dir = base + '-' + i
  return dir
}
/** 管理一个打开的工程及其当前持久化版本。 */
export class Project {
  constructor(root, data) {
    this.root = fs.realpathSync(root)
    this.data = validateProject(data)
    this.session = uid()
    this.offlineImageIds = new Set()
    this.runs = new AgentHistory(this.root)
  }
  /** 在所选父目录创建独立工程，失败时清理新目录。 */
  static create(parent, title, ratio) {
    const data = validateProject(makeProject(title.trim(), ratio))
    const root = newRoot(parent, data.title)
    fs.mkdirSync(root)
    try {
      for (const name of ['media', 'exports', 'work']) localDir(root, name)
      writeJson(path.join(root, manifest), data)
      return new Project(root, data)
    } catch (err) {
      fs.rmSync(root, { recursive: true, force: true })
      throw err
    }
  }
  /** 普通工程可在打开后补回丢失的图片；导入包在发布前必须包含全套素材原件。 */
  static open(root, { requireAllFiles = false } = {}) {
    const data = validateProject({ quality: '720p', fps: 25, ...readJson(localFile(root, manifest)) })
    const project = new Project(root, data)
    localDir(root, 'exports')
    localDir(root, 'work')
    const media = localDir(root, 'media')
    for (const asset of data.assets) {
      try {
        const file = project.assetPath(asset)
        if (asset.kind === 'image' && !hasImageHeader(file, asset.ext)) {
          if (requireAllFiles) throw Error('工程包内的图片格式无效：' + asset.name)
          project.offlineImageIds.add(asset.id)
        }
      } catch (err) {
        if (
          requireAllFiles ||
          asset.kind !== 'image' ||
          err.code !== 'ENOENT' ||
          fs.lstatSync(path.join(media, assetName(asset)), { throwIfNoEntry: false })
        )
          throw err
        project.offlineImageIds.add(asset.id)
      }
    }
    return project
  }
  /** 保留最近一轮执行轨迹，重新打开工程时可回看工具结果。 */
  activity() {
    try {
      const rows = readJson(localFile(this.root, 'last-run.json'))
      return Array.isArray(rows) ? rows.slice(-200) : []
    } catch {
      return []
    }
  }
  /** 提供创作者查看的会话摘要及按需展开的工具详情。 */
  agentHistory() {
    return this.runs.list(this.data.messages)
  }
  agentTrace(id) {
    return this.runs.trace(id, this.data.messages)
  }
  /** 构造发送给桌面界面的工程快照。 */
  snapshot() {
    return {
      root: this.root,
      session: this.session,
      offlineImageIds: [...this.offlineImageIds],
      data: structuredClone(this.data)
    }
  }
  /** 从经过校验的素材索引定位真实文件。 */
  assetPath(a) {
    return localFile(this.root, path.join('media', assetName(a)))
  }
  /** 按原登记找回丢失图片。保留 ID 和全部出场引用，拒绝覆盖任何现存文件。 */
  async recoverImage(id, source) {
    const asset = this.data.assets.find((item) => item.id === id && item.kind === 'image')
    if (!asset) throw Error('请选择要找回的工程图片')
    const format = (ext) => ext.toLowerCase().replace('.jpeg', '.jpg')
    if (format(path.extname(source)) !== format(asset.ext))
      throw Error('请选择与原素材格式相同的图片（' + asset.ext + '）')
    const dir = localDir(this.root, 'media')
    const temp = path.join(dir, '.recover-' + uid() + asset.ext)
    try {
      await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL)
      if (!hasImageHeader(temp, asset.ext)) throw Error('所选文件的图像格式与原素材登记不符')
      await decodeReferenceImage(temp)
      await fsp.copyFile(temp, path.join(dir, assetName(asset)), fs.constants.COPYFILE_EXCL)
      this.offlineImageIds.delete(id)
    } catch (err) {
      if (err.code === 'EEXIST') throw Error('工程内的原文件仍在。如需替换设定图，请在设定卡中绑定新图片。')
      throw err
    } finally {
      await fsp.rm(temp, { force: true })
    }
  }
  /** 乐观版本校验避免旧窗口或异步操作静默覆盖更新。 */
  save(draft) {
    validateProject(draft)
    const file = localFile(this.root, manifest)
    if (
      draft.id !== this.data.id ||
      draft.revision !== this.data.revision ||
      readJson(file).revision !== draft.revision
    )
      throw Error('工程版本已改变，请重新打开后再编辑')
    const next = { ...draft, revision: draft.revision + 1 }
    writeJson(file, next)
    this.data = next
    return next.revision
  }
  /** 先复制并探测媒体，再将整批素材登记到同一个版本。 */
  async addMedia(files, probe, label, attach) {
    const assets = []
    const copied = []
    try {
      for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        const kind = mediaKinds[ext]
        if (!kind || !fs.statSync(file).isFile()) throw Error('不支持的媒体文件')
        const a = { id: uid(), name: (label || path.basename(file)).slice(0, 300), ext, kind, duration: 0 }
        const dest = path.join(localDir(this.root, 'media'), assetName(a))
        await fsp.copyFile(file, dest, fs.constants.COPYFILE_EXCL)
        copied.push(dest)
        if (kind === 'image' && !hasImageHeader(dest, ext)) throw Error('图片内容与文件扩展名不匹配')
        a.duration = await probe(dest, kind)
        assets.push(a)
      }
      const draft = structuredClone(this.data)
      draft.assets.push(...assets)
      if (attach) attach(draft, assets)
      this.save(draft)
      return assets
    } catch (err) {
      for (const file of copied) await fsp.rm(file, { force: true })
      throw err
    }
  }
  /** 将清单、引用素材及成片快照打入流式压缩包。 */
  async archive(file) {
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'frame-pack-'))
    const output = file + '.' + uid() + '.tmp'
    try {
      const doc = structuredClone(this.data)
      writeJson(path.join(temp, manifest), doc)
      const members = [manifest]
      for (const folder of ['media', 'exports', 'work']) await fsp.mkdir(path.join(temp, folder))
      const events = this.activity()
      if (events.length) {
        writeJson(path.join(temp, 'last-run.json'), events)
        members.push('last-run.json')
      }
      const entries = doc.assets.map((a) => ['media/' + assetName(a), this.assetPath(a)])
      if (fs.existsSync(path.join(this.root, contextFile)))
        entries.push([contextFile, localFile(this.root, contextFile)])
      for (const name of this.runs.files()) entries.push([name, localFile(this.root, name)])
      for (const name of await fsp.readdir(localDir(this.root, 'exports'))) {
        if (/^[\w-]+\.mp4$/i.test(name))
          entries.push(['exports/' + name, localFile(this.root, 'exports/' + name)])
      }
      // 命令生成的代码和辅助文件同样随工程迁移。
      async function collectWork(root, relative) {
        for (const item of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
          const name = relative + '/' + item.name
          if (!validWorkPath(name) || item.isSymbolicLink()) throw Error('工作目录含不可移植文件：' + name)
          if (item.isDirectory()) await collectWork(root, name)
          else if (item.isFile()) entries.push([name, localFile(root, name)])
        }
      }
      await collectWork(this.root, 'work')
      for (const [name, from] of entries) {
        await fsp.mkdir(path.dirname(path.join(temp, name)), { recursive: true })
        await fsp.copyFile(from, path.join(temp, name), fs.constants.COPYFILE_FICLONE)
        members.push(name)
      }
      await tar.c({ cwd: temp, file: output, gzip: true, portable: true }, members)
      await fsp.rename(output, file)
    } finally {
      await fsp.rm(temp, { recursive: true, force: true })
      await fsp.rm(output, { force: true })
    }
  }
  /** 只解包项目格式允许的普通文件，验证完成后才使新工程可见。 */
  static async restore(file, parent) {
    const stage = await fsp.mkdtemp(path.join(parent, '.frame-import-'))
    let invalid = false,
      total = 0
    const names = new Set()
    try {
      await tar.x({
        file,
        cwd: stage,
        strict: true,
        filter(name, entry) {
          total += entry.size
          const ok =
            entry.type === 'File' &&
            (name === manifest ||
              (name === contextFile && entry.size <= 64 * 1024 ** 2) ||
              (name === 'last-run.json' && entry.size < 2000000) ||
              (isRunFile(name) && entry.size < 32 * 1024 ** 2) ||
              validWorkPath(name) ||
              /^(media\/[A-Za-z0-9_-]+\.(png|jpe?g|webp|mp4|webm|mov|mp3|wav|m4a|ogg)|exports\/[\w-]+\.mp4)$/i.test(
                name
              )) &&
            !names.has(name.toLowerCase()) &&
            names.size < 15000 &&
            total < 64 * 1024 ** 3 &&
            (name !== manifest || entry.size < 32 * 1024 ** 2)
          names.add(name.toLowerCase())
          if (!ok) invalid = true
          return ok
        }
      })
      if (invalid) throw Error('工程包包含无效条目或超出容量限制')
      const staged = Project.open(stage, { requireAllFiles: true })
      const root = newRoot(parent, staged.data.title)
      await fsp.rename(stage, root)
      return Project.open(root)
    } finally {
      await fsp.rm(stage, { recursive: true, force: true })
    }
  }
}
