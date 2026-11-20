import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson } from '../core/files.mjs'
import { agentPreferences } from '../../shared/agent-settings.mjs'

/** 配置目录仅记录应用设置与最近打开位置，创作内容保留在工作目录。 */
export const profiles = {
  chat: ['OpenAI Chat', 'llm', 'https://api.openai.com/v1', 'gpt-4.1'],
  responses: ['OpenAI Responses', 'llm', 'https://api.openai.com/v1', 'gpt-4.1'],
  anthropic: ['Anthropic', 'llm', 'https://api.anthropic.com/v1', 'claude-sonnet-4-6'],
  'openai-image': ['OpenAI 兼容生图', 'image', 'https://api.openai.com/v1', 'gpt-image-1'],
  'aliyun-image': [
    '阿里云 · 千问与万相',
    'image',
    'https://dashscope.aliyuncs.com/api/v1',
    'wan2.5-t2i-preview'
  ],
  'hunyuan-image': ['腾讯混元', 'image', 'https://hunyuan.tencentcloudapi.com', 'hunyuan-image'],
  'minimax-video': ['MiniMax H3 / 海螺', 'video', 'https://api.minimaxi.com/v1', 'MiniMax-Hailuo-2.3'],
  'vllm-h3': ['自定义 MiniMax H3（vLLM-Omni）', 'video', 'http://127.0.0.1:8091/v1', 'MiniMaxAI/MiniMax-H3'],
  'minimax-speech': ['MiniMax Speech', 'audio', 'https://api.minimax.cn/v1', 'speech-2.8-hd'],
  'aliyun-video': ['阿里云 · 万相视频', 'video', 'https://dashscope.aliyuncs.com/api/v1', 'wan2.6-t2v']
}
/** 维护设备级服务配置、凭据与最近项目。 */
export class Settings {
  constructor(root, vault) {
    this.root = root
    this.vault = vault
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    this.file = path.join(root, 'config.json')
    this.data = fs.existsSync(this.file)
      ? readJson(this.file)
      : { version: 1, llm: 'chat', profiles: {}, recent: [], disabled: [] }
    for (const [id, [, , url, model]] of Object.entries(profiles))
      this.data.profiles[id] ??= { url, model, key: '', secretId: '', region: 'ap-guangzhou' }
    this.data.profiles['vllm-h3'].steps ??= 10
    this.data.mediaDefaults ??= {}
    this.data.appearance ??= 'dark'
    this.data.agent = agentPreferences(this.data.agent)
    this.save()
  }
  save() {
    writeJson(this.file, this.data)
  }
  /** 设备级外观同时作用于所有工程和原生窗口。 */
  setAppearance(mode) {
    if (!['system', 'light', 'dark'].includes(mode)) throw Error('未知外观模式')
    this.data.appearance = mode
    this.save()
    return mode
  }
  /** 独立保存助手运行策略，正在执行的请求使用启动时的参数。 */
  setAgentPreferences(value) {
    this.data.agent = agentPreferences(value, { strict: true })
    this.save()
    return this.view()
  }
  /** 仅根据本机配置判断服务能否使用，发现能力无需解密凭据。 */
  ready(id) {
    const cfg = this.data.profiles[id]
    return Boolean(
      cfg?.url &&
        cfg.model &&
        (id === 'vllm-h3' ? cfg.saved : cfg.key) &&
        (id !== 'hunyuan-image' || cfg.secretId?.trim())
    )
  }
  /** 旧版单服务配置自动生效。存在多个候选时尊重用户显式选择。 */
  defaultMedia(kind) {
    const selected = this.data.mediaDefaults[kind]
    if (profiles[selected]?.[1] === kind && this.ready(selected)) return selected
    const available = Object.keys(profiles).filter((id) => profiles[id][1] === kind && this.ready(id))
    return available.length === 1 ? available[0] : null
  }
  /** 返回表单所需状态。已保存密钥仅显示是否存在。 */
  view() {
    return {
      llm: this.data.llm,
      appearance: this.data.appearance,
      agent: { ...this.data.agent },
      mediaDefaults: {
        image: this.defaultMedia('image'),
        video: this.defaultMedia('video'),
        audio: this.defaultMedia('audio')
      },
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([id, [label, group]]) => {
          const { key, ...fields } = this.data.profiles[id]
          return [id, { ...fields, label, group, configured: !!key, ready: this.ready(id) }]
        })
      )
    }
  }
  /** 更新单个协议；省略密钥时保留原有凭据。 */
  update({ id, url, model, key, secretId = '', region = 'ap-guangzhou', active, steps }) {
    if (!Object.hasOwn(profiles, id) || !model?.trim()) throw Error('请选择协议并填写模型')
    const endpoint = new URL(url)
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw Error('请填写 HTTP(S) API 基础地址')
    const old = this.data.profiles[id]
    const inferenceSteps = steps ?? old.steps ?? 10
    if (id === 'vllm-h3' && (!Number.isSafeInteger(inferenceSteps) || inferenceSteps < 1))
      throw Error('推理步数须为正整数')
    const kind = profiles[id][1]
    const previous = kind === 'llm' ? null : this.defaultMedia(kind)
    this.data.profiles[id] = {
      url: url.trim().replace(/\/+$/, ''),
      model: model.trim(),
      region,
      secretId,
      ...(id === 'vllm-h3' ? { steps: inferenceSteps, saved: true } : {}),
      key: key === undefined ? old.key : key ? this.vault.seal(key) : ''
    }
    if (active && profiles[id][1] === 'llm') this.data.llm = id
    if (kind !== 'llm') {
      if (active && this.ready(id)) this.data.mediaDefaults[kind] = id
      else if (previous && this.ready(previous) && (id !== previous || active !== false))
        this.data.mediaDefaults[kind] = previous
      else this.data.mediaDefaults[kind] = null
    }
    this.save()
    return this.view()
  }
  /** 仅主进程与该次运行的子进程使用解密凭据。 */
  credentials(id) {
    const cfg = this.data.profiles[id]
    if (!this.ready(id)) throw Error('请先在模型设置中补全' + (profiles[id]?.[0] || '服务') + '的凭据')
    return { ...cfg, key: cfg.key ? this.vault.open(cfg.key) : '' }
  }
  /** 工具结果或用户资料中意外出现的已配置凭据也在出站时遮蔽。 */
  redactor() {
    const sensitive = new Set()
    for (const [id, cfg] of Object.entries(this.data.profiles)) {
      if (profiles[id][1] !== 'llm') {
        sensitive.add(cfg.url)
        sensitive.add(cfg.secretId)
      }
      if (cfg.key) sensitive.add(this.vault.open(cfg.key))
    }
    const values = [...sensitive].filter(Boolean).sort((a, b) => b.length - a.length)
    return (text) => values.reduce((result, value) => result.replaceAll(value, '[已隐藏]'), text)
  }
  /** 按最近打开顺序保存有限的工程索引。 */
  remember(root, project) {
    this.data.recent = [
      { root, title: project.title, ratio: project.ratio, date: new Date().toISOString() },
      ...this.data.recent.filter((r) => r.root !== root)
    ].slice(0, 16)
    this.save()
  }
  /** 移除本机列表索引，持久化失败时恢复原列表。 */
  forget(root) {
    const previous = this.data.recent
    this.data.recent = previous.filter((item) => item.root !== root)
    try {
      this.save()
    } catch (error) {
      this.data.recent = previous
      throw error
    }
    return this.data.recent
  }
}
