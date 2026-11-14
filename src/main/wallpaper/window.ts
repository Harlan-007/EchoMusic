/**
 * 桌面壁纸窗口：每块被选中的显示器一个窗口，挂在 Explorer 的 WorkerW 上。
 * 内容复用主渲染进程（index.html + #/wallpaper），因此不用重新注入 store。
 */
import { BrowserWindow, screen, type Display } from 'electron';
import { join } from 'node:path';
import { getNativeWallpaper, type NativeWallpaperMonitor } from '../native/platform';
import { installWindowBackgroundThrottling } from '../windowBackgroundThrottling';
import log from '../logger';

export interface WallpaperSurface {
  displayId: string;
  win: BrowserWindow;
  monitor: NativeWallpaperMonitor | null;
  coverage: number;
  fullscreen: boolean;
  attached: boolean;
  /** 这个窗口在该显示器上应占的屏幕矩形（屏幕坐标）。 */
  rect: { x: number; y: number; width: number; height: number };
}

export interface WallpaperOcclusionEvent {
  coverage: number;
  fullscreen: boolean;
}

/** BrowserWindow 的原生句柄统一转成十进制字符串，与 native 侧的解析保持一致。 */
const nativeHandle = (win: BrowserWindow): string => {
  const buffer = win.getNativeWindowHandle();
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0).toString() : String(buffer.readUInt32LE(0));
};

/**
 * 壁纸在该显示器上应占的矩形：左右按整屏算（工作区左右会被桌面浮窗挤掉几像素，
 * 用工作区会导致两边露边），底边跟随工作区底边——任务栏不自动隐藏时让开任务栏，
 * 自动隐藏后工作区就是整块屏，壁纸随之铺满。
 */
const displayBounds = (display: Display) => ({
  x: Math.round(display.bounds.x),
  y: Math.round(display.bounds.y),
  width: Math.max(1, Math.round(display.bounds.width)),
  height: Math.max(1, Math.round(display.workArea.y + display.workArea.height - display.bounds.y)),
});

/** 目标矩形是否已经就是这个尺寸（任务栏显示/隐藏、改分辨率都会走到这里）。 */
export const surfaceMatchesDisplay = (surface: WallpaperSurface, display: Display): boolean => {
  const bounds = displayBounds(display);
  return (
    surface.rect.x === bounds.x &&
    surface.rect.y === bounds.y &&
    surface.rect.width === bounds.width &&
    surface.rect.height === bounds.height
  );
};

/** 等首帧绘制完成再挂载：SetParent 之后 Chromium 才会按新父窗口合成。 */
const waitForFirstPaint = (win: BrowserWindow): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    win.webContents.once('did-finish-load', () => setTimeout(finish, 60));
    win.webContents.once('did-fail-load', finish);
    setTimeout(finish, 4000);
  });

