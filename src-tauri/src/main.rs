// main.rs — Tauri 入口（仅启动 lib）
// 防卡死：windows_subsystem 隐藏控制台（与 mail-island.exe 同效）

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mail_island_tauri_lib::run()
}