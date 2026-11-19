import fs from 'node:fs'
import { Readable } from 'node:stream'
import { localFile } from './files.mjs'
const types = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
}
/** 在给定的工程会话内读取已登记素材，支持播放器的字节范围。 */
export function mediaResponse(project, req) {
  const url = new URL(req.url)
  if (!project || url.hostname !== project.session) return new Response(null, { status: 404 })
  const exported = /^\/exports\/([\w-]+\.mp4)$/.exec(url.pathname)
  const asset = !exported && project.data.assets.find((a) => a.id === url.pathname.slice(1))
  if (!exported && !asset) return new Response(null, { status: 404 })
  let file, size
  try {
    file = exported ? localFile(project.root, 'exports/' + exported[1]) : project.assetPath(asset)
    size = fs.statSync(file).size
  } catch {
    return new Response(null, { status: 404 })
  }
  const range = req.headers.get('range')
  let start = 0,
    end = size - 1
  const headers = {
    'Content-Type': exported ? 'video/mp4' : types[asset.ext],
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 })
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
    if (start > end || start >= size)
      return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } })
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
  }
  headers['Content-Length'] = String(end - start + 1)
  return new Response(
    req.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file, { start, end })),
    { status: range ? 206 : 200, headers }
  )
}
