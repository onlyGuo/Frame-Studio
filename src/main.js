import { createVaporApp } from 'vue'
import App from './App.vue'
import './style.css'
// 首帧使用 Chromium 外观，启动后的用户选择及系统变更由主进程同步。
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light'
createVaporApp(App).mount('#app')
