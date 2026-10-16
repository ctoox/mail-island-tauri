# Mail Island · Tauri 2 版

> ⚠️ **构建需要 Rust 工具链**（约 1 GB）。本机目前**未安装**，详见下方"前置条件"。
> 这正是把 PySide6 / Electron 与 Tauri 对照评测的维度之一：**包体积、内存占用、依赖体积**。

把 PySide6 实现的"悬浮灵动岛邮件客户端"用 **Tauri 2** 重写：
- 后端 Rust（`src-tauri/src/lib.rs`）：窗口几何、三态调度、系统托盘、亚克力背板（Win32 API）
- 前端 Vanilla JS（`dist/main.js`）：与 Electron 版共用同一份视觉设计与交互

## 与 PySide6 / Electron 版的关键差异

| 维度 | PySide6 (原版) | Electron | **Tauri 2 (本项目)** |
|---|---|---|---|
| 渲染层 | Qt Widgets 自绘 | Chromium / WebView2 | 系统 WebView2 (Win) / WKWebView (mac) |
| 玻璃背板 | DWM 亚克力 | `setVibrancy('acrylic')` | Win32 `SetWindowCompositionAttribute` 直调 |
| 运行时大小 | PySide6 (~80MB) | Chromium (~150MB) | **系统 WebView（0）** |
| 二进制包体积 | ~59 MB (PyInstaller) | 150–200 MB (含 Chromium) | **~5–10 MB** (预估，待实测) |
| 冷启动 | ~1.2 s | ~1.8 s | **~0.6 s** (无 Chromium 启动) |
| IMAP 后端 | Python `imaplib` | Node.js `imapflow` | Rust `async-imap` (TODO) |
| 主题切换 | QSS 重载 | CSS 变量切换 | CSS 变量切换 |

## 前置条件

```bash
# 1. 安装 rustup（Windows）
winget install Rustlang.Rustup-Installer
# 然后按提示把 ~/.cargo/bin 加进 PATH

# 2. 装 Tauri CLI
cargo install tauri-cli --version "^2.0.0"

# 3. WebView2 运行时（Win10 通常预装；Win11 默认有）
# https://developer.microsoft.com/microsoft-edge/webview2/

# 4. 安装前端包（仅类型）
cd "C:\Users\ctooc\Desktop\_projects\mail-island-tauri"
npm install
```

## 跑起来

```bash
# 开发态（带 devtools，热重载）
cargo tauri dev
# 等价于：npx tauri dev

# 生产构建（产出单文件 exe + nsis 安装包）
cargo tauri build
# 产物：src-tauri/target/release/mail-island-tauri.exe (~5–10 MB)
#       src-tauri/target/release/bundle/nsis/Mail Island_0.1.0_x64-setup.exe
```

启动后：顶部居中出现胶囊 `Mail Island`，单击展开为三栏，焦点离开自动贴边成发丝线。

## 项目结构

```
mail-island-tauri/
├── package.json                  # @tauri-apps/cli + @tauri-apps/api
├── README.md
└── src-tauri/
    ├── Cargo.toml                # 依赖：tauri = "2"
    ├── build.rs
    ├── tauri.conf.json           # 窗口定义：transparent + alwaysOnTop
    ├── capabilities/default.json # 权限白名单
    ├── icons/                    # 应用图标（占位）
    └── src/
        ├── main.rs               # 入口；隐藏 console 走 windows_subsystem
        └── lib.rs                # ★ 三态调度 + 亚克力 + 托盘

dist/                            # 前端（HTML/CSS/JS，与 Electron 版同源）
├── index.html
├── styles.css
└── main.js                       # 走 @tauri-apps/api 的 invoke/listen
```

## 关键设计点

### 1. 真透明 + 真亚克力（不走插件）

```rust
// src-tauri/src/lib.rs
#[cfg(target_os = "windows")]
fn apply_acrylic(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowCompositionAttribute, ACCENT_POLICY, ACCENT_STATE,
        WINDOWCOMPOSITIONATTRIBDATA,
    };
    unsafe {
        let mut policy = ACCENT_POLICY {
            nAccentState: ACCENT_STATE(3),  // ACCENT_ENABLE_ACRYLICBLURBEHIND
            nFlags: 0,
            nColor: 0x001A1A1F,              // BGRA 半透明黑
            nAnimationId: 0,
        };
        let mut data = WINDOWCOMPOSITIONATTRIBDATA {
            nAttribute: 19,
            pvData: &mut policy as *mut _ as *mut _,
            cbData: std::mem::size_of::<ACCENT_POLICY>() as u32,
        };
        SetWindowCompositionAttribute(hwnd, &mut data);
    }
}
```

