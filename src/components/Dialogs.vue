<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ui, doc, api, media, perform, edit, openProject, runGeneration, notify, accept } from '../store.js'
import { resolveMentions } from '../../shared/mentions.mjs'
import { roleOutfit } from '../../shared/outfits.mjs'
import { formats, mediaKinds } from '../../shared/model.mjs'
import { videoDurations } from '../../resources/skills/_lib/video-inputs.mjs'
import Glyph from './Glyph.vue'
import VideoAssetInput from './studio/VideoAssetInput.vue'
import AgentPreferences from './AgentPreferences.vue'
const box = ref(null),
  title = ref(''),
  ratio = ref('16:9'),
  synopsis = ref(''),
  quality = ref('720p'),
  fps = ref(25),
  group = ref('llm'),
  profile = ref('chat'),
  form = ref({}),
  key = ref(''),
  use = ref(true),
  showGuide = ref('')
const skill = ref(''),
  prompt = ref(''),
  duration = ref(5),
  executable = ref('node'),
  args = ref('["--version"]'),
  provider = ref(''),
  ext = ref(''),
  commandReceipt = ref(null),
  target = ref('newShot'),
  commandTarget = ref('library'),
  commandPrompt = ref(''),
  videoReady = ref(false),
  assetFree = ref(false)
