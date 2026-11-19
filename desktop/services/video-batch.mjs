import { randomUUID } from 'node:crypto'
import { verifyVideoFiles } from './shot-assets.mjs'

/** 按用户选定的镜头顺序制作视频，已完成镜头随各自的素材一起落盘。 */
export class VideoBatch {
  current = null
  project = null
  controller = null
  constructor(notify) {
    this.notify = notify
  }

  /** 用户查看清单后提交具体镜头 ID，运行期间新加入的分镜不参与此次制作。 */
  start(project, skills, { episodeId, shotIds, skillId }) {
    if (this.controller) throw Error('已有一批分镜视频在生成')
    const episode = project.data.episodes.find((e) => e.id === episodeId)
    if (!episode || !Array.isArray(shotIds) || !shotIds.length) throw Error('请选择要生成的分镜')
    const selectedIds = new Set(shotIds)
    const ids = episode.shots.filter((shot) => selectedIds.has(shot.id)).map((shot) => shot.id)
    if (ids.length !== selectedIds.size) throw Error('分镜清单已改变，请重新选择')
    const selected = skills.resolveMedia('video', skillId)
    const files = new Map()
    for (const shot of episode.shots) {
      if (
        !selectedIds.has(shot.id) ||
        project.data.assets.some((a) => a.id === shot.assetId && a.kind === 'video')
      )
        continue
      try {
        const references = skills.preflightVideo(project, selected, { episodeId, shotId: shot.id })
        for (const ref of references) files.set(ref.path, ref)
      } catch (err) {
        throw Error('分镜「' + shot.title + '」：' + err.message)
      }
    }
    const controller = new AbortController()
    const batch = (this.current = {
      id: randomUUID(),
      title: project.data.title,
      root: project.root,
      episodeId,
      episodeTitle: episode.title,
      total: ids.length,
      done: 0,
      skipped: 0,
      status: 'running',
      shotTitle: ''
    })
    this.controller = controller
    this.project = project
    this.run(project, skills, selected, episodeId, ids, batch, [...files.values()], controller.signal)
    return structuredClone(batch)
  }

  /** 每次提交前核对镜头当前绑定；遇到错误暂停整批，重试只补缺少的视频。 */
  async run(project, skills, selected, episodeId, ids, batch, files, signal) {
    try {
      await verifyVideoFiles(files, signal)
      for (const shotId of ids) {
        signal.throwIfAborted()
        const shot = project.data.episodes.find((e) => e.id === episodeId)?.shots.find((s) => s.id === shotId)
        if (!shot || project.data.assets.some((a) => a.id === shot.assetId && a.kind === 'video')) {
          batch.skipped++
          continue
        }
        batch.shotId = shot.id
        batch.shotTitle = shot.title
        this.notify(batch)
        if (skills.resolveMedia('video', selected.id).model !== selected.model)
          throw Error('视频模型配置已更改')
        const result = await skills.generate(project, selected.id, { episodeId, shotId }, signal)
        if (result.warning) throw Error(result.warning)
        batch.done++
        this.notify(batch, project.snapshot())
      }
      batch.status = signal.aborted ? 'cancelled' : 'completed'
    } catch (err) {
      batch.status = signal.aborted ? 'cancelled' : 'failed'
      if (!signal.aborted) batch.error = err.message
    } finally {
      this.controller = null
      this.project = null
      this.notify(batch, project.snapshot())
    }
  }

  /** 停止当前镜头并取消队列中尚未提交的镜头。 */
  cancel(id) {
    if (this.current?.id === id) this.controller?.abort()
  }
}
