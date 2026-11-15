/**
 * 桌面壁纸：开关注册、显示器编排、省电策略与 IPC。
 *
 * 与桌面歌词互斥：打开壁纸会关掉桌面歌词，避免两套歌词同时抢桌面。
 */
import { app, powerMonitor, screen, type Display, type IpcMainInvokeEvent } from 'electron';
import { ipcRegistry } from '../ipc/registry';
import { getMainWindow } from '../window';
import { getMainAppSettings, setMainAppSetting } from '../storage/settings';
import { setDesktopLyricExclusionHook, updateDesktopLyricSettings } from '../desktopLyric';
import { getNowPlayingSnapshot, onNowPlayingChange } from '../nowPlaying';
import { getNativeWallpaper } from '../native/platform';
import {
  createWallpaperSurface,
  destroyWallpaperSurface,
  placeWallpaperSurface,
  resizeWallpaperSurface,
  resolveDisplays,
  surfaceMatchesDisplay,
  type WallpaperSurface,
} from './window';
import { resolveWallpaperFrame, type WallpaperFramePolicy } from './policy';
import {
  DEFAULT_WALLPAPER_SETTINGS,
  getWallpaperFramePreset,
  normalizeWallpaperSettings,
  type WallpaperDisplay,
  type WallpaperSettings,
  type WallpaperState,
} from '../../shared/wallpaper';
import log from '../logger';

const surfaces = new Map<string, WallpaperSurface>();
let enabled = false;
let quitting = false;
let settings: WallpaperSettings = { ...DEFAULT_WALLPAPER_SETTINGS };
let settingsLoaded = false;
let coverage = 0;
let fullscreen = false;
let lastPolicy: WallpaperFramePolicy | null = null;
let busy: Promise<void> | null = null;
let disposeNowPlaying: (() => void) | null = null;

const loadSettings = () => {
  if (settingsLoaded) return;
  settingsLoaded = true;
  const saved = getMainAppSettings();
  enabled = saved.wallpaperEnabled === true;
  settings = normalizeWallpaperSettings(saved.wallpaper);
  // 没指定过屏幕（首次启动或旧配置）时只勾选主屏幕，其余屏幕留给用户自己开。
  if (settings.displayIds.length === 0) {
    settings = { ...settings, displayIds: [String(screen.getPrimaryDisplay().id)] };
    setMainAppSetting('wallpaper', settings);
  }
};

/** 串行化开关/重建，避免连点设置时同时创建多套窗口。 */
const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
  const next = (busy ?? Promise.resolve()).then(task, task);
  busy = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

const listDisplays = (): WallpaperDisplay[] => {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    label: display.label || `显示器 ${display.id}`,
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    primary: display.id === primary.id,
  }));
};

const activeDisplayIds = (): string[] => Array.from(surfaces.keys());

const state = (): WallpaperState => ({
  enabled,
  supported: getNativeWallpaper() !== null,
  attached: surfaces.size > 0,
  activeDisplayIds: activeDisplayIds(),
  coverage,
  fullscreen,
  frameRate: lastPolicy?.frameRate ?? 0,
  reason: lastPolicy?.reason ?? 'disabled',
  displays: listDisplays(),
  settings,
});

const broadcastState = () => {
  const payload = state();
  const targets = [getMainWindow(), ...surfaces.values().map((surface) => surface.win)];
  for (const target of targets) {
    if (target && !target.isDestroyed()) target.webContents.send('wallpaper:state', payload);
  }
};

const isPlayingNow = (): boolean => {
  const snapshot = getNowPlayingSnapshot() as {
    playback?: { isPlaying?: boolean };
    isPlaying?: boolean;
  } | null;
  return Boolean(snapshot?.playback?.isPlaying ?? snapshot?.isPlaying);
};

