/** 旧工程的角色图作为默认服饰继续可用，升级可逐个角色进行。 */
export const roleOutfits = (card) =>
  card?.type === '角色'
    ? (card.outfits ?? [{ id: 'default', name: '默认服饰', notes: '', assetId: card.assetId }])
    : []

export const defaultOutfit = (card) => card?.defaultOutfitId ?? 'default'

/** 显式服饰找不到时返回空值，避免误用角色的默认图片。 */
export function roleOutfit(card, outfitId) {
  return roleOutfits(card).find((outfit) => outfit.id === (outfitId || defaultOutfit(card)))
}

/** 旧的单图字段兼容原有的编辑器和脚本，启用服饰后以服饰自己的图片为准。 */
export function settingImage(card, outfitId) {
  return card?.type === '角色' ? roleOutfit(card, outfitId)?.assetId : card?.assetId
}

export const settingLabel = (card, outfitId) => {
  const outfit = outfitId && roleOutfit(card, outfitId)
  return outfit ? card.name + ' · ' + outfit.name : card.name
}

/** 手工与生成绑定共用服饰定位，旧角色保留原有的单图存储。 */
export function bindSettingImage(card, assetId, outfitId) {
  const outfit = roleOutfit(card, outfitId)
  if (!card || (outfitId && !outfit)) return
  if (card.outfits && outfit) outfit.assetId = assetId
  else card.assetId = assetId
}
