<script setup vapor>
import SettingDesk from '../components/studio/SettingDesk.vue'
import ProductionOverview from '../components/studio/ProductionOverview.vue'
import ShotBoard from '../components/studio/ShotBoard.vue'
import ScreenplayDesk from '../components/studio/ScreenplayDesk.vue'
import MediaPool from '../components/studio/MediaPool.vue'
import '../studio.css'
import '../production.css'
import { doc, ui, edit } from '../store.js'
import { makeEpisode } from '../../shared/model.mjs'
function addEpisode() {
  const e = makeEpisode()
  e.title = '第 ' + (doc.value.episodes.length + 1) + ' 集'
  if (edit((d) => d.episodes.push(e))) ui.episodeId = e.id
}
</script>
<template>
  <div
    class="page studio-work"
    :class="{ 'directory-work': ['cards', 'shots'].includes(ui.page) }"
    v-if="doc"
  >
    <ProductionOverview v-if="ui.page === 'overview'" @add-episode="addEpisode" />

    <ScreenplayDesk v-if="ui.page === 'story'" @add-episode="addEpisode" />
    <SettingDesk v-if="ui.page === 'cards'" />
    <ShotBoard v-if="ui.page === 'shots'" />

    <MediaPool v-if="ui.page === 'media'" />
  </div>
</template>
