/**
 * 壁纸的绘制策略：把「是否在放歌、被遮挡到什么程度、是否全屏」换算成
 * 每块屏的目标帧率与可见性。这里是纯函数，便于单元测试。
 */
import type { WallpaperPauseBehavior } from '../../shared/wallpaper';

/** 被遮挡多少之后开始降帧。 */
export const WALLPAPER_OCCLUDED_RATIO = 0.75;
/** 正常播放时的帧率由设置里的性能档位给出，见 WALLPAPER_FRAME_PRESETS。 */
/** 暂停但保留画面时的帧率：画面静止，1fps 只为应对主题/字体变化。 */
export const WALLPAPER_IDLE_FPS = 1;

export type WallpaperFrameReason =
  'disabled' | 'detached' | 'fullscreen' | 'occluded' | 'paused' | 'playing';

export interface WallpaperFrameInput {
  enabled: boolean;
  attached: boolean;
  playing: boolean;
  coverage: number;
  fullscreen: boolean;
  pauseBehavior: WallpaperPauseBehavior;
  /** 正常渲染时的目标帧率。 */
  playingFps: number;
  occludedFps: number;
  stopOnFullscreen: boolean;
}

export interface WallpaperFramePolicy {
  frameRate: number;
  visible: boolean;
  reason: WallpaperFrameReason;
}

export const resolveWallpaperFrame = (input: WallpaperFrameInput): WallpaperFramePolicy => {
  if (!input.enabled) return { frameRate: 0, visible: false, reason: 'disabled' };
  if (!input.attached) return { frameRate: 0, visible: false, reason: 'detached' };
  // 全屏时桌面本身不可见，直接停画；单独设置项便于用户关掉（某些多屏场景）。
  if (input.fullscreen && input.stopOnFullscreen) {
    return { frameRate: 0, visible: false, reason: 'fullscreen' };
  }
  if (input.coverage >= WALLPAPER_OCCLUDED_RATIO) {
    const fps = Math.min(input.playingFps, Math.max(0, Math.round(input.occludedFps)));
    return { frameRate: fps, visible: fps > 0, reason: 'occluded' };
  }
  if (!input.playing) {
    if (input.pauseBehavior === 'hide') {
      return { frameRate: 0, visible: false, reason: 'paused' };
    }
    return { frameRate: WALLPAPER_IDLE_FPS, visible: true, reason: 'paused' };
  }
  return { frameRate: Math.max(1, Math.round(input.playingFps)), visible: true, reason: 'playing' };
};
