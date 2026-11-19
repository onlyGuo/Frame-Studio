import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/** 通用本机命令协议，参数独立传递，shell 管道可通过显式调用 shell 使用。 */
export function validateCommand(command) {
  if (
    !command ||
    typeof command.executable !== 'string' ||
    !command.executable.trim() ||
    command.executable.includes('\0') ||
    !Array.isArray(command.args) ||
    command.args.length > 256 ||
    command.args.some((a) => typeof a !== 'string' || a.length > 80000 || a.includes('\0'))
  )
    throw Error('命令需要可执行文件名和字符串参数数组')
  return command
}
/** 任意可执行程序共用的命令运行器，内置解释器与 FFmpeg 也加入子进程 PATH。 */
export class Commands {
  constructor({ node, python, ffmpeg }) {
    this.bins = { node, python, python3: python, ffmpeg }
  }
  /** 按参数数组启动进程，收集受限输出，取消时终止进程树。 */
  async run(command, { cwd, env = {}, input = '', signal, timeout = 1200000, capture = true }) {
    validateCommand(command)
    const paths = [...new Set(Object.values(this.bins).map((p) => path.dirname(p)))]
    const childEnv = {
      PATH: [...paths, process.env.PATH || ''].join(path.delimiter),
      TMPDIR: os.tmpdir(),
      TMP: os.tmpdir(),
      TEMP: os.tmpdir(),
      LANG: process.env.LANG || 'en_US.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ...env
    }
    for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC', 'USERPROFILE', 'HOME'])
      if (process.env[key]) childEnv[key] = process.env[key]
    const name = command.executable,
      bin = Object.hasOwn(this.bins, name) ? this.bins[name] : name
    if (Object.hasOwn(this.bins, name) && !fs.existsSync(bin))
      throw Error('内置运行时缺失，请执行 npm run runtime 或重新安装应用')
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    combined.throwIfAborted()
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, command.args, {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore']
      })
      let stdout = '',
        stderr = ''
      proc.stdout?.setEncoding('utf8').on('data', (b) => (stdout = (stdout + b).slice(-24000)))
      proc.stderr?.setEncoding('utf8').on('data', (b) => (stderr = (stderr + b).slice(-24000)))
      const kill = () => {
        if (!proc.pid) return
        if (process.platform === 'win32')
          spawn('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore'
          }).on('error', () => proc.kill())
        else {
          try {
            process.kill(-proc.pid, 'SIGKILL')
          } catch {
            proc.kill('SIGKILL')
          }
        }
      }
      combined.addEventListener('abort', kill, { once: true })
      proc.on('error', (err) => {
        combined.removeEventListener('abort', kill)
        reject(Error('无法启动命令：' + err.code))
      })
      proc.on('close', (code, reason) => {
        combined.removeEventListener('abort', kill)
        if (signal.aborted) reject(Error('命令已取消'))
        else if (combined.aborted)
          reject(Error('命令执行超时（上限 ' + timeout / 1000 + ' 秒），已停止进程。'))
        else resolve({ code: code ?? 1, reason, stdout, stderr })
      })
      proc.stdin.on('error', () => {})
      proc.stdin.end(input)
    })
  }
}
/** 媒体服务凭据按调用单独构造，不改写应用全局环境。 */
export function providerEnvironment(settings, provider) {
  if (!provider) return {}
  const cfg = settings.credentials(provider)
  return {
    STUDIO_API_URL: cfg.url,
    STUDIO_API_KEY: cfg.key,
    STUDIO_MODEL: cfg.model,
    STUDIO_SECRET_ID: cfg.secretId,
    STUDIO_REGION: cfg.region
  }
}
