import { createServer } from 'vite'
import electron from 'electron'
import { spawn } from 'node:child_process'
// 开发服务器只向回环地址提供界面，发行版直接读取静态资源。
const server = await createServer({ server: { host: '127.0.0.1', port: 5173 } })
try {
  await server.listen()
  const url = server.resolvedUrls.local[0]
  console.log(`开发服务器已启动 ${url}`)
  const { code, signal } = await new Promise((resolve, reject) => {
    const proc = spawn(electron, ['.'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, STUDIO_DEV_URL: url }
    })
    proc.once('error', reject)
    proc.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (signal) console.error(`Electron 收到 ${signal} 后退出。`)
  process.exitCode = code ?? 1
} finally {
  await server.close()
}
