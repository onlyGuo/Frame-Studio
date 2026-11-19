import { createServer } from 'vite'
import electron from 'electron'
import { spawn } from 'node:child_process'
// 开发服务器只向回环地址提供界面，发行版直接读取静态资源。
const server = await createServer({ server: { host: '127.0.0.1', port: 5173 } })
await server.listen()
const proc = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, STUDIO_DEV_URL: server.resolvedUrls.local[0] }
})
proc.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
