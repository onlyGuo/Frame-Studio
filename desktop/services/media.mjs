import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { outputSize, uid } from '../../shared/model.mjs'
import { localDir } from '../core/files.mjs'
const source = fileURLToPath(import.meta.url)
const runtime = source.includes('app.asar' + path.sep)
  ? process.resourcesPath
  : path.resolve(path.dirname(source), '../../runtime')
export const ffmpegPath = path.join(runtime, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

/** 以参数数组调用随包 FFmpeg，保留有限诊断信息。 */
function execute(args, signal, inspection = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      signal
    })
    let log = ''
    proc.stderr.on('data', (bytes) => {
      log = (log + bytes).slice(-32000)
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 || inspection ? resolve(log) : reject(Error('视频编码失败：' + log.slice(-1200)))
    )
  })
}
/** 仅使用本地文件协议，并拒绝无法解码的媒体。 */
async function inspect(file, kind, signal) {
  const log = await execute(['-protocol_whitelist', 'file,pipe', '-i', file], signal, true)
  const audio = /Stream #.*Audio:/.test(log)
  const video = /Stream #.*Video:/.test(log)
  if (kind === 'audio' ? !audio : !video) throw Error('无法读取素材流')
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(log)
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0
  if (kind !== 'image' && !duration) throw Error('无法读取素材时长')
  return { audio, duration: kind === 'image' ? 0 : duration }
}
export const probe = async (file, kind, signal) => (await inspect(file, kind, signal)).duration

/** 校验样音原件体积、流和容器，返回用于绑定及预检的实际秒数。 */
export async function probeVoiceSample(file, signal) {
  const stat = await fs.stat(file)
  const format = path.extname(file).slice(1).toLowerCase()
  if (!['wav', 'mp3'].includes(format) || !stat.isFile() || stat.size > 15_000_000)
    throw Error('角色样音须为不超过 15 MB 的 WAV 或 MP3 文件')
  const duration = await probe(file, 'audio', signal)
  if (duration < 2 || duration > 15) throw Error('角色样音须为 2–15 秒')
  await execute(
    [
      '-v',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file,pipe',
      '-f',
      format,
      '-i',
      file,
      '-map',
      '0:a:0',
      '-t',
      '16',
      '-f',
      'null',
      '-'
    ],
    signal
  ).catch(() => {
    signal?.throwIfAborted()
    throw Error('无法解码样音，请选择有效的 WAV 或 MP3 文件')
  })
  return duration
}

/** 按真实文件头识别工程允许的图片格式；无法读取时同样返回不可用。 */
export function hasImageHeader(pathname, ext) {
  let file
  try {
    file = openSync(pathname, 'r')
    const head = Buffer.alloc(24)
    if (readSync(file, head, 0, head.length, 0) !== head.length) return false
    if (ext === '.png')
      return head.readBigUInt64BE() === 0x89504e470d0a1a0an && head.toString('ascii', 12, 16) === 'IHDR'
    if (ext === '.webp')
      return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
    return ['.jpg', '.jpeg'].includes(ext) && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  } catch {
    return false
  } finally {
    if (file !== undefined) closeSync(file)
  }
}

/** 付费视频生成前真实解码首帧，同时禁止图片访问其他协议。 */
export async function decodeReferenceImage(file, signal) {
  await execute(
    [
      '-v',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-'
    ],
    signal
  )
}

/** 字幕排版和编码共用提交时的工程快照，后续编辑可供另一项导出使用。 */
export async function renderEpisode(project, episodeId, captionSource, signal, progress) {
  const doc = structuredClone(project.data)
  const episode = doc.episodes.find((e) => e.id === episodeId)
  if (!episode?.clips.length) throw Error('请先添加画面片段')
  const captions =
    typeof captionSource === 'function'
      ? await captionSource(doc.ratio, doc.quality, episode.clips)
      : captionSource
  signal?.throwIfAborted()
  const [w, h] = outputSize(doc.ratio, doc.quality)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-render-'))
  const output = path.join(localDir(project.root, 'exports'), uid() + '.mp4')
  const pending = output + '.tmp.mp4'
  const find = (id) => doc.assets.find((a) => a.id === id)
  try {
    for (const [i, clip] of episode.clips.entries()) {
      progress('正在编码片段 ' + (i + 1) + ' / ' + episode.clips.length)
      const asset = find(clip.assetId),
        source = project.assetPath(asset)
      const { audio } = await inspect(source, asset.kind)
      const args = ['-y', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe']
      if (asset.kind === 'image') args.push('-loop', '1', '-framerate', String(doc.fps))
      else args.push('-ss', String(clip.trim))
      args.push('-i', source, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
      let vf =
        '[0:v]fps=' +
        doc.fps +
        ',scale=' +
        w +
        ':' +
        h +
        ':force_original_aspect_ratio=decrease,pad=' +
        w +
        ':' +
        h +
        ':(ow-iw)/2:(oh-ih)/2,setsar=1'
      if (clip.caption) {
        const encoded = captions[clip.id]
        if (typeof encoded !== 'string' || encoded.length > 3000000) throw Error('缺少字幕图层')
        const overlay = path.join(dir, 'caption.png')
        await fs.writeFile(overlay, Buffer.from(encoded, 'base64'))
        args.push('-i', overlay)
        vf += '[base];[base][2:v]overlay=0:0'
      }
      args.push(
        '-filter_complex',
        vf + '[v]',
        '-map',
        '[v]',
        '-map',
        audio ? '0:a:0' : '1:a:0',
        '-af',
        'volume=' + clip.volume + ',apad',
        '-t',
        String(clip.duration),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        path.join(dir, i + '.mp4')
      )
      await execute(args, signal)
    }
    await fs.writeFile(
      path.join(dir, 'list.txt'),
      episode.clips.map((_, i) => "file '" + i + ".mp4'").join('\n')
    )
    const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', path.join(dir, 'list.txt')]
    const filters = []
    for (const [i, track] of episode.audio.entries()) {
      const source = project.assetPath(find(track.assetId))
      args.push(
        '-ss',
        String(track.trim),
        '-t',
        String(track.duration),
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        source
      )
      const delay = Math.round(track.start * 1000)
      filters.push(
        '[' +
          (i + 1) +
          ':a]aformat=channel_layouts=stereo,volume=' +
          track.volume +
          ',adelay=' +
          delay +
          '|' +
          delay +
          '[a' +
          i +
          ']'
      )
    }
    if (filters.length) {
      const mix =
        '[0:a]' +
        episode.audio.map((_, i) => '[a' + i + ']').join('') +
        'amix=inputs=' +
        (filters.length + 1) +
        ':duration=first:normalize=0[out]'
      args.push(
        '-filter_complex',
        [...filters, mix].join(';'),
        '-map',
        '0:v',
        '-map',
        '[out]',
        '-c:v',
        'copy',
        '-c:a',
        'aac'
      )
    } else args.push('-c', 'copy')
    progress('正在合成成片')
    await execute([...args, '-movflags', '+faststart', pending], signal)
    await fs.rename(pending, output)
    return output
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(pending, { force: true })
  }
}
