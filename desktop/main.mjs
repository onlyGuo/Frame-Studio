import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  shell,
  Menu,
  nativeTheme
} from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Commands } from './services/commands.mjs'
import { ffmpegPath } from './services/media.mjs'
import { Project } from './services/projects.mjs'
import { Skills } from './services/skills.mjs'
import { Settings } from './services/settings.mjs'
import { BackgroundAgent } from './agent/background.mjs'
import { VideoBatch } from './services/video-batch.mjs'
import { reconcile } from '../shared/reconcile.mjs'
import { renderEpisode, probe, probeVoiceSample } from './services/media.mjs'
import { mediaResponse } from './core/protocol.mjs'
import { runWorkCommand } from './services/work-command.mjs'
import { requestCaptions, receiveCaptions } from './core/caption-request.mjs'
import { mediaKinds } from '../shared/model.mjs'
import { prepareMediaTarget, commitMediaTarget } from '../shared/shot-media.mjs'
import { configHome } from './core/config-home.mjs'
const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const isMac = process.platform === 'darwin'
const dev =
  !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(process.env.STUDIO_DEV_URL || '')
    ? process.env.STUDIO_DEV_URL
    : null
const entry = dev || pathToFileURL(path.join(base, 'dist/index.html')).href
const root = configureStorage()
let win,
  homeWindow,
  settingsWindow,
  quitting = false,
  settings,
  skills,
  commands,
  active,
  task
