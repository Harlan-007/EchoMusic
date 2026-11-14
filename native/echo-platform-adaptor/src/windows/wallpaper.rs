//! 桌面壁纸层：把 Electron 窗口挂到 Explorer 的桌面（WorkerW）上，并按前景
//! 窗口的覆盖比例回报遮挡状态，供主进程决定降帧还是停画。
//!
//! 挂载顺序沿用任务栏歌词的结论：先 SetParent 再补样式，且必须先安装
//! window_lifecycle，否则桌面层被 Explorer 重建时本进程会 CHECK 崩溃。
use napi::{
    bindgen_prelude::Function,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
    Status,
};
use napi_derive::napi;
use std::{
    ffi::c_void,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use windows::{
    core::{w, BOOL},
    Win32::{
        Foundation::{HWND, RECT, LPARAM},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
            Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        UI::WindowsAndMessaging::*,
    },
};

type Callback =
    ThreadsafeFunction<WallpaperOcclusion, UnknownReturnValue, WallpaperOcclusion, Status, false>;

/// 遮挡状态。coverage 是前景窗口覆盖壁纸所在显示器的比例（0~1，按 1% 取整）。
#[napi(object)]
pub struct WallpaperOcclusion {
    pub coverage: f64,
    pub fullscreen: bool,
}

/// 当前挂载的桌面宿主（WorkerW）。子窗口坐标相对它，重置尺寸时要换算。
static HOST: Mutex<Option<isize>> = Mutex::new(None);

/// 最近一次摆放的**屏幕坐标**矩形。Chromium 会在窗口显示/隐藏、布局变化时
/// 用它自己那份（被夹到工作区的）bounds 覆盖回来，所以这里留一份真值，
/// 由遮挡监控线程顺带校正，左右就不会再露出去。
const DESKTOP_CLASSES: [&str; 6] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "ApplicationManager_DesktopShellWindow",
    "SysListView32",
];

fn parse_handle(handle: &str) -> napi::Result<HWND> {
    let value = handle
        .parse::<usize>()
        .map_err(|_| napi::Error::from_reason("Invalid window handle"))?;
    let hwnd = HWND(value as *mut c_void);
    if value == 0 || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err(napi::Error::from_reason(
            "Wallpaper window no longer exists",
        ));
    }
    Ok(hwnd)
}

unsafe extern "system" fn probe_desktop(top: HWND, lparam: LPARAM) -> BOOL {
    let found = lparam.0 as *mut isize;
    // 图标窗口 SHELLDLL_DefView 所在顶层窗口的**后面**才是可挂载的 WorkerW。
    if let Ok(view) = FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), None) {
        if !view.0.is_null() {
            if let Ok(worker) = FindWindowExW(None, Some(top), w!("WorkerW"), None) {
                if !worker.0.is_null() {
                    *found = worker.0 as isize;
                    return BOOL(0);
                }
            }
        }
    }
    BOOL(1)
}

/// 让 Explorer 生成挂载用的 WorkerW，然后返回它。
unsafe fn find_host() -> Option<HWND> {
    let progman = FindWindowW(w!("Progman"), None)
        .ok()
        .filter(|hwnd| !hwnd.0.is_null());
    let Some(progman) = progman else {
        return None;
    };
    // 0x052C：让 Explorer 把桌面拆出一个独立的 WorkerW，两条经典参数各发一次。
    for (wparam, lparam) in [(0usize, 0isize), (0xD, 1)] {
        let mut result = 0usize;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            windows::Win32::Foundation::WPARAM(wparam),
            LPARAM(lparam),
            SMTO_NORMAL,
            1000,
            Some(&mut result as *mut usize),
        );
    }
    thread::sleep(Duration::from_millis(80));
    // Win10/11 通用：图标窗口 SHELLDLL_DefView 所在顶层窗口后面那个 WorkerW。
    let mut found = 0isize;
    let _ = EnumWindows(Some(probe_desktop), LPARAM(&mut found as *mut isize as isize));
    if found != 0 {
        return Some(HWND(found as *mut c_void));
    }
    // 部分配置下 WorkerW 直接是 Progman 的子窗口。
    if let Ok(child) = FindWindowExW(Some(progman), None, w!("WorkerW"), None) {
        if !child.0.is_null() {
            return Some(child);
        }
    }
    // 最后兜底挂到 Progman 自己。
    Some(progman)
}