/** 应用省电策略：可见性 + 帧率。状态没变就不重复下发。 */
const applyPolicy = () => {
  if (!surfaces.size) {
    lastPolicy = { frameRate: 0, visible: false, reason: enabled ? 'detached' : 'disabled' };
    return;
  }
  // 性能档位同时决定「正常播放」与「被遮挡」两档帧率。
  const preset = getWallpaperFramePreset(settings.frameProfile);
  const policy = resolveWallpaperFrame({
    enabled,
    attached: true,
    playing: isPlayingNow(),
    coverage,
    fullscreen,
    pauseBehavior: settings.pauseBehavior,
    playingFps: preset.playing,
    occludedFps: preset.occluded,
    stopOnFullscreen: settings.stopOnFullscreen,
  });
  lastPolicy = policy;
  // 逐个窗口比对「已经下发过的策略」，而不是只跟上一轮的全局策略比：新建的窗口
  // 是在上一轮下发之后才出现的，只比全局会把它漏掉，它就一直停在创建时的可见状态。
  for (const surface of surfaces.values()) {
    if (surface.win.isDestroyed()) continue;
    const applied = surface.applied;
    if (applied && applied.frameRate === policy.frameRate && applied.visible === policy.visible) {
      continue;
    }
    surface.applied = { frameRate: policy.frameRate, visible: policy.visible };
    try {
      surface.win.webContents.setFrameRate(policy.frameRate);
      surface.win.webContents.setBackgroundThrottling(!policy.visible);
    } catch (error) {
      log.warn('[Wallpaper] 设置帧率失败:', error);
    }
    // 隐藏的窗口 Chromium 不再合成，比降到 0fps 更省。
    if (policy.visible && !surface.win.isVisible()) {
      surface.win.showInactive();
      // 重新显示时 Chromium 会按屏幕坐标恢复 bounds，子窗口会偏一个宿主原点。
      placeWallpaperSurface(surface);
    }
    if (!policy.visible && surface.win.isVisible()) surface.win.hide();
  }
  broadcastState();
};

const handleOcclusion = (event: { coverage: number; fullscreen: boolean }) => {
  coverage = event.coverage;
  fullscreen = event.fullscreen;
  applyPolicy();
};

/**
 * 桌面层被 Explorer 重建（比如「显示桌面」、切换虚拟桌面、Explorer 重启）时，
 * 挂在它下面的窗口会被一起销毁，或者被系统藏起来。这里兜住这两种情况，
 * 否则 surfaces 里留着一个死窗口，重建时又因为「这个显示器已经有了」被跳过，
 * 壁纸就再也回不来了。
 */
const watchSurface = (surface: WallpaperSurface) => {
  const id = surface.displayId;
  surface.win.on('closed', () => {
    // 主动销毁时 surfaces 里已经不是它了，不用管。
    if (surfaces.get(id) !== surface) return;
    surfaces.delete(id);
    if (!enabled || quitting) return;
    void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重建失败:', error));
  });
  surface.win.on('hide', () => {
    if (surface.win.isDestroyed()) return;
    if (!lastPolicy?.visible) return;
    // 不该隐藏却隐藏了（系统收起了桌面层），重新显示并按宿主坐标摆正。
    surface.win.showInactive();
    placeWallpaperSurface(surface);
  });
};

/** 短时间内反复被销毁说明重建也不会好（例如桌面层一直被顶着），先停下来。 */
const lossGuard = new Map<string, { count: number; at: number }>();
const MAX_LOSS_REBUILDS = 3;
const LOSS_WINDOW_MS = 60_000;

/**
 * 桌面层被 Explorer 重建时（「显示桌面」、切换虚拟桌面、Explorer 重启），挂在
 * 它下面的子窗口会被系统直接销毁，Electron 侧可能还当它活着，导致重建时被
 * 「这个显示器已经有了」跳过。这里把它从表里摘掉并重建一次。
 */