const agent = new BackgroundAgent((event) => {
  if (win && !win.isDestroyed()) win.webContents.send('studio:agent-event', event)
})
const batch = new VideoBatch((task, state) => {
  if (win && !win.isDestroyed()) win.webContents.send('studio:batch', { task, state })
})
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'studio-media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  }
])
if (!root) app.quit()
else if (!app.requestSingleInstanceLock()) {
  if (dev) {
    console.error('无法启动开发版：已有帧序实例正在使用同一配置目录。请完全退出该实例后重试 npm run dev。')
    app.exit(1)
  } else app.quit()
} else {
  // 开发启动器退出时，让窗口完成正常的保存与关闭流程。
  if (dev && process.send) process.once('disconnect', () => app.quit())
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('second-instance', () => {
    const target = BrowserWindow.getFocusedWindow() || win || homeWindow || settingsWindow
    if (target?.isMinimized()) target.restore()
    target?.show()
    target?.focus()
  })
  app
    .whenReady()
    .then(() => {
      if (isMac && !app.isPackaged) app.dock.setIcon(path.join(base, 'build/icon.png'))
      settings = new Settings(root, {
        seal(value) {
          if (!safeStorage.isEncryptionAvailable()) throw Error('请先解锁系统密钥存储')
          return safeStorage.encryptString(value).toString('base64')
        },
        open: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
      })
      nativeTheme.themeSource = settings.data.appearance
      nativeTheme.on('updated', () => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!isMac) {
            window.setBackgroundColor(windowColor())
            window.setTitleBarOverlay(titleBarColors())
          }
          window.webContents.send('studio:appearance', nativeTheme.shouldUseDarkColors)
        }
      })
      const resource = app.isPackaged ? process.resourcesPath : path.join(base, 'resources')
      const pythonRoot = app.isPackaged ? path.join(resource, 'python') : path.join(base, 'runtime/python')
      const nodeRoot = app.isPackaged ? path.join(resource, 'node') : path.join(base, 'runtime/node')
      commands = new Commands({
        node: path.join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node'),
        python: path.join(pythonRoot, process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
        ffmpeg: ffmpegPath
      })
      skills = new Skills(settings, path.join(resource, 'skills'), commands)
      // 跨工程查看后台结果时，沿用该任务的只读素材会话。
      protocol.handle('studio-media', (req) =>
        mediaResponse(new URL(req.url).hostname === active?.session ? active : agent.project, req)
      )
      register()
      createWindow('home')
      app.on('window-all-closed', () => app.quit())
    })
    .catch((err) => {
      dialog.showErrorBox('工作室启动失败', err.message)
      app.quit()
    })
}
/** 先确定配置位置，再让 Electron 打开浏览器状态并获取单实例锁。 */
function configureStorage() {
  try {
    const directory = (!app.isPackaged && process.env.STUDIO_TEST_HOME) || configHome(os.homedir())
    app.setPath('userData', path.join(directory, 'desktop'))
    return directory
  } catch (err) {
    dialog.showErrorBox('工作室启动失败', '无法打开本地配置目录。\n' + err.message)
    return null
  }
}
/** 窗口与网页用相同的底色，加载工程时保持连贯。 */
function windowColor() {
  return nativeTheme.shouldUseDarkColors ? '#202226' : '#f5f6f8'
}
/** 让系统窗口按钮沿用工作室工具栏的背景和文字颜色。 */
function titleBarColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#292c31', symbolColor: '#e8edf5' }
    : { color: '#eceef1', symbolColor: '#202630' }
}
/** 创建隔离渲染窗口并协调关闭前保存。 */
function createWindow(role = 'project') {
  const home = role === 'home'
  const preferences = role === 'settings'
  let ready = false,
    allowed = false
  const window = new BrowserWindow({
    width: home ? 820 : preferences ? 760 : 1440,
    height: home ? 620 : preferences ? 650 : 940,
    minWidth: home ? 660 : preferences ? 580 : 900,
    minHeight: home ? 440 : preferences ? 440 : 600,
    title: home
      ? '工程面板 · 帧序'
      : preferences
        ? '设置 · 帧序'
        : (active?.data.title || '工程') + ' · 帧序',
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 43, ...(isMac ? {} : titleBarColors()) },
    ...(isMac
      ? { vibrancy: 'sidebar', visualEffectState: 'followWindow', trafficLightPosition: { x: 14, y: 15 } }
      : {}),
    autoHideMenuBar: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'studio-icon.png')
      : path.join(base, 'build/icon.png'),
    backgroundColor: isMac ? '#00000000' : windowColor(),
    show: false,
    webPreferences: {
      preload: path.join(base, 'desktop/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  if (home) homeWindow = window
  else if (preferences) settingsWindow = window
  else win = window
  window.studioRole = role
  window.allowStudioClose = () => {
    allowed = true
    window.close()
  }
  window.registerStudioClose = () => {
    ready = true
  }
  window.on('page-title-updated', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== entry) event.preventDefault()
  })
  // 新文档需要重新注册保存回调；空白页和加载错误页可以直接关闭。
  window.webContents.on('did-navigate', () => {
    ready = false
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!allowed && ready && !window.webContents.isCrashed()) {
      event.preventDefault()
      window.webContents.send('studio:close')
    }
  })
  window.on('closed', () => {
    if (home) homeWindow = null
    else if (preferences) settingsWindow = null
    else {
      win = null
      active = null
      task?.abort()
      batch.cancel(batch.current?.id)
      agent.cancel(agent.current?.id)
      if (!quitting) showHome()
    }
  })
  const menu = [{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]
  if (process.platform === 'darwin') menu.unshift({ role: 'appMenu' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
  window.loadURL(entry).catch((err) => {
    if (window.isDestroyed() || err.code === 'ERR_ABORTED') return
    console.error('无法加载工作室界面', err.message)
    if (!dev) dialog.showErrorBox('工作室启动失败', err.message)
    window.close()
  })
}
/** 工程面板与工程窗口共享主进程服务，分别管理各自的页面状态。 */
function showHome() {
  if (!homeWindow) createWindow('home')
  homeWindow.show()
  if (homeWindow.isMinimized()) homeWindow.restore()
  homeWindow.focus()
  homeWindow.webContents.send('studio:recent', settings.data.recent)
}
/** 使用系统原生选择器取得用户选择的目录。 */
async function directory(title) {
  const r = await dialog.showOpenDialog(
    BrowserWindow.getFocusedWindow() || win || homeWindow || settingsWindow,
    {
      title,
      properties: ['openDirectory', 'createDirectory']
    }
  )
  return r.canceled ? null : r.filePaths[0]
}
/** 建立当前工程会话，并更新最近列表。 */
function selectProject(project) {
  const working = [agent.controller && agent.project, batch.project].find((p) => p?.root === project.root)
  active = working || project
  settings.remember(project.root, project.data)
  if (!win) createWindow()
  else {
    win.show()
    win.focus()
  }
  win.setTitle(active.data.title + ' · 帧序')
  homeWindow?.hide()
  homeWindow?.webContents.send('studio:recent', settings.data.recent)
  return active.snapshot()
}
/** 核验 IPC 的目标仍是当前工程。 */
function projectFor(session) {
  if (!active || active.session !== session) throw Error('请重新打开工作区')
  return active
}
/** 对话可从当前工程或仍显示在全局面板中的任务工程读取。 */
function transcriptProject(session) {
  if (agent.project && agent.project.session === session) return agent.project
  return projectFor(session)
}
/** 长任务共享取消信号且互斥执行。 */
async function job(run) {
  if (task) throw Error('请等待当前任务完成')
  task = new AbortController()
  try {
    return await run(task.signal)
  } finally {
    task = null
  }
}
/** 让预览排版器生成字幕，再调用统一的成片编码器。 */
async function exportFilm(project, episodeId, signal, progress) {
  return renderEpisode(
    project,
    episodeId,
    (ratio, quality, clips) => requestCaptions(win, ratio, quality, clips, signal),
    signal,
    progress
  )
}
/** 所有文件选择、项目切换与密钥解密集中在主进程。 */
function register() {
  const routes = {
    initial: (_p, window) => ({
      windowRole: window.studioRole,
      recent: settings.data.recent,
      config: settings.view(),
      darkMode: nativeTheme.shouldUseDarkColors,
      skills: skills.list(),
      current: window.studioRole !== 'project' ? undefined : active?.snapshot(),
      agentTask: window.studioRole !== 'project' ? undefined : agent.snapshot(),
      videoBatch: window.studioRole !== 'project' ? undefined : batch.current
    }),
    create: async (p) => {
      const dir = await directory('选择新工程的父目录')
      return dir && selectProject(Project.create(dir, p.title, p.ratio))
    },
    open: async () => {
      const dir = await directory('打开包含 studio.json 的工程目录')
      return dir && selectProject(Project.open(dir))
    },
    recent: (p) => {
      if (!settings.data.recent.some((r) => r.root === p.root)) throw Error('最近工程不存在')
      return selectProject(Project.open(p.root))
    },
    closeProject: () => {
      active = null
      return settings.data.recent
    },
    save: (p) => {
      const project = projectFor(p.session)
      const oldTitle = project.data.title,
        oldRatio = project.data.ratio
      const updated =
        p.base && p.base.revision !== project.data.revision ? reconcile(p.base, p.data, project.data) : p.data
      project.save({ ...updated, revision: p.base ? project.data.revision : p.data.revision })
      if (oldTitle !== project.data.title || oldRatio !== project.data.ratio)
        settings.remember(project.root, project.data)
      return project.snapshot()
    },
    archive: async (p) => {
      const project = projectFor(p.session)
      const r = await dialog.showSaveDialog(win, {
        defaultPath: 'Frame-Studio.framepack',
        filters: [{ name: '帧序工程', extensions: ['framepack'] }]
      })
      if (!r.canceled) {
        await project.archive(r.filePath)
        return r.filePath
      }
    },
    restore: async (_p, window) => {
      const r = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: '帧序工程', extensions: ['framepack'] }]
      })
      if (r.canceled) return
      const parent = await directory('选择导入工程的父目录')
      return parent && selectProject(await Project.restore(r.filePaths[0], parent))
    },
    addMedia: async (p) => {
      const project = projectFor(p.session)
      const imagesOnly = p.kind === 'image'
      const target = p.cardId && prepareMediaTarget(project.data, 'audio', p)
      const extensions = Object.entries(mediaKinds)
        .filter(([ext, kind]) => (target ? ['.mp3', '.wav'].includes(ext) : !imagesOnly || kind === 'image'))
        .map(([ext]) => ext.slice(1))
      const r = await dialog.showOpenDialog(win, {
        title: target ? '上传角色样音' : imagesOnly ? '选择设定参考图' : '导入媒体',
        properties: target || imagesOnly ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [{ name: target ? '角色样音' : imagesOnly ? '图片' : '媒体素材', extensions }]
      })
      if (r.canceled) return
      let binding
      const inspect = target ? (file) => probeVoiceSample(file) : probe
      const added = await project.addMedia(
        r.filePaths,
        inspect,
        undefined,
        target
          ? (draft, [audio]) => {
              binding = commitMediaTarget(draft, audio, target)
            }
          : undefined
      )
      return { ...project.snapshot(), importedIds: added.map((a) => a.id), ...binding }
    },
    recoverImage: async (p) => {
      const project = projectFor(p.session)
      const asset = project.data.assets.find((a) => a.id === p.id && a.kind === 'image')
      if (!asset) throw Error('请选择要找回的工程图片')
      const extensions = ['.jpg', '.jpeg'].includes(asset.ext) ? ['jpg', 'jpeg'] : [asset.ext.slice(1)]
      const selected = await dialog.showOpenDialog(win, {
        title: '找回「' + asset.name + '」的原图',
        properties: ['openFile'],
        filters: [{ name: '原图格式', extensions }]
      })
      if (selected.canceled) return false
      await project.recoverImage(asset.id, selected.filePaths[0])
      return project.snapshot()
    },
    settings: (p) => settings.update(p),
    agentPreferences: (p) => settings.setAgentPreferences(p),
    appearance: (p) => {
      nativeTheme.themeSource = settings.setAppearance(p.mode)
      return { mode: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }
    },
    agentHistory: (p) => transcriptProject(p.session).agentHistory(),
    agentTrace: (p) => transcriptProject(p.session).agentTrace(p.id),
    skills: () => skills.list(),
    installSkill: async () => {
      const dir = await directory('选择可信 Skill 的目录')
      if (dir) skills.install(dir)
      return skills.list()
    },
    manageSkill: (p) => {
      skills.manage(p.id, p.action)
      return skills.list()
    },
    runSkill: (p) =>
      job(async (signal) => {
        const project = projectFor(p.session)
        const { assets, ...binding } = await skills.generate(project, p.id, p, signal)
        return { state: project.snapshot(), assetId: assets[0].id, ...binding }
      }),
    command: (p) =>
      job(async (signal) => {
        const result = await runWorkCommand(
          projectFor(p.session),
          settings,
          commands,
          {
            ...p.command,
            provider: p.provider,
            extension: p.extension,
            episodeId: p.episodeId,
            destination: p.destination,
            shotId: p.shotId,
            prompt: p.prompt,
            assetFree: p.assetFree
          },
          signal
        )
        return { code: result.code, state: result.state, asset: result.asset, binding: result.binding }
      }),
    captionResult: receiveCaptions,
    agent: (p) => {
      const project = projectFor(p.session)
      return agent.start(
        {
          settings,
          project,
          skills,
          episodeId: p.episodeId,
          command: (spec, signal, scope) => runWorkCommand(project, settings, commands, spec, signal, scope),
          exportEpisode: async (id, signal) => path.basename(await exportFilm(project, id, signal, () => {}))
        },
        p.question
      )
    },
    cancelAgent: (p) => agent.cancel(p.id),
    startVideoBatch: (p) => batch.start(projectFor(p.session), skills, p),
    cancelVideoBatch: (p) => batch.cancel(p.id),
    agentApproval: (p) => agent.answer(p.taskId, p.id, p.allowed),
    render: (p) =>
      job((signal) =>
        exportFilm(projectFor(p.session), p.episodeId, signal, (label) =>
          win?.webContents.send('studio:progress', label)
        )
      ),
    reveal: (p) => {
      const project = projectFor(p.session)
      const file = p.file
      if (file && path.dirname(file) === path.join(project.root, 'exports') && fs.existsSync(file))
        shell.showItemInFolder(file)
      else return shell.openPath(project.root)
    },
    cancel: () => task?.abort(),
    showHome: () => showHome(),
    showSettings: () => {
      if (!settingsWindow) createWindow('settings')
      else {
        if (settingsWindow.isMinimized()) settingsWindow.restore()
        if (!settingsWindow.webContents.isLoadingMainFrame()) settingsWindow.show()
        settingsWindow.focus()
      }
    },
    closeWindow: (_p, window) => window.close(),
    closeListenerReady: (_p, window) => window.registerStudioClose(),
    closeReady: (_p, window) => window.allowStudioClose()
  }
  const homeMethods = new Set([
    'initial',
    'showSettings',
    'create',
    'open',
    'recent',
    'restore',
    'settings',
    'agentPreferences',
    'appearance',
    'skills',
    'installSkill',
    'manageSkill',
    'closeListenerReady',
    'closeReady',
    'closeWindow'
  ])
  const settingsMethods = new Set([
    'initial',
    'settings',
    'agentPreferences',
    'appearance',
    'closeWindow',
    'closeListenerReady',
    'closeReady'
  ])
  const projectMethods = new Set(['create', 'open', 'recent', 'restore'])
  for (const [method, fn] of Object.entries(routes))
    ipcMain.handle('studio:' + method, async (e, p) => {
      const window = BrowserWindow.fromWebContents(e.sender)
      if (
        !window ||
        (window !== win && window !== homeWindow && window !== settingsWindow) ||
        e.senderFrame !== window.webContents.mainFrame ||
        (dev ? new URL(e.senderFrame.url).origin !== new URL(dev).origin : e.senderFrame.url !== entry) ||
        (window.studioRole === 'home' && !homeMethods.has(method)) ||
        (window.studioRole === 'settings' && !settingsMethods.has(method))
      )
        throw Error('未知窗口')
      if (window.studioRole === 'home' && projectMethods.has(method) && win) {
        win.webContents.send('studio:open-project', { method, payload: p })
        win.show()
        win.focus()
        homeWindow.hide()
        return null
      }
      const result = await fn(p, window)
      if (['settings', 'agentPreferences', 'appearance', 'installSkill', 'manageSkill'].includes(method)) {
        const configuration = { config: settings.view(), skills: skills.list() }
        for (const target of BrowserWindow.getAllWindows())
          target.webContents.send('studio:configuration', configuration)
      }
      if (window.studioRole === 'home' && projectMethods.has(method)) return null
      return result
    })
}
