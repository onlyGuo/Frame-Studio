/** 校验可随工程包跨平台转移的 work/ 相对文件路径。 */
export function validWorkPath(name) {
  return (
    name.startsWith('work/') &&
    name.length < 1024 &&
    name
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          !/[<>:"\\|?*\x00-\x1f]/.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)
      )
  )
}
