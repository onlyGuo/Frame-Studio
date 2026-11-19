// 使用隔离的虚构工程拍摄实际 Electron 界面。素材与对话仅用于文档演示。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'
import { Project } from '../desktop/services/projects.mjs'
import { Settings } from '../desktop/services/settings.mjs'
import { ffmpegPath, probe } from '../desktop/services/media.mjs'
import { makeCard, makeClip, makeEpisode, makeShot } from '../shared/model.mjs'
import { mentionToken } from '../shared/mentions.mjs'

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-docs-'))
const storage = path.join(scratch, 'studio')
const target = path.resolve('docs/screenshots')
const sheet = path.resolve('docs/demo/last-ferry.jpg')
const svg = await fs.readFile('src/assets/studio-icon.svg', 'utf8')
const frame = (args) => execFileSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args])
const project = Project.create(scratch, '雾港末班船')
const settings = new Settings(storage, { seal: (value) => value, open: (value) => value })
settings.setAppearance('dark')
let app
try {
  const images = [
    ['雾港渡口', '0:0'],
    ['林岚 · 防雨风衣', '768:0'],
    ['旧黄铜钥匙', '0:512'],
    ['末班船灯亮起 · 分镜底图', '768:512']
  ].map(([name, position]) => {
    const filename = path.join(scratch, name + '.jpg')
    frame([
      '-i',
      sheet,
      '-vf',
      'crop=768:512:' + position,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-update',
      '1',
      filename
    ])
    return filename
  })
  const names = ['无人渡口', '黄铜钥匙', '雾中灯光']
  const seconds = [5, 4, 6]
  const videos = [images[0], images[2], images[3]].map((image, index) => {
    const output = path.join(scratch, names[index] + '.mp4')
    frame([
      '-i',
      image,
      '-vf',
      'scale=1440:960,zoompan=z=1.02+on*0.0005:x=iw/2-iw/zoom/2:y=ih/2-ih/zoom/2:d=' +
        25 * seconds[index] +
        ':s=960x540:fps=25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output
    ])
    return output
  })
  const [pier, raincoat, key, shotFrame, ...videoAssets] = await project.addMedia(
    [...images, ...videos],
    probe
  )
  const actor = {
    ...makeCard(),
    name: '林岚',
    notes: '渡口维修员。短黑发、眉眼沉静，习惯把袖口折一道。',
    defaultOutfitId: 'raincoat',
    outfits: [
      { id: 'raincoat', name: '防雨风衣', notes: '苔绿色防水布、旧铜扣、深色长裤。', assetId: raincoat.id },
      { id: 'work', name: '码头工装', notes: '深蓝棉质工作服。', assetId: '' }
    ]
  }
  const scene = {
    ...makeCard(),
    name: '雾港渡口',
    type: '场景',
    notes: '老铁棚、路灯与潮湿木栈道。',
    assetId: pier.id
  }
  const object = {
    ...makeCard(),
    name: '黄铜钥匙',
    type: '道具',
    notes: '椭圆手柄，铜面有氧化痕迹。',
    assetId: key.id
  }
  const script = [
    '第一场　雾港渡口 · 夜 · 外',
    '雨势没有减弱。昏黄灯光投在空荡的栈道上，末班船尚未靠岸。',
    '林岚从雨棚下走出。她把一枚旧钥匙握在手心，快步走到最靠海的那盏灯下。',
    '林岚：要是今晚不开船，我就在这里等。',
    '',
    '第二场　末班船 · 夜 · 外',
    '雾里亮起一点灯光。汽笛声压住雨声，林岚抬头，把钥匙收入风衣口袋。'
  ].join('\n\n')
  const prompts = [
    '远景，' + mentionToken(scene.id) + '笼在雨雾里。缓慢推近铁棚，灯光映在湿木栈道。',
    '特写，' +
      mentionToken(actor.id, 'raincoat') +
      '摊开掌心的' +
      mentionToken(object.id) +
      '，手指缓缓合拢。',
    '中景，' +
      mentionToken(actor.id, 'raincoat') +
      '站在' +
      mentionToken(scene.id) +
      '的灯下。她握着' +
      mentionToken(object.id) +
      '，抬头望向雾中的船灯。镜头缓慢侧移，雨声淹没远处汽笛。'
  ]
  const shots = names.map((name, i) => ({
    ...makeShot(),
    title: name,
    prompt: prompts[i],
    duration: seconds[i],
    dialogue: i === 2 ? '林岚：要是今晚不开船，我就在这里等。' : '',
    referenceId: [pier, key, shotFrame][i].id,
    assetId: videoAssets[i].id
  }))
  const next = { ...makeEpisode(), title: '第二集 · 回声', script: '天亮前，岛上第一次传来了回应。' }
  const user = {
    id: 'tutorial-user',
    role: 'user',
    text: '检查「雾中灯光」的出场资产和服饰，然后把本集已完成的镜头按顺序做粗剪。'
  }
  const answer = {
    id: 'tutorial-answer',
    role: 'assistant',
    text: '「雾中灯光」已绑定林岚的防雨风衣、雾港渡口和黄铜钥匙。\n\n本集 **3 个镜头** 已按分镜顺序放入剪辑台，总时长 **15 秒**。最后一镜的对白已带入字幕，可在剪辑台调整入点、音量和字幕。'
  }
  const episode = {
    ...project.data.episodes[0],
    title: '第一集 · 钥匙',
    script,
    shots,
    clips: videoAssets.map((video, i) => ({
      ...makeClip(video.id, seconds[i]),
      sourceShotId: shots[i].id,
      caption: shots[i].dialogue
    }))
  }
  project.save({
    ...project.data,
    quality: '1080p',
    synopsis: '末班船就要开了。一个渡口维修员握着父亲留下的钥匙，等雾里那盏迟到的灯。',
    cards: [actor, scene, object],
    episodes: [episode, next],
    messages: [user, answer]
  })
  const start = '2026-11-18T09:00:00.000Z'
  const end = '2026-11-18T09:00:19.000Z'
  project.runs.save({
    id: user.id,
    status: 'completed',
    startedAt: start,
    endedAt: end,
    events: [
      { type: 'thinking', round: 1, time: start },
      {
        type: 'message',
        phase: 'commentary',
        text: '我先核对第三镜用到的服饰和图片，再把已绑定的视频放入时间线。'
      },
      { type: 'tool', name: 'read_project', id: 'inspect', title: '核对出场资产' },
      { type: 'result', name: 'read_project', id: 'inspect', summary: '第三镜所需参考图均已登记' },
      { type: 'thinking', round: 2 },
      { type: 'tool', name: 'rough_cut', id: 'cut' },
      { type: 'result', name: 'rough_cut', id: 'cut', summary: '已将 3 个镜头加入时间线' },
      { type: 'message', phase: 'final', text: answer.text, time: end }
    ]
  })
  settings.remember(project.root, project.data)
  // 开发运行的测试路径隔离配置和历史，示意模型均使用保留域名。
  app = await electron.launch({ args: ['.'], env: { ...process.env, STUDIO_TEST_HOME: storage } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1500, height: 970 })
  page.setDefaultTimeout(10000)
  const png = await page.evaluate(async (markup) => {
    const image = new Image()
    image.src = 'data:image/svg+xml;base64,' + btoa(markup)
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 1024
    canvas.getContext('2d').drawImage(image, 0, 0)
    return canvas.toDataURL('image/png').split(',')[1]
  }, svg)
  await fs.writeFile('build/icon.png', Buffer.from(png, 'base64'))
  await fs.mkdir(target, { recursive: true })
  const click = (name) => page.getByRole('button', { name, exact: true }).first().click()
  const capture = async (name) => {
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.allSettled(
        [...document.images].filter((img) => img.getClientRects().length).map((img) => img.decode())
      )
    })
    const raw = path.join(scratch, name + '.png')
    await page.screenshot({ path: raw, animations: 'disabled', scale: 'css' })
    frame(['-i', raw, '-c:v', 'libwebp', '-quality', '90', path.join(target, name + '.webp')])
  }
  await page.getByRole('button', { name: /雾港末班船/ }).click()
  await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  await capture('01-workspace')
  await click('剧本写作')
  await capture('02-screenplay')
  await click('角色与设定')
  await page.getByRole('article', { name: '角色设定：林岚' }).waitFor()
  await capture('03-wardrobe')
  await click('分镜工作台')
  await click('选择镜头 3')
  await page.locator('.shot-asset-review').waitFor()
  await page.waitForFunction(() => (document.querySelector('.shot-detail video')?.readyState ?? 0) >= 2)
  await capture('04-storyboard')
  await click('素材库')
  await capture('05-media')
  await click('剪辑台')
  await page.locator('button[draggable="true"][title^="雾中灯光"]').click()
  const timecode = page.getByLabel('定位时间码')
  await timecode.fill('00:00:11:00')
  await timecode.press('Enter')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('video')].some((item) => item.readyState >= 2)
  )
  await capture('06-editor')
  await click('创作助手')
  await click('展开对话窗口')
  await page.getByText(/防雨风衣、雾港渡口和黄铜钥匙/).waitFor()
  await click('展开执行过程')
  await capture('07-agent')
  await click('关闭助手')
  await page.getByLabel('外观模式').selectOption('light')
  await click('模型配置')
  await click('视频生成')
  await page.getByLabel('服务协议').selectOption('minimax-video')
  await page.getByLabel('模型名称').fill('MiniMax-H3')
  await capture('08-models')
  await click('关闭')
  await click('Skill 管理')
  await capture('09-skills')
  assert.equal((await fs.readdir(target)).filter((file) => file.endsWith('.webp')).length, 9)
  console.log('图标与 9 张真实桌面截图已生成。')
} finally {
  if (app) {
    const child = app.process()
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) resolve()
      else child.once('exit', resolve)
    })
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await exited
  }
  await fs.rm(scratch, { recursive: true, force: true })
}
