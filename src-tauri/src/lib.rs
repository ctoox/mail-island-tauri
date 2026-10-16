//! lib.rs — Mail Island (Tauri 2) 核心逻辑
//!
//! 目标：用 Tauri 2 重写 mail-island 的"悬浮岛 + 三态"骨架。
//!
//! 关键设计（与 PySide6/Electron 版对齐）：
//! - 单一 WebviewWindow，title='Mail Island'
//! - decorations=false + transparent=true + alwaysOnTop=true
//! - 三态由 set_mode() 统一管：capsule(188x44) / expanded(980x640) / docked(120x4)
//! - 位置计算 = 当前主显示器 workArea 顶部居中
//! - 焦点失焦自动 docked（除非前端通过 suppress_dock 抑制）
//! - 系统托盘：菜单切换模式 / 退出
//! - 真亚克力：Windows 上直接调 SetWindowCompositionAttribute（acrylic），
//!   不依赖第三方 vibrancy 插件；macOS 上用 NSVisualEffectView（TODO）

use serde::{Deserialize, Serialize};
use std::sync::Mutex as StdMutex;
use tauri::{
    image::Image as TauriImageReal,
    Emitter as _, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_shell::ShellExt;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};

// ─── 三态几何 ────────────────────────────────────────────
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Capsule,
    Expanded,
    Docked,
}

#[derive(Debug, Clone, Copy)]
struct Size { w: u32, h: u32 }

const GEOM: &[(&str, Size)] = &[
    ("capsule",  Size { w: 188, h: 44 }),
    ("expanded", Size { w: 980, h: 640 }),
    ("docked",   Size { w: 120, h: 4 }),
];

fn geom(mode: Mode) -> Size {
    let key = match mode {
        Mode::Capsule => "capsule",
        Mode::Expanded => "expanded",
        Mode::Docked => "docked",
    };
    GEOM.iter().find(|(k, _)| *k == key).unwrap().1
}

// ─── 状态：suppress_dock 标志 ────────────────────────────
#[derive(Default)]
struct AppState {
    suppress_dock: bool,
}

#[tauri::command]
fn set_mode(window: tauri::WebviewWindow, mode: Mode) -> Result<(), String> {
    let g = geom(mode);
    // 取主显示器 workArea（顶部 18px 留呼吸）
    let monitor = window.current_monitor().map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let wa = monitor.position();
    let wa_size = monitor.size();

    // 等比缩放到能塞进工作区
    let max_w = (wa_size.width as i32 - 32).max(g.w as i32);
    let max_h = (wa_size.height as i32 - 60).max(g.h as i32);
    let w = g.w.min(max_w as u32);
    let h = g.h.min(max_h as u32);

    let x = wa.x + (wa_size.width as i32 - w as i32) / 2;
    let y = wa.y + 18;

    window.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    window.set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    window.emit("mode-changed", mode).ok();
    Ok(())
}

#[tauri::command]
fn suppress_dock(state: tauri::State<StdMutex<AppState>>, flag: bool) {
    state.lock().unwrap().suppress_dock = flag;
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.shell().open(&url, None).map_err(|e| e.to_string())
}

// ─── Windows 亚克力（直接走 Win32 API，避免插件膨胀）───────
#[cfg(target_os = "windows")]
fn apply_acrylic(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowCompositionAttribute, ACCENT_POLICY, ACCENT_STATE, WINDOWCOMPOSITIONATTRIBDATA,
    };
    unsafe {
        let mut policy = ACCENT_POLICY {
            nAccentState: ACCENT_STATE(3), // ACCENT_ENABLE_ACRYLICBLURBEHIND
            nFlags: 0,
            nColor: 0x001A1A1F, // BGRA 半透明黑
            nAnimationId: 0,
        };
        let mut data = WINDOWCOMPOSITIONATTRIBDATA {
            nAttribute: 19, // WCA_ACCENT_POLICY
            pvData: &mut policy as *mut _ as *mut _,
            cbData: std::mem::size_of::<ACCENT_POLICY>() as u32,
        };
        SetWindowCompositionAttribute(hwnd, &mut data);
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_acrylic(_hwnd: isize) { /* macOS 用 NSVisualEffectView；Linux 无对应 API */ }

// ─── Run ──────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(StdMutex::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![set_mode, suppress_dock, open_external])
        .setup(|app| {
            // 主窗口
            let window = app.get_webview_window("island").expect("island window");

            // 启动后应用亚克力（Windows 10/11）
            #[cfg(target_os = "windows")]
            {
                if let Ok(hwnd) = window.hwnd() {
                    apply_acrylic(hwnd.0 as isize);
                }
            }

            // 失焦自动 docked
            let app_handle = app.handle().clone();
            window.on_window_event(move |evt| {
                if let WindowEvent::Focused(false) = evt {
                    let state = app_handle.state::<StdMutex<AppState>>();
                    let suppress = state.lock().unwrap().suppress_dock;
                    if !suppress {
                        if let Some(w) = app_handle.get_webview_window("island") {
                            let _ = set_mode(w, Mode::Docked);
                        }
                    }
                }
            });

            // 系统托盘
            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "show", "显示 / 隐藏 岛", true, None::<&str>)?,
                &MenuItem::with_id(app, "mode_capsule",  "胶囊态", true, None::<&str>)?,
                &MenuItem::with_id(app, "mode_expanded", "展开态", true, None::<&str>)?,
                &MenuItem::with_id(app, "mode_docked",   "贴边态", true, None::<&str>)?,
                &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
            ])?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                    TauriImageReal::from_bytes(include_bytes!("../icons/tray.png"))
                        .expect("tray icon")
                }))
                .tooltip("Mail Island (Tauri)")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let w = app.get_webview_window("island");
                    match event.id.as_ref() {
                        "show" => { if let Some(w) = w { let _ = w.show(); let _ = w.set_focus(); } }
                        "mode_capsule"  => { if let Some(w) = w.clone() { let _ = set_mode(w, Mode::Capsule); } }
                        "mode_expanded" => { if let Some(w) = w.clone() { let _ = set_mode(w, Mode::Expanded); } }
                        "mode_docked"   => { if let Some(w) = w.clone() { let _ = set_mode(w, Mode::Docked); } }
                        "quit"          => { app.exit(0); }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("island") {
                            let _ = set_mode(w, Mode::Capsule);
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 最后一个窗口关闭时阻止退出（与 PySide6 行为对齐）
            if let RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}