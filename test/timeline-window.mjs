import assert from 'node:assert/strict'

/** 用实际指针验证拖影、落盘后的轨道位置及撤销。 */
export async function verifyTimelineDrag(page) {
  const separator = page.getByRole('separator', { name: '调整时间线高度' })
  for (let i = 0; i < 7; i++) await separator.press('ArrowUp')
  // 固定为每帧 3 像素，避免不同窗口宽度下的指针像素取整跨过相邻帧。
  await page.getByRole('slider', { name: '缩放' }).evaluate((input) => {
    input.value = '75'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const lane = (id) => page.locator('.lane[data-track-id="' + id + '"]')
  const pictureClips = page.locator('.lane[data-track-kind="visual"] .timeline-clip')
  const caption = page.locator('.lane[data-track-kind="caption"] .timeline-clip')
  const audio = page.locator('.lane[data-track-kind="audio"] .timeline-clip')
  const timecode = page.getByLabel('定位时间码')
  const insert = page.getByRole('button', { name: '插入片段', exact: true })
  const ghost = page.locator('.clip-ghost')
  const marker = page.locator('.track-insert-preview')
  const guide = page.locator('.snap-guide')
  const magnet = page.getByRole('button', { name: '吸附', exact: true })
  const clipKeys = (id) =>
    lane(id)
      .locator('.timeline-clip')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.clipKey))

  // 在测试工程已有的静帧后放入第二张图，验证连续画面的拖动顺序。
  await page.getByRole('tab', { name: '工程素材' }).click()
  await page.locator('.bin-item').first().click()
  await insert.click()
  const [first, second] = await clipKeys('visual')
  const picture = page.locator('[data-clip-key="' + first + '"]')
  const scale = (await pictureClips.last().boundingBox()).width / 5
  const rail = await page.locator('.cut-timeline .rail').boundingBox()

  async function drag(clip, destination, time, offsetY) {
    const from = await clip.boundingBox()
    const to = await destination.boundingBox()
    const offsetX = Math.min(10, from.width / 2)
    await page.mouse.move(from.x + offsetX, from.y + from.height / 2)
    await page.mouse.down()
    const currentRail = await page.locator('.cut-timeline .rail').boundingBox()
    const x = time === undefined ? from.x : currentRail.x + time * scale
    await page.mouse.move(x + offsetX, to.y + (offsetY ?? to.height / 2), { steps: 6 })
  }

  await drag(picture, lane('visual'), 5)
  await guide.getByText('片段边缘').waitFor()
  await ghost.waitFor()
  await page.mouse.up()
  assert.deepEqual(await clipKeys('visual'), [second, first])

  await drag(picture, lane('caption'), 5, 10)
  await marker.getByText('新建画面轨道').waitFor()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  assert.equal(await page.locator('.lane[data-track-kind="visual"]').count(), 1)
  await drag(picture, lane('caption'), 5, 10)
  await marker.getByText('新建画面轨道').waitFor()
  await page.mouse.up()
  const newPicture = page.locator('.lane[data-track-kind="visual"]').last()
  assert.deepEqual(
    await newPicture
      .locator('.timeline-clip')
      .evaluateAll((clips) => clips.map((clip) => clip.dataset.clipKey)),
    [first]
  )
  assert.deepEqual(await clipKeys('visual'), [second])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  assert.deepEqual(await clipKeys('visual'), [second, first])
  assert.equal(await page.locator('.lane[data-track-kind="visual"]').count(), 1)

  await magnet.click()
  await drag(caption, lane('audio'), 2, 10)
  await marker.getByText('新建字幕轨道').waitFor()
  await page.mouse.up()
  const newCaption = page.locator('.lane[data-track-kind="caption"]').last()
  assert.equal(await newCaption.locator('.timeline-clip').count(), 1)
  assert.equal(Math.round((await caption.boundingBox()).x - rail.x), Math.round(2 * scale))
  await drag(caption, lane('caption'))
  await lane('caption').and(page.locator('.drop-active')).waitFor()
  await page.mouse.up()
  assert.equal(await lane('caption').locator('.timeline-clip').count(), 1)
  assert.equal(await newCaption.locator('.timeline-clip').count(), 0)

  const captionBefore = await caption.boundingBox()
  await picture.click()
  await timecode.fill('5.4')
  await timecode.press('Enter')
  await page.getByRole('button', { name: '分割', exact: true }).click()
  await page.getByRole('menuitem', { name: '分割选中项', exact: true }).click()
  assert.equal(await pictureClips.count(), 3)
  assert.equal(await caption.count(), 1)
  assert.equal((await caption.boundingBox()).width, captionBefore.width)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await caption.click()
  await timecode.fill('3')
  await timecode.press('Enter')
  await page.getByRole('button', { name: '分割', exact: true }).click()
  await page.getByRole('menuitem', { name: '分割选中项', exact: true }).click()
  assert.equal(await caption.count(), 2)
  assert.equal(await pictureClips.count(), 2)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await picture.click()
  const handle = await picture.locator('[data-trim="end"]').boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 - 0.2 * scale, handle.y + handle.height / 2, { steps: 5 })
  await page.mouse.up()
  assert.ok(Math.abs(Number(await page.getByLabel('时长（秒）', { exact: true }).inputValue()) - 0.6) < 0.001)
  assert.equal((await caption.boundingBox()).width, captionBefore.width)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await magnet.click()
  await page.getByRole('tab', { name: '工程素材' }).click()
  await page.getByRole('button', { name: '导入媒体', exact: true }).click()
  await page.locator('.bin-item').filter({ hasText: '模拟样音' }).click()
  await insert.click()
  await timecode.fill('2')
  await timecode.press('Enter')
  await drag(audio, lane('audio'), 2.08)
  await guide.getByText('播放头').waitFor()
  await page.mouse.up()
  const start = page.getByLabel('轨道起点（秒）')
  assert.equal(await start.inputValue(), '2')

  await magnet.click()
  await drag(audio, lane('audio'), 2.08)
  await ghost.waitFor()
  assert.equal(await guide.count(), 0)
  await page.mouse.up()
  assert.equal(await start.inputValue(), '2.08')

  await drag(audio, page.locator('.track-tail'), 2.08, 10)
  await marker.getByText('新建音频轨道').waitFor()
  await page.mouse.up()
  assert.equal(await page.locator('.lane[data-track-kind="audio"]').count(), 2)
  assert.equal(await lane('audio').locator('.timeline-clip').count(), 0)
  assert.equal(await start.inputValue(), '2.08')
  await page.waitForFunction(async () => {
    const { current } = await window.studio.initial()
    const { tracks, audio } = current.data.episodes[0]
    const lastTrack = tracks?.at(-1)
    return lastTrack?.kind === 'audio' && audio[0]?.trackId === lastTrack.id && audio[0].start === 2.08
  })
}
