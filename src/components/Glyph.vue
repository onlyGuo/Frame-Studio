<script setup vapor>
defineProps({ name: String, size: { type: Number, default: 18 } })
// 单色线性图标统一界面动作及导航语义。
const paths = {
  sun: 'M12 8a4 4 0 1 0 .01 0 M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11z',
  display: 'M3 4h18v13H3z M12 17v3m-4 1h8',
  panel: 'M3 4h18v16H3z M9 4v16',
  home: 'M3 10 12 3l9 7v10H3z M9 20v-7h6v7',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  folder: 'M3 6h6l2 3h10v11H3z',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  arrowUp: 'M12 20V4m-7 7 7-7 7 7',
  down: 'm6 9 6 6 6-6',
  chevron: 'm9 5 7 7-7 7',
  pen: 'm4 16 12-12 4 4L8 20l-5 1z M13 7l4 4',
  cards: 'M4 5h16v14H4z M8 9h3v3H8z M14 9h3m-3 4h3M8 16h9',
  shots: 'M3 5h18v14H3z M3 9h18M8 5v4m7-4v4m-5 3 4 2-4 2z',
  edit: 'M3 6h18M5 12h14M3 18h18 M8 3v6m8 0v6m-6 0v6',
  media: 'M3 4h18v16H3z M3 17l6-6 4 4 3-3 5 5 M15 8h.01',
  settings: 'M4 6h16M4 12h16M4 18h16 M8 3v6m8 0v6m-7 0v6',
  skill: 'm12 2 9 5v10l-9 5-9-5V7z M3 7l9 5 9-5m-9 5v10',
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z',
  film: 'M3 4h18v16H3z M7 4v16m10-16v16M3 9h4m-4 5h4m10-5h4m-4 5h4',
  download: 'M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5',
  up: 'M12 16V4m-5 5 5-5 5 5 M4 17v4h16v-4',
  x: 'M5 5l14 14M19 5 5 19',
  play: 'm7 4 13 8-13 8z',
  pause: 'M7 4v16m10-16v16',
  back: 'm14 5-7 7 7 7',
  trash: 'M4 6h16m-13 0 1 15h8l1-15M9 6V3h6v3',
  chat: 'M3 4h18v13H9l-6 4z M7 9h10m-10 4h6',
  check: 'm4 12 5 5 11-12',
  clock: 'M12 3a9 9 0 1 0 .01 0 M12 6v6l4 2',
  undo: 'M8 5 3 10l5 5 M4 10h10a6 6 0 0 1 0 12',
  redo: 'm16 5 5 5-5 5m4-5H10a6 6 0 0 0 0 12',
  volume: 'M3 9h4l5-4v14l-5-4H3z M15 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12',
  mute: 'M3 9h4l5-4v14l-5-4H3z M16 9l5 6m0-6-5 6',
  audio: 'M9 17V5l10-2v12 M9 17a3 3 0 1 1-3-3h3m10 1a3 3 0 1 1-3-3h3',
  sliders: 'M4 4h16v16H4z M8 8v8m4-8v8m4-8v8',
  split: 'M12 2v20M2 7h7v10H2zm13 0h7v10h-7z',
  search: 'M10 3a7 7 0 1 0 .01 0 M15 15l6 6',
  lock: 'M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3',
  send: 'm3 4 18 8-18 8 3-8z M6 12h15',
  terminal: 'M3 5h18v14H3z M6 9l3 3-3 3m5 0h5',
  compress: 'M8 3H5a1 1 0 0 0-1 1v5m0 6v5a1 1 0 0 0 1 1h3m8-18h3a1 1 0 0 1 1 1v5m0 6v5a1 1 0 0 1-1 1h-3M8 8h8M8 12h8m-8 4h5',
  expand: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  shrink: 'M4 9h5V4m6 0v5h5M4 15h5v5m6 0v-5h5',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01'
}
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
