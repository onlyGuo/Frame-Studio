import assert from 'node:assert/strict'

/** 经真实桌面控件验证输入法、键盘插入、剪贴板、视觉标签、改名和删除。 */
export async function verifyShotMentions(page) {
  const cards = page.getByRole('button', { name: '角色与设定', exact: true })
  const board = page.getByRole('button', { name: '分镜工作台', exact: true })
  await cards.click()
  for (const [kind, name] of [
    ['角色', '阿宁'],
    ['场景', '车站'],
    ['道具', '红伞']
  ]) {
    if (kind !== '角色') await page.locator('.setting-filters button').filter({ hasText: kind }).click()
    await page.getByRole('button', { name: kind === '角色' ? '新建设定卡' : '新建' + kind }).click()
    assert.equal(await page.getByLabel('类型', { exact: true }).last().getAttribute('data-value'), kind)
    await page.getByLabel('名称', { exact: true }).last().fill(name)
    await page.getByLabel('名称', { exact: true }).last().press('Tab')
  }
  await board.click()
  const editor = page.getByLabel('画面与运镜')
  await editor.fill('')
  await editor.focus()
  await page.keyboard.insertText('推近，@')
  await page.getByRole('option', { name: /阿宁/ }).waitFor()
  await editor.press('ArrowDown')
  await editor.press('Enter')
  assert.equal(await editor.locator('[data-card-id]').count(), 1)
  assert.match(await editor.innerText(), /车站/)
  await page.keyboard.insertText('门口的')
  await page.getByRole('button', { name: '插入角色' }).click()
  await page.getByRole('option', { name: /阿宁/ }).click()
  await page.keyboard.insertText('举起@红')
  await page.getByRole('option', { name: /红伞/ }).waitFor()
  await editor.press('Enter')
  const ids = await editor
    .locator('[data-card-id]')
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.cardId))
  assert.equal(new Set(ids).size, 3)
  await editor.press('Backspace')
  assert.equal(await editor.locator('[data-card-id]').count(), 2)
  await page.getByRole('button', { name: '插入道具' }).click()
  await editor.press('Enter')
  const clipboard = await editor.evaluate((el) => {
    const selection = window.getSelection()
    selection.selectAllChildren(el)
    const data = new DataTransfer()
    el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
    const plain = data.getData('text/plain'),
      internal = data.getData('application/x-frame-shot-script')
    selection.collapseToEnd()
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    return { plain, internal }
  })
  assert.equal(clipboard.plain, '推近，@车站门口的@阿宁举起@红伞')
  assert.equal(
    JSON.parse(clipboard.internal).text,
    '推近，@{card:' + ids[0] + '}门口的@{card:' + ids[1] + '}举起@{card:' + ids[2] + '}'
  )
  assert.equal(await editor.locator('[data-card-id]').count(), 6)
  await page.keyboard.insertText('@')
  await page.getByRole('listbox', { name: '设定资产' }).waitFor()
  // 输入法确认候选字时的 Enter 不应误插入当前资产。
  await editor.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    )
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  assert.equal(await editor.locator('[data-card-id]').count(), 6)
  await editor.press('Escape')
  assert.equal(await page.getByRole('listbox', { name: '设定资产' }).count(), 0)
  assert.equal(await page.getByRole('region', { name: '本集引用资产' }).getByRole('button').count(), 3)
  await page.getByRole('button', { name: '查看场景设定：车站' }).click()
  assert.equal(await page.getByRole('article').count(), 1)
  assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '车站')
  await page.getByRole('button', { name: /第一集 · 镜头 1 · 新镜头/ }).click()
  assert.equal(await editor.locator('[data-card-id]').count(), 6)
  await cards.click()
  // 前面的脚本修改会异步保存，等它落盘后再编辑采用失焦提交的名称字段。
  await page.getByText('已保存至本地', { exact: true }).waitFor()
  const actorName = page.getByRole('article', { name: '角色设定：阿宁' }).getByLabel('名称', { exact: true })
  await actorName.fill('叶宁')
  await actorName.blur()
  const actor = page.getByRole('article', { name: '角色设定：叶宁' })
  await actor.waitFor()
  await page.getByText('已保存至本地', { exact: true }).waitFor()
  await page.getByRole('article', { name: '道具设定：红伞' }).getByTitle('移除设定卡').click()
  await board.click()
  assert.match(await editor.innerText(), /叶宁/)
  assert.equal(await editor.locator('[data-card-id][data-kind=""]').count(), 2)
  assert.equal(await editor.locator('[data-card-id]').count(), 6)
  const chip = editor.locator('[data-card-id]').first()
  await chip.locator('.mention-chip-type').click()
  await page.getByRole('option', { name: /叶宁/ }).click()
  assert.equal(await editor.locator('[data-card-id]').first().getAttribute('data-card-id'), ids[1])
  await editor.locator('[data-remove]').first().click()
  assert.equal(await editor.locator('[data-card-id]').count(), 5)
  await page.getByRole('button', { name: '插入角色' }).click()
  if (process.env.STUDIO_MENTION_SCREENSHOT)
    await page.screenshot({ path: process.env.STUDIO_MENTION_SCREENSHOT })
  await editor.press('Escape')
  await cards.click()
  await actor.getByRole('button', { name: '添加服饰' }).click()
  const costume = actor.getByLabel('服饰名称', { exact: true })
  await costume.fill('旅行风衣')
  await costume.press('Tab')
  const outfitId = await actor.locator('.outfit-editor').getByRole('combobox').getAttribute('data-value')
  await actor.getByRole('button', { name: '设为默认', exact: true }).click()
  await board.click()
  await page.getByRole('button', { name: '插入角色' }).click()
  await page.getByRole('option').filter({ hasText: '叶宁 · 旅行风衣' }).click()
  const variant = editor.locator('[data-outfit-id]')
  assert.equal(await variant.getAttribute('data-outfit-id'), outfitId)
  assert.match(await variant.innerText(), /旅行风衣/)
  await page.waitForFunction(async (outfitId) => {
    const project = (await window.studio.initial()).current.data
    return project.episodes[0].shots[0]?.prompt.includes(':' + outfitId + '}')
  }, outfitId)
}
