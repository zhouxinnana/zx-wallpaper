mod domain;
mod image_assets;
mod library;
mod online;
mod preferences;
mod state;
mod system;
mod wallpaper;
mod widget;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol(image_assets::PROTOCOL_NAME, |context, request| {
            let state = context.app_handle().state::<state::RuntimeState>();
            library::serve_image_asset(&state, request.uri().path())
        })
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let runtime =
                state::RuntimeState::load(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(runtime);
            system::synchronize_system_integration(&app.handle())
                .map_err(std::io::Error::other)?;
            system::start_background_tasks(app.handle().clone());
            system::start_directory_watcher(app.handle().clone());
            widget::position_floating_widget(&app.handle(), false);
            setup_tray(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if system::hide_to_tray_on_close(window.app_handle()) {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            state::get_state,
            library::add_folder,
            library::update_folder,
            library::remove_folder,
            library::open_folder,
            library::rescan_folders,
            wallpaper::next_wallpaper,
            wallpaper::select_wallpaper,
            wallpaper::skip_current_wallpaper,
            wallpaper::toggle_favorite,
            wallpaper::restore_skipped,
            wallpaper::restore_all_skipped,
            wallpaper::delete_skipped,
            wallpaper::delete_all_skipped,
            wallpaper::toggle_paused,
            wallpaper::update_preferences,
            online::update_online_source,
            online::run_online_source,
            online::run_upx8_category,
            online::set_online_image_as_wallpaper,
            online::delete_online_image,
            online::select_online_directory,
            online::reveal_online_image,
            wallpaper::reveal_wallpaper,
            library::get_image_asset,
            library::prewarm_image_assets,
            widget::widget_set_expanded,
            widget::widget_set_free_position,
            wallpaper::delete_current_wallpaper,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ZX Wallpaper");
}

#[cfg(feature = "desktop")]
fn setup_tray(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let show_window = MenuItemBuilder::with_id("tray-show", "显示主窗口").build(app)?;
    let next_wallpaper = MenuItemBuilder::with_id("tray-next", "切换下一张").build(app)?;
    let skip_current = MenuItemBuilder::with_id("tray-skip", "跳过此图").build(app)?;
    let toggle_paused = MenuItemBuilder::with_id("tray-pause", "暂停 / 恢复自动切换").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "退出 ZX Wallpaper").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_window)
        .item(&next_wallpaper)
        .item(&skip_current)
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
            "tray-next" => system::trigger_next_wallpaper(app),
            "tray-skip" => system::skip_current_wallpaper_from_system(app),
            "tray-pause" => system::toggle_paused_from_system(app),
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
