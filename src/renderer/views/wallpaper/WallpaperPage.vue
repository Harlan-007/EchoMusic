<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import LyricPage from '@/views/lyric/LyricPage.vue';
import { connectWallpaperSync } from '@/wallpaper/sync';
import { portraitLyricCollapsed } from '@/views/lyric/portraitCollapseState';
import WallpaperDim from './WallpaperDim.vue';
import WallpaperParticles from './WallpaperParticles.vue';
import {
  DEFAULT_WALLPAPER_SETTINGS,
  DEFAULT_WALLPAPER_TEXTURE,
  getWallpaperPalette,
  type WallpaperSettings,
  type WallpaperState,
  type WallpaperTextureSettings,
} from '../../../shared/wallpaper';

defineOptions({ name: 'wallpaper-page' });

// 壁纸窗口：整页复用主界面的歌词页，只保留画面，不接受鼠标与键盘操作
const state = ref<WallpaperState | null>(null);
const settings = computed<WallpaperSettings>(
  () => state.value?.settings ?? DEFAULT_WALLPAPER_SETTINGS,
);
// 「仅歌词」的画面质感参数，由设置页实时改写，这里只读。
const texture = computed<WallpaperTextureSettings>(
  () => settings.value.texture ?? DEFAULT_WALLPAPER_TEXTURE,
);
// 整套配色：压暗底色、浮尘颜色、歌词颜色都从这里取，只在壁纸窗口生效。
const palette = computed(() => getWallpaperPalette(settings.value.palette));
// 配色自带的歌词颜色只在「仅歌词」时生效；「跟随播放页」必须与播放页完全一致。
const lyricColor = computed(() =>
  settings.value.contentMode === 'lyric' ? palette.value.lyric || undefined : undefined,
);
let disposeState: (() => void) | null = null;
let disposeSync: (() => void) | null = null;

// 壁纸窗口是桌面层上的一层画面：html/body/#app 必须透明，
// 否则「仅歌词」的样式再透也透不出桌面。与桌面歌词、Mini 播放器同一套做法。
const WALLPAPER_WINDOW_CLASS = 'desktop-wallpaper-window';
const setWindowClass = (present: boolean) => {
  const nodes = [document.documentElement, document.body, document.getElementById('app')];
  for (const node of nodes) node?.classList.toggle(WALLPAPER_WINDOW_CLASS, present);
};

onMounted(async () => {
  setWindowClass(true);
  disposeSync = connectWallpaperSync();
  try {
    state.value = await window.electron.wallpaper.getState();
  } catch {
    // 读取失败时按默认设置渲染，不影响画面
  }
  disposeState = window.electron.wallpaper.onStateChange((next) => {
    state.value = next;
  });
});

onUnmounted(() => {
  setWindowClass(false);
  disposeState?.();
  disposeState = null;
  disposeSync?.();
  disposeSync = null;
});
</script>

<template>
  <div class="wallpaper-root" aria-hidden="true">
    <div v-if="settings.contentMode !== 'lyric'" class="wallpaper-backdrop"></div>
    <LyricPage
      presentation="wallpaper"
      :clear-background="settings.contentMode === 'lyric'"
      :dim-wallpaper="texture.dimEnabled"
      :portrait-collapsed="portraitLyricCollapsed"
      :lyric-color="lyricColor"
    />
    <!-- 「仅歌词」：贴边压暗 + 浮尘粒子，让画面有层次 -->
    <template v-if="settings.contentMode === 'lyric'">
      <WallpaperDim
        v-if="texture.dimEnabled"
        :edge-start="texture.edgeStart"
        :edge-darkness="texture.edgeDarkness"
        :color="palette.dim"
      />
      <WallpaperParticles
        v-if="texture.particleEnabled"
        :density="texture.particleDensity"
        :size="texture.particleSize"
        :color="palette.particle"
      />
    </template>
  </div>
</template>

<style scoped>
.wallpaper-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 跟随播放页：给不自绘背景的皮肤（插件皮肤）垫一层主界面底色，
   与在应用窗口里看到的效果保持一致。 */
.wallpaper-backdrop {
  position: fixed;
  inset: 0;
  background: var(--surface-main-base, #1a1d22);
}

/* 兜底：歌词页里所有可操作元素在壁纸中不显示 */
.wallpaper-root :deep(button),
.wallpaper-root :deep([role='button']),
.wallpaper-root :deep([role='slider']),
.wallpaper-root :deep(input),
.wallpaper-root :deep(textarea),
.wallpaper-root :deep(select),
.wallpaper-root :deep(.no-drag) {
  display: none !important;
}
</style>