export const createWallpaperSurface = async (
  display: Display,
  onOcclusion: (event: WallpaperOcclusionEvent) => void,
): Promise<WallpaperSurface | null> => {
  const native = getNativeWallpaper();
  if (!native) {
    log.warn('[Wallpaper] 原生模块不支持壁纸挂载，请重新构建 echo-platform-adaptor');
    return null;
  }
  const bounds = displayBounds(display);
  const candidate = new BrowserWindow({
    ...bounds,
    title: 'EchoMusic 桌面壁纸',
    frame: false,
    // 无边框窗口默认仍带 WS_THICKFRAME，客户区四边被隐形边框吃掉 7px，
    // 画面就填不满窗口，桌面上会露出原来壁纸的窄条。
    thickFrame: false,
    // 透明底：仅歌词模式要让系统桌面壁纸透出来，其余模式由页面自己画背景。
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    // 桌面层窗口不参与任务切换，Windows 上按工具窗口处理最省事。
    type: process.platform === 'win32' ? 'toolbar' : 'desktop',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true,
      zoomFactor: 1,
      disableDialogs: true,
    },
  });
  installWindowBackgroundThrottling(candidate);
  // 页面 <title> 会把窗口标题覆盖成 `EchoMusic`，固定住便于排查时按标题找窗口。
  candidate.on('page-title-updated', (event) => event.preventDefault());
  const surface: WallpaperSurface = {
    displayId: String(display.id),
    win: candidate,
    monitor: null,
    coverage: 0,
    fullscreen: false,
    attached: false,
    rect: bounds,
  };
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) {
    const url = new URL('index.html', dev);
    url.hash = '/wallpaper';
    await candidate.loadURL(url.toString());
  } else {
    await candidate.loadFile(join(__dirname, '../../dist/index.html'), { hash: '/wallpaper' });
  }
  await waitForFirstPaint(candidate);
  // 先让窗口完成首帧合成再挂进桌面层：直接挂载时 Chromium 还没出过画面，
  // 桌面上会出现一块纯黑区域，直到有下一次重绘。
  candidate.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 120));
  try {
    const handle = nativeHandle(candidate);
    native.wallpaperAttach(handle);
    native.wallpaperResize(handle, bounds.x, bounds.y, bounds.width, bounds.height);
    surface.attached = true;
    log.info(
      '[Wallpaper] 已挂载到显示器 ' +
        surface.displayId +
        '（屏幕 ' +
        display.size.width +
        'x' +
        display.size.height +
        '，窗口 ' +
        bounds.width +
        'x' +
        bounds.height +
        '）',
    );
    surface.monitor = new native.WallpaperMonitor(handle, 500, (state) => {
      surface.coverage = state.coverage;
      surface.fullscreen = state.fullscreen;
      onOcclusion({ coverage: state.coverage, fullscreen: state.fullscreen });
    });
  } catch (error) {
    log.error('[Wallpaper] 挂载失败:', error);
    candidate.destroy();
    return null;
  }
  return surface;
};

/**
 * 显示器矩形变化（任务栏显示/隐藏、改分辨率、改缩放）后按新矩形摆一遍。
 * 窗口只是换尺寸，内容不重建，歌词和播放不会中断。
 */
export const resizeWallpaperSurface = (surface: WallpaperSurface, display: Display): void => {
  if (surface.win.isDestroyed()) return;
  const bounds = displayBounds(display);
  surface.rect = bounds;
  surface.win.setBounds(bounds);
  const actual = surface.win.getBounds();
  if (
    actual.x !== bounds.x ||
    actual.y !== bounds.y ||
    actual.width !== bounds.width ||
    actual.height !== bounds.height
  ) {
    log.warn('[Wallpaper] 窗口尺寸被系统夹住', actual, '目标', bounds);
  }
  const native = getNativeWallpaper();
  if (!native || !surface.attached) return;
  try {
    native.wallpaperResize(
      nativeHandle(surface.win),
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    );
  } catch (error) {
    log.warn('[Wallpaper] 调整尺寸失败:', error);
  }
};

export const destroyWallpaperSurface = (surface: WallpaperSurface): void => {
  try {
    surface.monitor?.stop();
  } catch (error) {
    log.warn('[Wallpaper] 停止遮挡监控失败:', error);
  }
  surface.monitor = null;
  const native = getNativeWallpaper();
  if (native && surface.attached) {
    try {
      native.wallpaperDetach(nativeHandle(surface.win));
    } catch (error) {
      log.warn('[Wallpaper] 解挂失败:', error);
    }
    surface.attached = false;
  }
  if (!surface.win.isDestroyed()) surface.win.destroy();
};

/** 按显示器 id 找当前显示器；找不到或已被拔掉时回落到主屏。 */
export const resolveDisplays = (displayIds: string[]): Display[] => {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const wanted = displayIds
    .map((id) => all.find((display) => String(display.id) === id))
    .filter((display): display is Display => Boolean(display));
  if (wanted.length) return wanted;
  return [primary];
};
