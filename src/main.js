import { createVaporApp } from 'vue'
import App from './App.vue'
import './style.css'
// 首帧使用 Chromium 外观，启动后的用户选择及系统变更由主进程同步。
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light'
// 仅在桌面窗口提供系统材质时透出工作区外壳，编辑内容仍使用不透明底色。
document.documentElement.toggleAttribute('data-window-material', !!window.studio?.nativeWindowMaterial)
createVaporApp(App).mount('#app')