const choices = computed(() =>
  ui.skills.filter(
    (s) =>
      s.enabled &&
      s.command &&
      (!s.provider || ui.config.profiles[s.provider]?.ready) &&
      (!ui.generation?.kind || s.kind === ui.generation.kind) &&
      (!ui.generation?.cardId || s.kind === 'image') &&
      (!ui.generation?.shotId || s.kind !== 'audio')
  )
)
const currentEpisode = computed(() =>
  doc.value?.episodes.find((e) => e.id === (ui.generation?.episodeId || ui.episodeId))
)
const skillKind = computed(() => choices.value.find((s) => s.id === skill.value)?.kind)
const videoService = computed(() => choices.value.find((s) => s.id === skill.value))
const videoModel = computed(() => ui.config.profiles[videoService.value?.provider]?.model)
const allowedDurations = computed(() => videoDurations(videoService.value?.provider, videoModel.value))
const formatterUnavailable = computed(() =>
  Boolean(videoService.value?.videoPrompt && !ui.config.profiles[ui.config.llm]?.ready)
)
const commandEpisode = computed(() => doc.value?.episodes.find((e) => e.id === ui.episodeId))
const commandShot = computed(() => commandEpisode.value?.shots.find((s) => s.id === commandTarget.value))
const selectedCard = computed(() => doc.value?.cards.find((c) => c.id === ui.generation?.cardId))
const selectedOutfit = computed(() => roleOutfit(selectedCard.value, ui.generation?.outfitId))
const videoCommand = computed(() => mediaKinds[ext.value] === 'video')
const commandVideoService = computed(() =>
  ui.config.profiles[provider.value]?.group === 'video'
    ? { builtin: true, provider: provider.value }
    : undefined
)
const needsVideoFile = computed(
  () => ui.config.profiles[provider.value]?.group === 'video' && !videoCommand.value
)
/** 同步画面和模型约束；提交按钮和表单键盘提交使用同一份结果。 */
function reviewVideo(ready, free) {
  videoReady.value = ready
  assetFree.value = free
}
const selectedShot = computed(() =>
  currentEpisode.value?.shots.find(
    (s) => s.id === (ui.generation?.shotId || (skillKind.value === 'video' ? target.value : ''))
  )
)
const shotText = computed(() => {
  if (!selectedShot.value?.prompt) return ''
  try {
    return resolveMentions(selectedShot.value.prompt, doc.value.cards, {
      includeNotes: false,
      labelOutfits: true
    }).text
  } catch (err) {
    return err.message
  }
})
/** 从弹窗的互斥选项生成单一目标，现有分镜沿用其自身脚本。 */
function mediaDestination(value) {
  return ['newShot', 'library'].includes(value) ? { destination: value } : { shotId: value }
}
const names = {
  create: '新建项目',
  project: '工程设置',
  settings: '模型配置',
  skills: 'Skill 管理',
  generate: '生成素材',
  command: '命令工作台',
  exported: '成片已导出'
}
const sections = {
  create: 'NEW PROJECT',
  project: 'PROJECT SETTINGS',
  settings: 'MODEL CONNECTIONS',
  skills: 'SKILL LIBRARY',
  generate: 'GENERATE MEDIA',
  command: 'COMMAND RUNNER',
  exported: 'EXPORT COMPLETE'
}
function pick(id) {
  profile.value = id
  form.value = { ...ui.config.profiles[id] }
  key.value = ''
  const selected = group.value === 'llm' ? ui.config.llm : ui.config.mediaDefaults[group.value]
  use.value = selected === id || (group.value !== 'llm' && !selected)
}
function selectGroup(g) {
  group.value = g
  if (g === 'agent') return
  const selected = g === 'llm' ? ui.config.llm : ui.config.mediaDefaults[g]
  pick(selected || Object.keys(ui.config.profiles).find((id) => ui.config.profiles[id].group === g))
}
function load() {
  if (ui.modal === 'settings') selectGroup('llm')
  if (['create', 'project'].includes(ui.modal)) {
    title.value = ui.modal === 'create' ? '' : doc.value.title
    ratio.value = ui.modal === 'create' ? '16:9' : doc.value.ratio
    synopsis.value = doc.value?.synopsis || ''
    quality.value = doc.value?.quality || '720p'
    fps.value = doc.value?.fps || 25
  }
  if (ui.modal === 'generate') {
    const preferred =
      choices.value.find((s) => s.id === ui.config.mediaDefaults.image) ||
      choices.value.find((s) => s.id === ui.config.mediaDefaults.video)
    skill.value = preferred?.id || choices.value[0]?.id || ''
    target.value = 'newShot'
    prompt.value = ui.generation?.shotId ? '' : ui.generation?.prompt || ''
  }
  nextTick(() => box.value?.querySelector('input,textarea,select,button')?.focus())
}
watch(() => ui.modal, load, { immediate: true })
watch([skill, videoModel, () => selectedShot.value?.id], () => {
  const seconds = selectedShot.value?.duration || 5
  duration.value =
    allowedDurations.value.find((value) => value >= Math.round(seconds)) ?? allowedDurations.value.at(-1)
})
function saveSettings(clear = false) {
  return perform('正在保存配置', async () => {
    ui.config = await api.settings({
      id: profile.value,
      url: form.value.url,
      model: form.value.model,
      key: clear ? '' : key.value || undefined,
      secretId: form.value.secretId,
      region: form.value.region,
      active: use.value
    })
    pick(profile.value)
    notify(clear ? '凭据已清除' : '模型配置已保存')
  })
}
async function saveProject() {
  if (!title.value.trim()) return
  if (ui.modal === 'create') await openProject('create', { title: title.value.trim(), ratio: ratio.value })
  else if (
    edit((d) => {
      d.title = title.value.trim()
      d.ratio = ratio.value
      d.synopsis = synopsis.value
      d.quality = quality.value
      d.fps = fps.value
    })
  )
    ui.modal = ''
}
function manage(id, action) {
  return perform('正在更新 Skill', async () => {
    ui.skills = await api.manageSkill({ id, action })
  })
}
function install() {
  return perform('正在导入 Skill', async () => {
    ui.skills = await api.installSkill()
  })
}
function run() {
  if (skillKind.value === 'video' && (!videoReady.value || formatterUnavailable.value)) return
  return perform(
    '正在生成素材 · ' + skill.value,
    async () => {
      const result = await runGeneration({
        ...ui.generation,
        ...(skillKind.value === 'video' && !ui.generation.shotId ? mediaDestination(target.value) : {}),
        skillId: skill.value,
        prompt: skillKind.value === 'video' && selectedShot.value ? '' : prompt.value,
        assetFree: skillKind.value === 'video' && !selectedShot.value && assetFree.value,
        duration: duration.value
      })
      ui.modal = ''
      notify(
        result.warning ||
          (result.shotId
            ? '成品已绑定至分镜'
            : result.cardId
              ? '参考图已绑定至设定卡'
              : '生成结果已保存至素材库')
      )
    },
    true
  )
}
function command() {
  if (needsVideoFile.value || (videoCommand.value && !videoReady.value)) return
  commandReceipt.value = null
  return perform(
    '正在执行 · ' + executable.value,
    async () => {
      const list = JSON.parse(args.value)
      const r = await api.command({
        session: ui.session,
        command: { executable: executable.value, args: list },
        provider: provider.value,
        extension: ext.value,
        prompt: videoCommand.value && !commandShot.value ? commandPrompt.value : undefined,
        assetFree: videoCommand.value && !commandShot.value && assetFree.value,
        episodeId: ui.episodeId,
        ...mediaDestination(mediaKinds[ext.value] === 'video' ? commandTarget.value : 'library')
      })
      if (r.state) accept(r.state, true)
      commandReceipt.value = { code: r.code, asset: r.asset, warning: r.binding?.warning }
    },
    true
  )
}
let previousFocus
function trap(e) {
  if (e.key === 'Escape' && !ui.busy) {
    ui.modal = ''
    return
  }
  if (e.key !== 'Tab' || ui.busy || !box.value) return
  const nodes = [
    ...box.value.querySelectorAll(
      'button:not(:disabled),input:not(:disabled),textarea,select,summary,[contenteditable="true"],[tabindex="0"]'
    )
  ].filter((n) => n.offsetParent)
  const first = nodes[0],
    last = nodes.at(-1)
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last?.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first?.focus()
  }
}
onMounted(() => {
  previousFocus = document.activeElement
  window.addEventListener('keydown', trap)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', trap)
  previousFocus?.focus?.()
})
</script>
<template>
  <div class="overlay" @mousedown.self="ui.modal = ''">
    <section ref="box" class="modal" role="dialog" aria-modal="true" :aria-label="names[ui.modal]">
      <header class="bar">
        <div>
          <div class="eyebrow">
            <i />
            {{ sections[ui.modal] }}
          </div>
          <h2>{{ names[ui.modal] }}</h2>
        </div>
        <button class="icon" title="关闭" @click="ui.modal = ''"><Glyph name="x" /></button>
      </header>
      <div class="modal-body">
        <form
          v-if="ui.modal === 'create' || ui.modal === 'project'"
          class="form-stack"
          @submit.prevent="saveProject"
        >
          <label>
            项目名称
            <input maxlength="200" required v-model="title" placeholder="输入短剧名称" />
          </label>
          <label>
            成片画幅
            <select v-model="ratio">
              <option v-for="(_, r) in formats" :key="r">{{ r }}</option>
            </select>
          </label>
          <div class="fields" v-if="ui.modal === 'project'">
            <label>
              成片清晰度
              <select v-model="quality">
                <option>720p</option>
                <option>1080p</option>
              </select>
            </label>
            <label>
              帧率
              <select v-model.number="fps">
                <option v-for="n in [24, 25, 30]" :key="n" :value="n">{{ n }} fps</option>
              </select>
            </label>
          </div>
          <label v-if="ui.modal === 'project'">
            故事梗概
            <textarea v-model="synopsis" rows="4" />
          </label>
          <p class="hint">
            {{ ui.modal === 'create' ? '选择工作目录后，将在其中创建独立的工程文件夹。' : ui.root }}
          </p>
          <div class="modal-actions">
            <button type="button" class="outline" @click="ui.modal = ''">取消</button>
            <button class="primary" :disabled="!title.trim()">
              {{ ui.modal === 'create' ? '选择工作目录' : '保存设置' }}
              <Glyph name="arrow" />
            </button>
          </div>
        </form>
        <template v-if="ui.modal === 'settings'">
          <div class="tabs wide">
            <button
              v-for="g in [
                ['llm', '语言模型'],
                ['image', '图像生成'],
                ['video', '视频生成'],
                ['agent', '助手运行']
              ]"
              :key="g[0]"
              :class="{ active: group === g[0] }"
              @click="selectGroup(g[0])"
            >
              {{ g[1] }}
            </button>
          </div>
          <AgentPreferences v-if="group === 'agent'" />
          <form v-else class="form-stack" @submit.prevent="saveSettings(false)">
            <label>
              服务协议
              <select :value="profile" @change="pick($event.target.value)">
                <option
                  v-for="[id, p] in Object.entries(ui.config.profiles).filter(([, p]) => p.group === group)"
                  :key="id"
                  :value="id"
                >
                  {{ p.label }}{{ p.group !== 'llm' && p.ready ? ' · 已配置' : ''
                  }}{{ ui.config.mediaDefaults[p.group] === id ? ' · 默认' : '' }}
                </option>
              </select>
            </label>
            <label>
              API 基础地址
              <input v-model="form.url" type="url" required spellcheck="false" />
            </label>
            <label v-if="profile !== 'hunyuan-image'">
              模型名称
              <input v-model="form.model" required />
            </label>
            <label v-if="profile === 'hunyuan-image'">
              SecretId
              <input v-model="form.secretId" required />
            </label>
            <label>
              {{ profile === 'hunyuan-image' ? 'SecretKey' : 'API Key' }}
              <input
                type="password"
                autocomplete="new-password"
                v-model="key"
                :placeholder="form.configured ? '已保存，留空保留原凭据' : '输入密钥'"
              />
            </label>
            <label class="inline">
              <input type="checkbox" v-model="use" />
              {{
                group === 'llm'
                  ? '设为创作助手使用的协议'
                  : '设为默认' + (group === 'image' ? '图像' : '视频') + '生成服务'
              }}
            </label>
            <p v-if="group !== 'llm'" class="hint">
              创作助手按媒体类型使用默认模型。凭据仅在生成命令执行期间注入。
            </p>
            <div class="modal-actions">
              <button type="button" v-if="form.configured" class="outline" @click="saveSettings(true)">
                清除凭据
              </button>
              <button class="primary">保存配置</button>
            </div>
          </form>
        </template>
        <template v-if="ui.modal === 'skills'">
          <div class="bar">
            <p class="muted">内置能力与自定义本地命令包</p>
            <button class="outline" @click="install">
              <Glyph name="plus" />
              导入可信 Skill
            </button>
          </div>
          <div class="skill-row" v-for="s in ui.skills" :key="s.id">
            <span class="icon-box" :class="s.kind === 'video' ? 'lavender' : 'green'">
              <Glyph :name="s.kind === 'video' ? 'film' : 'media'" />
            </span>
            <div class="grow">
              <strong>{{ s.name }}</strong>
              <small>
                {{ s.builtin ? '内置 · 只读' : '自定义' }} · {{ s.command?.executable || '指令工作流' }}
              </small>
              <span>{{ s.description }}</span>
              <button class="text-btn" @click="showGuide = showGuide === s.id ? '' : s.id">使用说明</button>
              <pre v-if="showGuide === s.id">{{ s.guide }}</pre>
            </div>
            <button
              class="switch"
              role="switch"
              :aria-checked="s.enabled"
              :aria-label="'启用 ' + s.name"
              :class="{ on: s.enabled }"
              @click="manage(s.id, s.enabled ? 'disable' : 'enable')"
            >
              <i />
            </button>
            <button v-if="!s.builtin" class="icon" title="卸载 Skill" @click="manage(s.id, 'remove')">
              <Glyph name="trash" />
            </button>
          </div>
        </template>
        <form v-if="ui.modal === 'generate'" class="form-stack" @submit.prevent="run">
          <label>
            生成能力
            <select v-model="skill">
              <option v-if="!choices.length" value="">请先配置媒体模型并启用对应 Skill</option>
              <option v-for="s in choices" :key="s.id" :value="s.id">
                {{ s.name }}{{ s.provider ? ' · ' + ui.config.profiles[s.provider].model : '' }}
              </option>
            </select>
          </label>
          <label v-if="skillKind === 'video' && !ui.generation?.shotId">
            视频归属
            <select v-model="target">
              <option value="newShot">新建分镜 · {{ currentEpisode?.title }}</option>
              <option v-for="s in currentEpisode?.shots" :key="s.id" :value="s.id">
                绑定分镜 · {{ s.title }}
              </option>
              <option value="library">独立素材 · 仅存入素材库</option>
            </select>
          </label>
          <div v-if="selectedShot" class="generation-shot">
            <strong>{{ currentEpisode?.title }} / {{ selectedShot.title }}</strong>
            <p v-if="shotText">{{ shotText }}</p>
            <p v-if="skillKind === 'video'">
              {{ selectedShot.dialogue ? '本镜对白：' + selectedShot.dialogue : '本镜无对白' }}
            </p>
          </div>
          <div v-if="selectedCard" class="generation-shot">
            <strong>{{ selectedCard.name }}{{ selectedOutfit ? ' · ' + selectedOutfit.name : '' }}</strong>
            <p>{{ selectedOutfit ? '生成五视图角色参考图' : '按设定描述生成参考图' }}</p>
          </div>
          <VideoAssetInput
            v-if="skillKind === 'video'"
            v-model="prompt"
            :shot="selectedShot"
            :episode-id="currentEpisode?.id"
            :service="videoService"
            :destination="target"
            @review="reviewVideo"
          />
          <label v-else>
            {{ shotText || selectedCard ? '本次补充要求' : '提示词' }}
            <textarea
              :required="!shotText && !selectedCard"
              rows="4"
              v-model="prompt"
              placeholder="描述主体、画面、光线和运镜…"
            />
          </label>
          <label v-if="skillKind === 'video'">
            生成时长（秒）
            <select v-model.number="duration">
              <option v-for="seconds in allowedDurations" :key="seconds" :value="seconds">
                {{ seconds }} 秒
              </option>
            </select>
          </label>
          <p v-if="formatterUnavailable" class="hint">
            请先配置语言模型，用于按所选视频 Skill 整理本镜提示词。
          </p>
          <div class="modal-actions">
            <button type="button" class="outline" @click="ui.modal = 'settings'">模型配置</button>
            <button
              class="primary"
              :disabled="
                !skill ||
                (!prompt.trim() && !shotText && !selectedCard) ||
                (skillKind === 'video' && (!videoReady || formatterUnavailable))
              "
            >
              <Glyph name="spark" />
              开始生成
            </button>
          </div>
        </form>
        <form v-if="ui.modal === 'command'" class="form-stack" @submit.prevent="command">
          <p class="hint">
            工作目录为工程内的 work 文件夹。可直接调用 node、python、ffmpeg 或 PATH 中的程序。
          </p>
          <label>
            可执行文件
            <input v-model="executable" required />
          </label>
          <label>
            参数（JSON 字符串数组）
            <textarea v-model="args" rows="3" spellcheck="false" />
          </label>
          <div class="fields">
            <label>
              临时服务环境
              <select v-model="provider">
                <option value="">无凭据</option>
                <option
                  v-for="[id, p] in Object.entries(ui.config.profiles).filter(([, p]) => p.group !== 'llm')"
                  :key="id"
                  :value="id"
                >
                  {{ p.label }}
                </option>
              </select>
            </label>
            <label>
              接收 STUDIO_OUTPUT
              <select v-model="ext">
                <option value="">无媒体产物</option>
                <option v-for="e in Object.keys(mediaKinds)" :key="e">{{ e }}</option>
              </select>
            </label>
          </div>
          <label v-if="mediaKinds[ext] === 'video'">
            视频归属
            <select v-model="commandTarget">
              <option value="library">独立素材 · 仅存入素材库</option>
              <option value="newShot">新建分镜</option>
              <option
                v-for="s in doc?.episodes.find((e) => e.id === ui.episodeId)?.shots"
                :key="s.id"
                :value="s.id"
              >
                绑定分镜 · {{ s.title }}
              </option>
            </select>
          </label>
          <p v-if="needsVideoFile" class="hint">
            请在「接收 STUDIO_OUTPUT」中选择视频格式，以核对本次命令的出场资产。
          </p>
          <VideoAssetInput
            v-if="videoCommand"
            v-model="commandPrompt"
            :shot="commandShot"
            :episode-id="commandEpisode?.id"
            :destination="commandTarget"
            :service="commandVideoService"
            @review="reviewVideo"
          />
          <p v-if="videoCommand" class="hint">命令可从 STUDIO_REFERENCES 读取本次视频的参考图清单。</p>
          <div v-if="commandReceipt" class="command-receipt" role="status">
            <p>
              {{
                commandReceipt.warning ||
                (commandReceipt.code === 0 ? '命令已完成' : '命令失败，退出码 ' + commandReceipt.code)
              }}
            </p>
            <img
              v-if="commandReceipt.asset?.kind === 'image'"
              :src="media(commandReceipt.asset.id)"
              :alt="commandReceipt.asset.name"
            />
            <video
              v-else-if="commandReceipt.asset?.kind === 'video'"
              controls
              :src="media(commandReceipt.asset.id)"
            />
            <audio
              v-else-if="commandReceipt.asset?.kind === 'audio'"
              controls
              :src="media(commandReceipt.asset.id)"
            />
          </div>
          <div class="modal-actions">
            <button class="primary" :disabled="needsVideoFile || (videoCommand && !videoReady)">
              <Glyph name="play" />
              运行命令
            </button>
          </div>
        </form>
        <div v-if="ui.modal === 'exported'" class="form-stack">
          <p>MP4 已保存到工程的 exports 目录。</p>
          <code>{{ ui.exported }}</code>
          <div class="modal-actions">
            <button class="primary" @click="api.reveal({ session: ui.session, file: ui.exported })">
              在文件管理器中显示
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
