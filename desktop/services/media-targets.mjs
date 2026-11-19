const running = new Set()

/** 一个已存在的镜头同类生成只提交一次，手动操作、批量制作和助手共用此占用表。 */
export async function withMediaTarget(project, target, run) {
  if (!target || target.library || target.newShot) return run()
  const key = JSON.stringify([
    project.root,
    target.kind,
    target.episodeId,
    target.shotId,
    target.cardId,
    target.outfitId
  ])
  if (running.has(key)) throw Error('此目标正在生成同类媒体，请等待现有任务完成')
  running.add(key)
  try {
    return await run()
  } finally {
    running.delete(key)
  }
}
