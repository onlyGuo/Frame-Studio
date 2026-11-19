// 构建时将可迁移的 CPython 及官方 MiniMax 脚本依赖放入发行资源。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const root = path.resolve('runtime/python')
const executable = path.join(root, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const version = '3.12.14'
// 构建机使用官方可迁移 Node 发行版；用户安装后无需系统 Node。
const nodeDir = path.resolve('runtime/node')
fs.mkdirSync(nodeDir, { recursive: true })
const nodeBin = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
const currentVersion = fs.existsSync(nodeBin) && spawnSync(nodeBin, ['--version'], { encoding:'utf8' }).stdout?.trim()
if (currentVersion !== process.version || fs.statSync(nodeBin).size !== fs.statSync(process.execPath).size) {
  // 先复制到同卷临时文件，已有工作进程可继续运行原二进制。
  const staging = nodeBin + '.' + randomUUID() + '.tmp'
  try {
    fs.copyFileSync(process.execPath, staging)
    fs.renameSync(staging, nodeBin)
  } finally {
    fs.rmSync(staging, {force:true})
  }
}
const nodeLicense = path.resolve(
  path.dirname(process.execPath),
  process.platform === 'win32' ? 'LICENSE' : '../LICENSE'
)
if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(nodeDir, 'LICENSE'))

function run(command, args, capture = false) {
  const proc = spawnSync(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8'
  })
  if (proc.error || proc.status !== 0) throw Error(proc.error?.message || command + ' 执行失败')
  return proc.stdout?.trim()
}
if (!fs.existsSync(executable)) {
  run('uv', ['python', 'install', version])
  const binary = run('uv', ['python', 'find', '--managed-python', version], true)
  const resolved = fs.realpathSync(binary)
  const source = process.platform === 'win32' ? path.dirname(resolved) : path.dirname(path.dirname(resolved))
  fs.cpSync(source, root, { recursive: true, verbatimSymlinks: true })
}
const marker = path.join(root, '.studio-requests-2.32.5')
if (!fs.existsSync(marker)) {
  run('uv', ['pip', 'install', '--python', executable, '--break-system-packages', 'requests==2.32.5'])
  fs.writeFileSync(marker, '')
}
run(executable, [
  '-I',
  '-c',
  'import sys, requests, ssl; print("Embedded Python", sys.version.split()[0], "requests", requests.__version__)'
])

// 从平台 wheel 提取独立编码器，无需目标用户安装 Python 包或系统 FFmpeg。
const wheelDir = path.resolve('runtime/ffmpeg-wheel')
const ffDir = path.resolve('runtime/ffmpeg')
const ffBin = path.join(ffDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
if (!fs.existsSync(ffBin)) {
  const bins = path.join(wheelDir, 'imageio_ffmpeg/binaries')
  if (!fs.existsSync(bins))
    run('uv', ['pip', 'install', '--python', executable, '--target', wheelDir, 'imageio-ffmpeg==0.6.0'])
  const binary = fs.readdirSync(bins).find((name) => name.startsWith('ffmpeg-'))
  if (!binary) throw Error('此平台缺少可用的 FFmpeg 二进制')
  fs.mkdirSync(ffDir, { recursive: true })
  fs.copyFileSync(path.join(bins, binary), ffBin)
  fs.chmodSync(ffBin, 0o755)
  fs.copyFileSync(
    path.join(wheelDir, 'imageio_ffmpeg-0.6.0.dist-info/LICENSE'),
    path.join(ffDir, 'IMAGEIO-LICENSE')
  )
}
