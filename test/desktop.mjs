// 驱动真实 Electron 窗口；仅用临时目录替代系统文件选择器。
import { chooseOption } from './studio-select.mjs'
import { _electron as electron } from 'playwright-core'
import http from 'node:http'
import { modelFixture, slowParts, slowQuestion, streamSlowReply } from './model-fixture.mjs'
import { verifyShotMentions } from './mentions-window.mjs'
import { verifyVideoAssetReview } from './shot-assets-window.mjs'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { ffmpegPath } from '../desktop/services/media.mjs'

/** 退出工程后检查主页和提示栏，捕获被界面错误提示接住的异常。 */
async function returnToProjectDesk(page) {
  await page.getByRole('button', { name: '项目工作台', exact: true }).click()
  await page.getByRole('heading', { name: '项目工作台', exact: true }).waitFor()
  await page.locator('.job').waitFor({ state: 'hidden' })
  assert.deepEqual(await page.locator('.toast.error').allTextContents(), [])
  await page.keyboard.press('ControlOrMeta+z')
  assert.equal(await page.getByRole('button', { name: '项目总览', exact: true }).count(), 0)
}

/** 覆盖截图中的超宽窗口、最小窗口和助手占用横向空间时的工作区。 */
async function verifyResponsiveWorkspace(page) {
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const views = [
    ['项目总览', '.overview-panels'],
    ['剧本写作', '.screenplay-desk'],
    ['角色与设定', '.setting-desk'],
    ['分镜工作台', '.shot-console'],
    ['素材库', '.media-pool'],
    ['剪辑台', '.cut-room']
  ]
  const frames = []
  for (const size of [
    { width: 3440, height: 1440 },
    { width: 900, height: 600 }
  ]) {
    await page.setViewportSize(size)
    for (const [name, selector] of views) {
      await page.getByRole('button', { name, exact: true }).click()
      const layout = await page.locator(selector).evaluate((panel) => {
        const main = panel.closest('main')
        return {
          width: panel.getBoundingClientRect().width,
          viewport: main.clientWidth,
          scroll: main.scrollWidth
        }
      })
      assert.ok(layout.width >= layout.viewport - 80, name + ' 未铺满工作区 ' + JSON.stringify(layout))
      assert.ok(layout.scroll <= layout.viewport + 1, name + ' 发生横向溢出 ' + JSON.stringify(layout))
    }
    frames.push(await page.locator('.program-monitor .frame').boundingBox())
    if (size.width === 3440) {
      const bottom = await page.locator('.cut-timeline').evaluate((timeline) => ({
        timeline: timeline.getBoundingClientRect().bottom,
        viewport: timeline.closest('main').getBoundingClientRect().bottom
      }))
      assert.ok(bottom.timeline >= bottom.viewport - 50, JSON.stringify(bottom))
    }
    await returnToProjectDesk(page)
    const library = await page.locator('.home-library').boundingBox()
    const main = await page.locator('.body > main').boundingBox()
    assert.ok(library.width >= main.width - 80)
    await page.locator('.home-projects button').first().click()
    await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  }
  assert.ok(frames[0].width > frames[1].width * 1.5, JSON.stringify(frames))
  await page.getByRole('button', { name: '剪辑台', exact: true }).click()
  await page.getByRole('button', { name: '创作助手', exact: true }).click()
  const monitor = await page.locator('.program-monitor').boundingBox()
  const inspector = await page.locator('.cut-inspector').boundingBox()
  assert.ok(inspector.y >= monitor.y + monitor.height - 1)
  await page.getByRole('button', { name: '关闭助手' }).click()
  await page.setViewportSize(original)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-window-'))
const shot = path.join(root, '场景.png')
const encoded = spawnSync(ffmpegPath, [
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=640x360',
  '-frames:v',
  '1',
  shot
])
assert.equal(encoded.status, 0)
const videoFile = path.join(root, '模拟分镜.mp4')
const voiceFile = path.join(root, '模拟样音.wav')
const speechFile = path.join(root, '合成样音.mp3')
for (const file of [voiceFile, speechFile])
  assert.equal(
    spawnSync(ffmpegPath, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '4', file])
      .status,
    0
  )
