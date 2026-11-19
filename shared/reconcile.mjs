// 工作区保存与后台工具可以交错。仅把创作者相对其所读版本的更改应用到最新工程。
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** 以实体 ID 合并列表，用户编辑的字段优先；保留后台新增的分镜、素材和消息。 */
export function reconcile(base, edited, latest) {
  if (same(base, edited)) return latest
  if (same(base, latest)) return edited
  if (Array.isArray(base) && Array.isArray(edited) && Array.isArray(latest)) {
    const originals = new Map(base.map((item) => [item.id, item]))
    const local = new Map(edited.map((item) => [item.id, item]))
    const remote = new Map(latest.map((item) => [item.id, item]))
    const changedOrder = !same(
      base.map((i) => i.id),
      edited.map((i) => i.id)
    )
    const order = new Set([
      ...(changedOrder ? local : remote).keys(),
      ...(changedOrder ? remote : local).keys()
    ])
    const result = []
    for (const id of order) {
      const before = originals.get(id),
        ours = local.get(id),
        theirs = remote.get(id)
      if (before && !ours) continue
      if (before && !theirs && same(before, ours)) continue
      result.push(before && ours && theirs ? reconcile(before, ours, theirs) : (ours ?? theirs))
    }
    return result
  }
  if (
    base &&
    edited &&
    latest &&
    typeof base === 'object' &&
    typeof edited === 'object' &&
    typeof latest === 'object'
  ) {
    return Object.fromEntries(
      Object.keys(edited).map((key) => [key, reconcile(base[key], edited[key], latest[key])])
    )
  }
  return edited
}
