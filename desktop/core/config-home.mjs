import fs from 'node:fs'
import path from 'node:path'

const desktopState = new Set(['Local State', 'Preferences', 'Local Storage'])

/** 首次切换时复制设备设置和持久化的桌面状态，再一次性发布新目录。 */
export function configHome(home) {
  const current = path.join(home, '.framestudio')
  const legacy = path.join(home, '.ai-video-studio')
  if (fs.lstatSync(current, { throwIfNoEntry: false }) || !fs.existsSync(legacy)) return current

  const source = fs.realpathSync(legacy)
  const stage = fs.mkdtempSync(path.join(home, '.framestudio-migrate-'))
  try {
    fs.cpSync(source, stage, {
      recursive: true,
      verbatimSymlinks: true,
      filter(file) {
        const [dir, entry] = path.relative(source, file).split(path.sep)
        return dir !== 'desktop' || !entry || desktopState.has(entry)
      }
    })
    // 两个实例同时启动时，已经发布的配置优先。
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) {
      try {
        fs.renameSync(stage, current)
      } catch (err) {
        if (!fs.lstatSync(current, { throwIfNoEntry: false })) throw err
      }
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  return current
}
