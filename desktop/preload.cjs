const { contextBridge, ipcRenderer } = require('electron')
// 渲染进程仅能调用明确列出的桌面能力。
const methods = [
  'initial',
  'create',
  'open',
  'recent',
  'closeProject',
  'save',
  'archive',
  'restore',
  'addMedia',
  'recoverImage',
  'settings',
  'agentPreferences',
  'appearance',
  'agentHistory',
  'agentTrace',
  'skills',
  'installSkill',
  'manageSkill',
  'runSkill',
  'startVideoBatch',
  'cancelVideoBatch',
  'agent',
  'cancelAgent',
  'agentApproval',
  'command',
  'captionResult',
  'render',
  'reveal',
  'cancel',
  'showHome',
  'showSettings',
  'closeWindow',
  'closeListenerReady',
  'closeReady'
]
const api = Object.fromEntries(
  methods.map((method) => [method, (payload) => ipcRenderer.invoke('studio:' + method, payload)])
)
api.nativeWindowMaterial = process.platform === 'darwin'
for (const [method, channel] of [
  ['onProgress', 'studio:progress'],
  ['onVideoBatch', 'studio:batch'],
  ['onAppearance', 'studio:appearance'],
  ['onClose', 'studio:close'],
  ['onConfiguration', 'studio:configuration'],
  ['onRecent', 'studio:recent'],
  ['onOpenProject', 'studio:open-project'],
  ['onAgentEvent', 'studio:agent-event'],
  ['onCaptions', 'studio:captions']
]) {
  api[method] = (callback) => {
    const handler = (_, value) => callback(value)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}
contextBridge.exposeInMainWorld('studio', api)
