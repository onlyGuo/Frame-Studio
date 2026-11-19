import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 主进程与 Skill 子进程读取同一套供应商规则。发布时资源位于 app.asar 外。
const packaged = fileURLToPath(import.meta.url).includes('app.asar' + path.sep)
const source = packaged
  ? pathToFileURL(path.join(process.resourcesPath, 'skills/_lib/video-inputs.mjs'))
  : new URL('../../resources/skills/_lib/video-inputs.mjs', import.meta.url)

export const { isMiniMaxH3, supportsReferenceAudio, validateVideoInputs, videoDurations, videoPromptInput } =
  await import(source.href)