const speechHex = (await fs.readFile(speechFile)).toString('hex')
assert.equal(
  spawnSync(ffmpegPath, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180',
    '-t',
    '0.4',
    '-pix_fmt',
    'yuv420p',
    videoFile
  ]).status,
  0
)
const releaseVideo = Promise.withResolvers(),
  videoCalls = []
const receivedImage = Promise.withResolvers(),
  finishImage = Promise.withResolvers()
const mediaCalls = []
const compactQuestion = '沿用先前记录，说明哪一镜可以继续剪辑。'
const compactAnswer = '可以继续剪辑已经完成的雨夜镜头。'
let summaryCalls = 0
const firstPartSeen = Promise.withResolvers()
let slowRequests = 0
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url === '/image.png') {
    res.setHeader('Content-Type', 'image/png')
    return res.end(await fs.readFile(shot))
  }
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/speech/v1/voice_design') {
    assert.equal(req.headers.authorization, 'Bearer voice-test-credential')
    assert.match(JSON.parse(raw).prompt, /普通话/)
    return res.end(JSON.stringify({ voice_id: 'test-audio', trial_audio: speechHex }))
  }
  if (req.url === '/clip.mp4') {
    res.setHeader('Content-Type', 'video/mp4')
    return res.end(await fs.readFile(videoFile))
  }
  if (req.url === '/video-api/tasks/window-video') {
    return res.end(
      JSON.stringify({
        output: {
          task_status: 'SUCCEEDED',
          video_url: 'http://127.0.0.1:' + server.address().port + '/clip.mp4'
        }
      })
    )
  }
  if (req.url.startsWith('/video-api/services/')) {
    videoCalls.push(JSON.parse(raw))
    await releaseVideo.promise
    return res.end(JSON.stringify({ output: { task_id: 'window-video' } }))
  }
  if (req.url.startsWith('/api/v1/')) {
    mediaCalls.push({ path: req.url, key: req.headers.authorization, body: JSON.parse(raw) })
    receivedImage.resolve()
    await finishImage.promise
    return res.end(
      JSON.stringify({
        output: {
          choices: [
            { message: { content: [{ image: 'http://127.0.0.1:' + server.address().port + '/image.png' }] } }
          ]
        }
      })
    )
  }
  assert.ok(!raw.includes('media-test-credential'))
  const request = JSON.parse(raw)
  if (request.tools?.[0]?.function?.name === 'return_video_prompt') {
    const source = JSON.parse(request.messages.at(-1).content)
    return res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'window-format',
                  type: 'function',
                  function: {
                    name: 'return_video_prompt',
                    arguments: JSON.stringify({
                      visual: '连续画面。' + source.visual + (source.hasDialogue ? '\n[[DIALOGUE]]' : '')
                    })
                  }
                }
              ]
            }
          }
        ]
      })
    )
  }
  if (request.messages?.at(-1)?.content === slowQuestion) {
    return streamSlowReply(res, ++slowRequests, firstPartSeen.promise)
  }
  const answer = (text) =>
    res.end(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] })
    )
  if (request.model === 'fixture-studio' && !request.tools?.length) {
    summaryCalls++
    return answer('用户制作雨夜分镜，参考图已登记，Node 和 Python 均已运行。')
  }
  if (request.messages?.at(-1)?.content === compactQuestion) {
    assert.ok(summaryCalls > 0 && request.messages.some((row) => row.content?.includes('参考图已登记')))
    return answer(compactAnswer)
  }
  res.end(JSON.stringify(modelFixture(req.url, request)))
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const packaged = process.env.STUDIO_PACKAGED_EXECUTABLE
const app = await electron.launch({
  executablePath: packaged || undefined,
  args: packaged ? [] : ['.'],
  env: { ...process.env, HOME: root, STUDIO_TEST_HOME: path.join(root, 'app') }
})
const errors = []
try {
  await app.evaluate(({ dialog, safeStorage }, base) => {
    // 测试凭据限定在临时配置目录，避免触发用户的系统钥匙串。
    safeStorage.isEncryptionAvailable = () => true
    safeStorage.encryptString = (text) => Buffer.from(text)
    safeStorage.decryptString = (bytes) => bytes.toString()
    dialog.showMessageBox = async () => ({ response: 0 })
    dialog.showOpenDialog = async (_win, options) => ({
      canceled: false,
      filePaths:
        options.title === '上传角色样音'
          ? [base + '/模拟样音.wav']
          : ['导入媒体', '选择设定参考图'].includes(options.title) || options.title?.startsWith('找回「')
            ? [base + '/场景.png']
            : options.filters
              ? [base + '/test.framepack']
              : [base]
    })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: base + '/test.framepack' })
  }, root)
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  page.on('pageerror', (err) => errors.push(err.message))
  await page.getByRole('heading', { name: '开始一部短剧' }).waitFor()
  const appearance = page.getByLabel('外观模式')
  assert.equal(await appearance.getAttribute('data-value'), 'dark')
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark')
  await appearance.press('ArrowDown')
  assert.equal(await appearance.getAttribute('aria-expanded'), 'true')
  await appearance.press('Escape')
  assert.equal(await appearance.getAttribute('aria-expanded'), 'false')
  assert.equal(await appearance.getAttribute('data-value'), 'dark')
  for (const mode of ['light', 'dark']) {
    await chooseOption(page, appearance, mode)
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, mode)
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), mode)
  }
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[aria-label="外观模式"]')?.dataset.value === 'dark')
  if (process.env.STUDIO_SCREENSHOT) await page.screenshot({ path: process.env.STUDIO_SCREENSHOT })
  await page.getByRole('button', { name: '新建项目', exact: true }).last().click()
  await page.getByLabel('项目名称').fill('窗口验收')
  await page.getByRole('button', { name: '选择工作目录' }).click()
  await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  await page.getByRole('button', { name: '剧本写作', exact: true }).click()
  await page.getByLabel('剧本正文').fill('雨后的夜晚。')
  await page.getByRole('button', { name: '分镜工作台', exact: true }).click()
  await page.getByRole('button', { name: '添加分镜' }).click()
  await verifyShotMentions(page)
  await page.getByLabel('画面与运镜').fill('镜头沿着街道向前移动。')
  await page.getByRole('button', { name: '素材库', exact: true }).click()
  await page.getByRole('button', { name: '导入素材', exact: true }).click()
  await page.getByRole('button', { name: '加入剪辑' }).click()
  await page.getByRole('button', { name: '剪辑台', exact: true }).click()
  const inspectorContrast = await page.locator('.cut-inspector > header').evaluate((header) => {
    const channels = (value) => value.match(/\d+/g).map((channel) => Number(channel) / 255)
    const luminance = (value) =>
      channels(value)
        .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const background = luminance(getComputedStyle(header).backgroundColor)
    return [...header.querySelectorAll('button')].map((button) => {
      const foreground = luminance(getComputedStyle(button).color)
      return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
    })
  })
  assert.ok(inspectorContrast.length > 0 && inspectorContrast.every((ratio) => ratio >= 4.5))
  await page.locator('.lane button').first().click()
  await page.getByLabel('时长（秒）', { exact: true }).fill('0.8')
  await page.getByLabel('片段字幕').fill('雨后')
  await page.getByRole('heading', { name: '剪辑台' }).click()
  await page.getByRole('button', { name: '导出 MP4' }).click()
  await page.getByRole('heading', { name: '成片已导出' }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '命令工作台' }).click()
  await page.getByLabel('可执行文件').fill('python')
  await page.getByRole('button', { name: '运行命令' }).click()
  await page.getByText('命令已完成', { exact: true }).first().waitFor()
  assert.doesNotMatch(await page.getByRole('dialog').innerText(), /Python 3\.12/)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '工程包', exact: true }).click()
  await returnToProjectDesk(page)
  await page.reload()
  await page.locator('.home-projects button').first().click()
  await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  await returnToProjectDesk(page)
  await page.locator('.home-projects button').first().click()
  await page.getByRole('button', { name: '剧本写作', exact: true }).click()
  await returnToProjectDesk(page)
  await page.getByRole('button', { name: '导入工程包' }).click()
  await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  await page.getByRole('button', { name: '剧本写作', exact: true }).click()
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '雨后的夜晚。')
  await page.getByRole('button', { name: '模型配置', exact: true }).click()
  await page.getByRole('button', { name: '助手运行' }).click()
  await page.getByLabel('自动压缩阈值（tokens）').fill('180000')
  await page.getByLabel('模型首次响应超时（秒）').fill('360')
  await page.getByText(/无响应超时后最多重试 5 次/).waitFor()
  await page.getByRole('button', { name: '保存助手设置' }).click()
  await page.getByText('助手运行设置已保存', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '模型配置', exact: true }).click()
  await page.getByRole('button', { name: '助手运行' }).click()
  assert.equal(await page.getByLabel('自动压缩阈值（tokens）').inputValue(), '180000')
  assert.equal(await page.getByLabel('模型首次响应超时（秒）').inputValue(), '360')
  await page.getByRole('button', { name: '语言模型', exact: true }).click()
  await page.getByLabel('API 基础地址').fill('http://127.0.0.1:' + server.address().port + '/v1')
  await page.getByLabel('API Key').fill('local-test-only')
  await page.getByLabel('模型名称').fill('video-prompt-fixture')
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.getByRole('button', { name: '视频生成', exact: true }).click()
  await chooseOption(page, page.getByLabel('服务协议'), 'minimax-video')
  assert.equal(await page.getByLabel('API 基础地址').inputValue(), 'https://api.minimaxi.com/v1')
  await chooseOption(page, page.getByLabel('服务协议'), 'aliyun-video')
  await page.getByLabel('API 基础地址').fill('http://127.0.0.1:' + server.address().port + '/video-api')
  await page.getByLabel('模型名称').fill('wan3.0-video-prime')
  await page.getByLabel('API Key').fill('video-test-credential')
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '分镜工作台', exact: true }).click()
  await chooseOption(page, page.getByLabel('分镜参考图', { exact: true }), 1)
  await verifyVideoAssetReview(page, root)
  await page.getByRole('button', { name: '生成缺失视频' }).click()
  await page.getByRole('button', { name: '生成 1 个镜头' }).click()
  await page.getByRole('button', { name: '停止分镜批量生成' }).waitFor()
  await page.getByRole('button', { name: '剪辑台', exact: true }).click()
  releaseVideo.resolve()
  await page.getByRole('status').filter({ hasText: '已生成 1 个镜头' }).waitFor({ timeout: 12000 })
  const generated = await page.evaluate(async () => (await window.studio.initial()).current.data)
  const firstShot = generated.episodes[0].shots[0]
  assert.equal(generated.assets.find((a) => a.id === firstShot.assetId)?.kind, 'video')
  assert.equal(generated.assets.find((a) => a.id === firstShot.referenceId)?.kind, 'image')
  assert.equal(videoCalls.length, 1)
  assert.equal(videoCalls[0].model, 'wan3.0-video-prime')
  assert.match(videoCalls[0].input.prompt, /连续画面。叶宁/)
  assert.equal(videoCalls[0].input.media[0].type, 'first_frame')
  assert.match(videoCalls[0].input.media[0].url, /^data:image\/png;base64,/)
  await page.getByRole('button', { name: '模型配置', exact: true }).click()
  await page.getByRole('button', { name: '视频生成', exact: true }).click()
  await chooseOption(page, page.getByLabel('服务协议'), 'vllm-h3')
  assert.equal(await page.getByLabel('推理步数').inputValue(), '10')
  await page.getByRole('button', { name: '声音生成', exact: true }).click()
  await page.getByLabel('API 基础地址').fill('http://127.0.0.1:' + server.address().port + '/speech/v1')
  await page.getByLabel('API Key').fill('voice-test-credential')
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '角色与设定', exact: true }).click()
  const actor = page.getByRole('article', { name: '角色设定：叶宁' })
  await actor.getByRole('button', { name: '上传样音' }).click()
  await actor.getByRole('button', { name: '播放', exact: true }).click()
  const voiceProgress = actor.getByRole('slider', { name: '播放进度' })
  await voiceProgress.and(page.locator(':enabled')).waitFor()
  assert.ok(Number(await voiceProgress.getAttribute('max')) > 1)
  await actor.getByRole('button', { name: '暂停', exact: true }).click()
  const uploadedVoice = await actor.getByLabel('角色声音样本').getAttribute('data-value')
  assert.ok(uploadedVoice)
  await actor.getByRole('button', { name: '生成样音' }).click()
  await page.getByLabel('音色描述').fill('普通话，沉稳自然')
  await page.getByRole('button', { name: '开始生成', exact: true }).click()
  await page.getByRole('dialog', { name: '生成素材' }).waitFor({ state: 'hidden' })
  await page.getByText('样音已绑定至角色卡', { exact: true }).waitFor()
  const newVoice = await actor.getByLabel('角色声音样本').getAttribute('data-value')
  assert.ok(newVoice && newVoice !== uploadedVoice)
  assert.match(await actor.locator('audio').getAttribute('src'), new RegExp(newVoice + '$'))
  await verifyResponsiveWorkspace(page)
  await page.getByRole('button', { name: 'Skill 管理', exact: true }).click()
  assert.equal(
    await page.getByRole('switch').count(),
    await page.evaluate(async () => (await window.studio.initial()).skills.length)
  )
  await page.getByRole('switch').first().click()
  assert.equal(await page.getByRole('switch').first().getAttribute('aria-checked'), 'false')
  await page.getByRole('switch').first().click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '模型配置', exact: true }).click()
  await page.getByLabel('API 基础地址').fill('http://127.0.0.1:' + server.address().port + '/v1')
  await page.getByLabel('API Key').fill('local-test-only')
  await page.getByLabel('模型名称').fill('fixture-studio')
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.getByRole('button', { name: '图像生成', exact: true }).click()
  await chooseOption(page, page.getByLabel('服务协议'), 'aliyun-image')
  await page.getByLabel('模型名称').fill('qwen-image-3.0')
  await page.getByLabel('API 基础地址').fill('http://127.0.0.1:' + server.address().port + '/api/v1')
  await page.getByLabel('API Key').fill('media-test-credential')
  await page.getByRole('button', { name: '保存配置' }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const origin = await page.evaluate(async () => (await window.studio.initial()).current)
  await page.getByRole('button', { name: '创作助手', exact: true }).click()
  await page.getByPlaceholder('描述想创作或修改的内容…').fill('创建雨夜分镜、生成图片并检查本机运行时')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await Promise.race([
    receivedImage.promise,
    new Promise((_, reject) => setTimeout(() => reject(Error('模型未调用已配置的生图服务')), 10000).unref())
  ])
  await page.getByRole('button', { name: '关闭助手' }).click()
  await page.getByRole('button', { name: '剧本写作', exact: true }).click()
  await page.getByLabel('剧本正文').fill('后台生图时手工保留的旁白。')
  await page.getByRole('button', { name: '剪辑台', exact: true }).click()
  await page.getByRole('button', { name: '项目工作台', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).last().click()
  await page.getByLabel('项目名称').fill('后台隔离')
  await page.getByRole('button', { name: '选择工作目录' }).click()
  await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: '创作工作区' }).waitFor()
  await page.getByRole('button', { name: /^创作助手/ }).click()
  await page.getByRole('button', { name: '后台任务' }).click()
  finishImage.resolve()
  const approval = page.getByRole('region', { name: '命令授权' })
  await approval.getByText('请求运行 2 个步骤').waitFor()
  assert.match(await approval.innerText(), /console\.log\(6 \* 7\)/)
  assert.match(await approval.innerText(), /python.*7 \* 6/)
  await page.getByRole('button', { name: '允许运行' }).click()
  await page.getByText('雨夜分镜和参考图已完成，两个本机运行时均已验证。', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '展开执行过程' }).last().waitFor()
  assert.equal(await page.locator('.ac-process:visible').count(), 0)
  await page.getByRole('button', { name: '展开执行过程' }).last().click()
  const commands = page.locator('.ac-process .ac-tool').filter({ hasText: 'node · check.mjs' })
  await commands.locator('summary').click()
  assert.equal(await commands.getByRole('listitem').count(), 2)
  assert.equal(
    await commands
      .locator('.ac-action-state')
      .allTextContents()
      .then((labels) => labels.join(',')),
    '已完成,已完成'
  )
  assert.doesNotMatch(
    await page.locator('.ac-process').innerText(),
    /console\.log|标准输出|执行结果|输入参数|"stdout"|print\(7/
  )
  await page.getByRole('button', { name: '收起执行过程' }).last().click()
  await chooseOption(page, appearance, 'system')
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system')
  await page.waitForFunction(() => document.querySelector('.ac-output img')?.naturalWidth === 640)
  const other = await page.evaluate(async () => (await window.studio.initial()).current)
  assert.equal(other.data.title, '后台隔离')
  assert.equal(other.data.messages.length, 0)
  assert.equal(other.data.assets.length, 0)
  assert.equal(other.data.episodes[0].shots.length, 0)
  const updated = JSON.parse(await fs.readFile(path.join(origin.root, 'studio.json'), 'utf8'))
  assert.equal(updated.episodes[0].script, '后台生图时手工保留的旁白。')
  assert.equal(updated.episodes[0].shots.at(-1).title, '雨夜')
  assert.equal(updated.assets.length, origin.data.assets.length + 1)
  assert.equal(updated.assets.at(-1).kind, 'image')
  assert.match(updated.messages.at(-1).text, /两个本机运行时均已验证/)
  assert.equal(mediaCalls.length, 1)
  assert.equal(mediaCalls[0].path, '/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(mediaCalls[0].key, 'Bearer media-test-credential')
  assert.equal(mediaCalls[0].body.model, 'qwen-image-3.0')
  await page.getByRole('button', { name: '返回工程' }).click()
  await page.getByRole('button', { name: '展开对话窗口' }).click()
  await page.getByRole('button', { name: '展开执行过程' }).last().click()
  await commands.locator('summary').click()
  assert.ok((await page.locator('.agent-console').boundingBox()).width > 800)
  await page.getByText('node · check.mjs', { exact: true }).waitFor()
  assert.doesNotMatch(
    await page.locator('.agent-console').innerText(),
    /(^|\s)42(\s|$)|"stdout"|console\.log\(/m
  )
  if (process.env.STUDIO_AGENT_SCREENSHOT) {
    await page.locator('.toast').waitFor({ state: 'hidden' })
    await page.locator('.ac-scroll').evaluate((el) => {
      el.scrollTop = 0
    })
    await page.screenshot({ path: process.env.STUDIO_AGENT_SCREENSHOT })
  }
  await page.getByRole('button', { name: '还原侧栏' }).click()
  assert.ok((await page.locator('.agent-console').boundingBox()).width < 800)
  await page.getByRole('button', { name: '模型配置', exact: true }).first().click()
  await page.getByRole('button', { name: '助手运行' }).click()
  const responseTimeout = page.getByLabel('模型首次响应超时（秒）')
  const savedTimeout = await responseTimeout.inputValue()
  await responseTimeout.fill('1')
  await page.getByRole('button', { name: '保存助手设置' }).click()
  await page.getByText('助手运行设置已保存', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('创作请求').fill(slowQuestion)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByText(slowParts[0], { exact: true }).waitFor({ timeout: 15000 })
  firstPartSeen.resolve()
  await page.getByText(slowParts.join(''), { exact: true }).first().waitFor()
  await page.waitForFunction(
    async (text) => (await window.studio.initial()).current.data.messages.at(-1)?.text === text,
    slowParts.join('')
  )
  assert.equal(slowRequests, 2)
  await page.getByRole('button', { name: '模型配置', exact: true }).first().click()
  await page.getByRole('button', { name: '助手运行' }).click()
  await responseTimeout.fill(savedTimeout)
  await page.getByLabel('自动压缩阈值（tokens）').fill('1024')
  await page.getByRole('button', { name: '保存助手设置' }).click()
  await page.getByText('助手运行设置已保存', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('创作请求').fill(compactQuestion)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByText(compactAnswer, { exact: true }).waitFor()
  const nextTurn = page.locator('.ac-turn').last()
  await nextTurn.getByRole('button', { name: '展开执行过程' }).click()
  await nextTurn.getByText('上下文已自动压缩').waitFor()
  assert.ok(summaryCalls > 0)
  assert.doesNotMatch(await nextTurn.innerText(), /用户制作雨夜分镜，参考图已登记/)
  assert.deepEqual(errors, [])
  console.log('Electron 窗口验收通过，覆盖首次响应重试、SSE 停顿、跨项目生图、重载、命令授权和产物归属。')
} catch (err) {
  const p = app.windows()[0]
  console.error(
    '窗口诊断',
    errors,
    await p
      ?.locator('body')
      .innerText()
      .catch(() => '')
  )
  throw err
} finally {
  firstPartSeen.resolve()
  releaseVideo.resolve()
  finishImage.resolve()
  const exited = new Promise((resolve) => {
    if (app.process().exitCode !== null) resolve()
    else app.process().once('exit', resolve)
  })
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await exited
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}