const handleSurfaceLost = (displayId: string) => {
  const surface = surfaces.get(displayId);
  if (!surface) return;
  surfaces.delete(displayId);
  try {
    surface.monitor?.stop();
  } catch (error) {
    log.warn('[Wallpaper] 停止遮挡监控失败:', error);
  }
  surface.monitor = null;
  surface.attached = false;
  // 「窗口没了」只有在它本来就该开着的时候才值得重建：开关被关掉，或者这块屏
  // 已经从设置里取消勾选，就只是把这条记录摘掉，不重启。
  if (!enabled || quitting) return;
  const stillWanted = resolveDisplays(settings.displayIds).some(
    (display) => String(display.id) === displayId,
  );
  if (!stillWanted) {
    log.info('[Wallpaper] 屏幕已不再启用壁纸，跳过重建', displayId);
    return;
  }
  const now = Date.now();
  const recent = lossGuard.get(displayId);
  const tries = recent && now - recent.at < LOSS_WINDOW_MS ? recent.count + 1 : 1;
  lossGuard.set(displayId, { count: tries, at: now });
  if (tries > MAX_LOSS_REBUILDS) {
    log.warn('[Wallpaper] 桌面层窗口反复消失，暂停自动重建', displayId);
    return;
  }
  log.info('[Wallpaper] 桌面层窗口已被系统销毁，重建', displayId);
  void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重建失败:', error));
};

const createSurfacesFor = async (displays: Display[]) => {
  const targets: Display[] = [];
  for (const display of displays) {
    const id = String(display.id);
    if (surfaces.has(id)) {
      const current = surfaces.get(id);
      // 顺手清掉已经销毁、但还留在表里的窗口。
      if (current && !current.win.isDestroyed()) continue;
      surfaces.delete(id);
    }
    targets.push(display);
  }
  // 每个窗口都要单独加载一遍前端页面，串行会把启动时间乘以屏幕块数，这里并行建。
  const created = await Promise.all(
    targets.map((display) =>
      createWallpaperSurface(display, handleOcclusion, () => handleSurfaceLost(String(display.id))),
    ),
  );
  for (const surface of created) {
    if (!surface) continue;
    surfaces.set(surface.displayId, surface);
    watchSurface(surface);
  }
};

const destroyAll = () => {
  for (const surface of surfaces.values()) destroyWallpaperSurface(surface);
  surfaces.clear();
  coverage = 0;
  fullscreen = false;
  lastPolicy = null;
};

const rebuild = async () => {
  if (!enabled || quitting) {
    destroyAll();
    broadcastState();
    return;
  }
  // 只增删差集：显示器属性变化（比如任务栏隐藏）不该把已经画着的窗口拆了重来。
  const wanted = resolveDisplays(settings.displayIds);
  const keep = new Set(wanted.map((display) => String(display.id)));
  for (const [id, surface] of Array.from(surfaces.entries())) {
    if (keep.has(id)) continue;
    destroyWallpaperSurface(surface);
    surfaces.delete(id);
  }
  await createSurfacesFor(wanted);
  applyPolicy();
  broadcastState();
};

// 与桌面歌词互斥：两套歌词同时占桌面没有意义，也会多一份渲染。
const releaseDesktopLyric = async () => {
  try {
    await updateDesktopLyricSettings({ enabled: false });
  } catch (error) {
    log.warn('[Wallpaper] 关闭桌面歌词失败:', error);
  }
};

export const setWallpaperEnabled = (value: boolean): Promise<void> => {
  loadSettings();
  if (enabled === value) {
    if (!value) return Promise.resolve();
    return runExclusive(async () => {
      await releaseDesktopLyric();
      // 启动时开关已经是开的：这时还没有任何窗口，必须真的建一次。
      if (surfaces.size === 0) await rebuild();
    });
  }
  // 开关状态先落地并广播：建窗口、挂载要几百毫秒，界面不该等它。
  enabled = value;
  lossGuard.clear();
  setMainAppSetting('wallpaperEnabled', value);
  broadcastState();
  return runExclusive(async () => {
    if (value) await releaseDesktopLyric();
    await rebuild();
  });
};

// 设置一律同步生效：建窗口、挂载要几百毫秒，界面不该等它。
export const updateWallpaperSettings = (patch: Partial<WallpaperSettings>): WallpaperState => {
  // 改了设置说明用户又想看到壁纸了，把「反复消失」的计数清掉重来。
  lossGuard.clear();
  loadSettings();
  const next = normalizeWallpaperSettings({ ...settings, ...patch });
  const displaysChanged = next.displayIds.join(',') !== settings.displayIds.join(',');
  settings = next;
  setMainAppSetting('wallpaper', next);
  if (!displaysChanged) {
    applyPolicy();
    broadcastState();
    return state();
  }
  broadcastState();
  // 增删屏幕要建/毁窗口，这一步放到后台队列，设置本身已经落地。
  if (enabled) {
    void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 切换屏幕失败:', error));
  }
  return state();
};