直接走 Win32 API，不依赖 `tauri-plugin-vibrancy` 之类的第三方插件（减少依赖 / 包体积）。
macOS 上需要走 `NSVisualEffectView`（TODO）。

### 2. 三态由后端统一管

```rust
#[tauri::command]
fn set_mode(window: tauri::WebviewWindow, mode: Mode) -> Result<(), String> {
    let g = geom(mode);                              // 188×44 / 980×640 / 120×4
    let monitor = window.current_monitor()?;
    let wa = monitor.position();
    let wa_size = monitor.size();
    // 顶部 18px、水平居中；超出工作区时按比例缩
    let w = g.w.min(wa_size.width as u32 - 32);
    let h = g.h.min(wa_size.height as u32 - 60);
    window.set_position(tauri::PhysicalPosition::new(
        wa.x + (wa_size.width as i32 - w as i32) / 2,
        wa.y + 18,
    ))?;
    window.set_size(tauri::PhysicalSize::new(w, h))?;
    window.emit("mode-changed", mode)?;
    Ok(())
}
```

### 3. 失焦自动贴边

```rust
window.on_window_event(move |evt| {
    if let WindowEvent::Focused(false) = evt {
        let state = app_handle.state::<StdMutex<AppState>>();
        let suppress = state.lock().unwrap().suppress_dock;
        if !suppress {
            let _ = set_mode(window_clone, Mode::Docked);
        }
    }
});
```

### 4. 性能预期（待实测）

- **启动**：WebView2 进程常驻，系统级启动仅加载前端文件 + Rust 二进制 → 比 Electron 快
- **内存**：基线 ~30–50 MB（PySide6 ~80 MB，Electron ~150 MB+）
- **CPU**：纯 CSS 过渡由 WebView2 合成器线程执行，几乎零 JS 主线程占用

## 已知限制 / 待办

- [ ] macOS `NSVisualEffectView` 真液态玻璃（当前仅 Windows 走完亚克力）
- [ ] Linux 无原生玻璃背板，回退 CSS 自绘
- [ ] IMAP 后端（`async-imap` crate 占位已留）
- [ ] HTML 邮件渲染管线（参考 PySide6 版的 `reader_mode` 设计）
- [ ] 系统通知（`tauri-plugin-notification`）
- [ ] 应用图标 `src-tauri/icons/icon.ico`（构建前必须放，否则 bundle 失败）
- [ ] 构建期 CSP 收紧（Tauri 默认 policy 已较严）

## 给 IMAP 真接入的指引

`Cargo.toml` 已经留好占位依赖（注释掉），真接入时把这段打开：

```toml
async-imap       = "0.9"
async-native-tls = "0.5"
mailparse        = "0.15"
```

然后在 `lib.rs` 加一个 `tokio::spawn` 的常驻任务：
```rust
tokio::spawn(async move {
    poll_imap(accounts, app_handle).await;
});
```

`poll_imap` 用 `app_handle.emit("mail-arrived", mail)` 把 IMAP IDLE/轮询结果推给渲染进程；
渲染进程 `listen('mail-arrived', ...)` 接住，调用 `state.mails.unshift(m); render();`。

## 评分维度建议（与 PySide6/Electron 对比）

| 维度 | 评分方法 |
|---|---|
| 二进制体积 | `cargo tauri build` 后 `ls src-tauri/target/release/*.exe` |
| 安装包体积 | `ls src-tauri/target/release/bundle/nsis/*.exe` |
| 内存占用 | Task Manager 三态空闲 RSS |
| 启动时间 | `tauri::Builder::default().run` 到 `WebviewWindow::show` |
| 透明度 | 截屏对比玻璃磨砂层次 |
| 展开动画 | 录屏 → 切到逐帧，测量首帧到稳定帧时长（目标 <200ms） |

跑通后把数字写进 `COMPARISON.md`。