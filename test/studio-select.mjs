/** 驱动自绘下拉框，按值或列表中的可选项位置提交选择。 */
export async function chooseOption(page, trigger, value) {
  await trigger.click()
  const id = await trigger.getAttribute('aria-controls')
  const options = page.locator('[id="' + id + '"]').getByRole('option')
  const option =
    typeof value === 'number'
      ? options.and(page.locator(':not([aria-disabled="true"])')).nth(value)
      : options.and(page.locator('[data-value=' + JSON.stringify(value) + ']'))
  await option.click()
}