export const restoreWallpaper = (): void => {
  quitting = false;
  loadSettings();
  if (!enabled) return;
  void setWallpaperEnabled(true).catch((error) => log.error('[Wallpaper] 恢复失败:', error));
};

export const cleanupWallpaper = (): void => {
  quitting = true;
  setDesktopLyricExclusionHook(null);
  disposeNowPlaying?.();
  disposeNowPlaying = null;
  destroyAll();
};

const isMainSender = (senderId: number): boolean => {
  const main = getMainWindow();
  return Boolean(main && !main.isDestroyed() && main.webContents.id === senderId);
};

const isTrustedSender = (event: IpcMainInvokeEvent): boolean =>
  // 壁纸窗口在挂载完成前就会来读状态，此时还不在 surfaces 里，只能按来源页面判断。
  isMainSender(event.sender.id) || event.sender.getURL().includes('/wallpaper');

export const registerWallpaperHandlers = (): void => {
  // 播放/暂停、换歌都要重算省电策略，否则壁纸会一直停在启动那一刻的档位。
  disposeNowPlaying?.();
  disposeNowPlaying = onNowPlayingChange(() => {
    if (enabled && surfaces.size) applyPolicy();
  });
  // 反向互斥：用户打开桌面歌词时，动态壁纸让位（壁纸占着桌面时两套歌词没有意义）。
  setDesktopLyricExclusionHook(async () => {
    if (!getMainAppSettings().wallpaperEnabled) return;
    await setWallpaperEnabled(false);
  });
  ipcRegistry.registerHandler('wallpaper:get-state', (event) => {
    if (!isTrustedSender(event)) throw new Error('Invalid wallpaper sender');
    loadSettings();
    return state();
  });
  ipcRegistry.registerHandler('wallpaper:set-enabled', (event, value: boolean) => {
    if (!isMainSender(event.sender.id)) throw new Error('Invalid wallpaper sender');
    if (typeof value !== 'boolean') throw new Error('Invalid wallpaper state');
    // 建窗口是后台任务，开关本身已经生效，这里不等它。
    void setWallpaperEnabled(value).catch((error) => log.error('[Wallpaper] 切换失败:', error));
    return state();
  });
  ipcRegistry.registerHandler(
    'wallpaper:set-settings',
    (event, value: Partial<WallpaperSettings>) => {
      if (!isMainSender(event.sender.id)) throw new Error('Invalid wallpaper sender');
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid wallpaper settings');
      }
      return updateWallpaperSettings(value);
    },
  );
  // screen / powerMonitor 只能在 app ready 之后使用，注册时应用还没就绪。
  void app.whenReady().then(() => {
    // 显示器增删/缩放变化时按当前设置重挂一遍。
    const onChange = () => {
      if (!enabled) return;
      void runExclusive(rebuild).catch((error) => log.error('[Wallpaper] 重建失败:', error));
    };
    screen.on('display-added', onChange);
    screen.on('display-removed', onChange);
    screen.on('display-metrics-changed', (_event, display) => {
      if (!enabled) return;
      const surface = surfaces.get(String(display.id));
      // 任务栏显示/隐藏、换分辨率、改缩放都会触发，矩形没变就什么都不做。
      if (!surface || surfaceMatchesDisplay(surface, display)) return;
      resizeWallpaperSurface(surface, display);
      broadcastState();
    });
    // 睡眠时不绘制；唤醒后重新判断遮挡。
    powerMonitor.on('suspend', () => {
      for (const surface of surfaces.values()) {
        if (!surface.win.isDestroyed()) surface.win.hide();
      }
    });
    powerMonitor.on('resume', () => {
      lastPolicy = null;
      applyPolicy();
    });
  });
};