/// 把窗口挂到桌面层。返回是否成功挂到了 WorkerW（而非 Progman 兜底）。
#[napi]
pub fn wallpaper_attach(handle: String) -> napi::Result<()> {
    let child = parse_handle(&handle)?;
    unsafe {
        // 与任务栏歌词相同的宿主契约保护：桌面被 Explorer 重建时补发 WM_DESTROY。
        super::taskbar::window_lifecycle::install(child)?;
        let host = find_host()
            .ok_or_else(|| napi::Error::from_reason("找不到桌面宿主窗口（WorkerW）"))?;
        let style = GetWindowLongPtrW(child, GWL_STYLE);
        let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
        SetParent(child, Some(host)).map_err(|error| napi::Error::from_reason(error.message()))?;
        // 挂成子窗口：去掉弹出式边框，并禁止激活、不在任务栏出现。
        let popup = WS_POPUP.0 as isize;
        let caption = WS_CAPTION.0 as isize;
        let child_flag = WS_CHILD.0 as isize;
        SetWindowLongPtrW(
            child,
            GWL_STYLE,
            (style & !popup & !caption) | child_flag,
        );
        let no_activate = WS_EX_NOACTIVATE.0 as isize;
        let tool_window = WS_EX_TOOLWINDOW.0 as isize;
        let app_window = WS_EX_APPWINDOW.0 as isize;
        SetWindowLongPtrW(
            child,
            GWL_EXSTYLE,
            (ex | no_activate | tool_window) & !app_window,
        );
        // 挂到 Progman 时插到图标窗口（SHELLDLL_DefView）下面，桌面图标仍在壁纸上层。
        let mut insert_after = Some(HWND_BOTTOM);
        if class_name(host) == "Progman" {
            if let Ok(view) = FindWindowExW(Some(host), None, w!("SHELLDLL_DefView"), None) {
                if !view.0.is_null() {
                    insert_after = Some(view);
                }
            }
        }
        SetWindowPos(
            child,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
        .ok();
        if let Ok(mut guard) = HOST.lock() {
            *guard = Some(host.0 as isize);
        }
        Ok(())
    }
}

unsafe fn host_origin() -> (i32, i32) {
    let host = HOST
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .filter(|value| *value != 0);
    let mut origin = RECT::default();
    if let Some(host) = host {
        let _ = GetWindowRect(HWND(host as *mut c_void), &mut origin);
    }
    (origin.left, origin.top)
}

unsafe fn apply_rect(child: HWND, x: i32, y: i32, width: i32, height: i32) {
    let (origin_x, origin_y) = host_origin();
    SetWindowPos(
        child,
        Some(HWND_BOTTOM),
        x - origin_x,
        y - origin_y,
        width.max(1),
        height.max(1),
        SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
    )
    .ok();
}
/// 按屏幕坐标摆放壁纸窗口（会换算成宿主的客户区坐标）。
#[napi]
pub fn wallpaper_resize(
    handle: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> napi::Result<()> {
    let child = parse_handle(&handle)?;
    unsafe { apply_rect(child, x, y, width, height) };
    Ok(())
}


/// 解挂：先隐藏再 SetParent(None)，与任务栏歌词的退出顺序一致。
#[napi]
pub fn wallpaper_detach(handle: String) -> napi::Result<()> {
    let child = parse_handle(&handle)?;
    unsafe {
        let _ = ShowWindow(child, SW_HIDE);
        let _ = SetParent(child, None);
        let style = GetWindowLongPtrW(child, GWL_STYLE);
        SetWindowLongPtrW(
            child,
            GWL_STYLE,
            (style & !(WS_CHILD.0 as isize)) | WS_POPUP.0 as isize,
        );
        let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
        let mask = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize;
        SetWindowLongPtrW(child, GWL_EXSTYLE, ex & !mask);
    }
    if let Ok(mut guard) = HOST.lock() {
        *guard = None;
    }
    Ok(())
}

unsafe fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut buffer);
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

/// 计算前景窗口对本窗口所在显示器的覆盖比例。
unsafe fn measure(child: HWND) -> WallpaperOcclusion {
    let none = WallpaperOcclusion {
        coverage: 0.0,
        fullscreen: false,
    };
    let monitor = MonitorFromWindow(child, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return none;
    }
    let screen = info.rcMonitor;
    let area = (screen.right - screen.left) as i64 * (screen.bottom - screen.top) as i64;
    if area <= 0 {
        return none;
    }
    let foreground = GetForegroundWindow();
    if foreground.0.is_null() || foreground == child {
        return none;
    }
    if DESKTOP_CLASSES.contains(&class_name(foreground).as_str()) {
        return none;
    }
    if !IsWindowVisible(foreground).as_bool() || IsIconic(foreground).as_bool() {
        return none;
    }
    let mut rect = RECT::default();
    let mut ok = DwmGetWindowAttribute(
        foreground,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut rect as *mut RECT as *mut c_void,
        size_of::<RECT>() as u32,
    )
    .is_ok();
    if !ok {
        ok = GetWindowRect(foreground, &mut rect).is_ok();
    }
    if !ok {
        return none;
    }
    let left = rect.left.max(screen.left);
    let top = rect.top.max(screen.top);
    let right = rect.right.min(screen.right);
    let bottom = rect.bottom.min(screen.bottom);
    if right <= left || bottom <= top {
        return none;
    }
    let covered = (right - left) as i64 * (bottom - top) as i64;
    let coverage = (covered as f64 / area as f64).clamp(0.0, 1.0);
    // 最大化窗口和全屏应用都会把桌面整块盖住，壁纸一点都露不出来，
    // 所以两者都按全屏处理：真全屏靠面积判定，最大化靠窗口状态判定
    // （最大化窗口会让开任务栏，面积略小于 1）。
    let maximized = IsZoomed(foreground).as_bool();
    WallpaperOcclusion {
        coverage: (coverage * 100.0).round() / 100.0,
        fullscreen: maximized || coverage >= 0.995,
    }
}

fn run(child: usize, stopped: Arc<AtomicBool>, interval: Arc<AtomicI32>, callback: Callback) {
    let hwnd = HWND(child as *mut c_void);
    let mut last: Option<(i32, bool)> = None;
    while !stopped.load(Ordering::Acquire) {
        let state = unsafe { measure(hwnd) };
        let key = ((state.coverage * 100.0) as i32, state.fullscreen);
        if last != Some(key) {
            last = Some(key);
            let _ = callback.call(state, ThreadsafeFunctionCallMode::NonBlocking);
        }
        thread::sleep(Duration::from_millis(
            interval.load(Ordering::Acquire).max(120) as u64,
        ));
    }
}

/// 遮挡监控：只在状态变化时回调，避免每秒唤醒渲染层。
#[napi]
pub struct WallpaperMonitor {
    stopped: Arc<AtomicBool>,
    interval: Arc<AtomicI32>,
    child: usize,
}

#[napi]
impl WallpaperMonitor {
    #[napi(
        constructor,
        ts_args_type = "handle: string, intervalMs: number, callback: (state: WallpaperOcclusion) => void"
    )]
    pub fn new(
        handle: String,
        interval_ms: i32,
        callback: Function<WallpaperOcclusion, UnknownReturnValue>,
    ) -> napi::Result<Self> {
        let child = parse_handle(&handle)?.0 as usize;
        let callback: Callback = callback
            .build_threadsafe_function::<WallpaperOcclusion>()
            .build_callback(|ctx| Ok(ctx.value))?;
        let stopped = Arc::new(AtomicBool::new(false));
        let interval = Arc::new(AtomicI32::new(interval_ms.clamp(120, 5000)));
        let (flag, tick) = (stopped.clone(), interval.clone());
        thread::Builder::new()
            .name("echo-wallpaper-occlusion".into())
            .spawn(move || run(child, flag, tick, callback))
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(Self {
            stopped,
            interval,
            child,
        })
    }

    /// 调整采样间隔（毫秒）。
    #[napi]
    pub fn set_interval(&self, interval_ms: i32) {
        self.interval
            .store(interval_ms.clamp(120, 5000), Ordering::Release);
    }

    #[napi]
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    /// 壁纸窗口句柄（十进制字符串），便于日志与调试。
    #[napi(getter)]
    pub fn handle(&self) -> String {
        self.child.to_string()
    }
}



