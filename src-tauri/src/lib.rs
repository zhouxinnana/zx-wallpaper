mod domain;
mod online;
mod runtime;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let runtime =
                runtime::RuntimeState::load(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(runtime);
            runtime::synchronize_system_integration(&app.handle())
                .map_err(std::io::Error::other)?;
            runtime::start_background_tasks(app.handle().clone());
            runtime::start_directory_watcher(app.handle().clone());
            setup_tray(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime::get_state,
            runtime::add_folder,
            runtime::update_folder,
            runtime::remove_folder,
            runtime::open_folder,
            runtime::rescan_folders,
            runtime::next_wallpaper,
            runtime::select_wallpaper,
            runtime::skip_current_wallpaper,
            runtime::restore_skipped,
            runtime::restore_all_skipped,
            runtime::delete_skipped,
            runtime::toggle_paused,
            runtime::update_preferences,
            runtime::add_online_source,
            runtime::update_online_source,
            runtime::remove_online_source,
            runtime::run_online_source,
            runtime::set_online_image_as_wallpaper,
            runtime::delete_online_image,
            runtime::select_online_directory,
            runtime::reveal_online_image,
            runtime::get_online_thumbnail,
            runtime::get_preview_thumbnail,
            runtime::prewarm_online_thumbnails,
            runtime::get_skipped_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ZX Wallpaper");
}

#[cfg(feature = "desktop")]
fn setup_tray(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let show_window = MenuItemBuilder::with_id("tray-show", "显示主窗口").build(app)?;
    let next_wallpaper = MenuItemBuilder::with_id("tray-next", "切换下一张").build(app)?;
    let toggle_paused = MenuItemBuilder::with_id("tray-pause", "暂停 / 恢复自动切换").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "退出 ZX Wallpaper").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_window)
        .item(&next_wallpaper)
        .item(&toggle_paused)
        .separator()
        .item(&quit)
        .build()?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("application icon is required");

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("ZX Wallpaper")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-next" => runtime::trigger_next_wallpaper(app),
            "tray-pause" => runtime::toggle_paused_from_system(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(feature = "desktop")]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
