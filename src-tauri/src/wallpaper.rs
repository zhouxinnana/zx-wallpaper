use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, State};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

use crate::domain::{is_supported_wallpaper, same_path, take_next_path};
use crate::online::now_rfc3339;
use crate::preferences::normalize_rotation_order;
use crate::library::rescan_config;
use crate::state::{
    lock_config, lock_registered_shortcut, lock_registered_skip_shortcut, lock_shortcut_status,
    lock_skip_shortcut_status, mutate, mutate_with_cached_scan, mutate_without_rescan,
    AppConfig, AppState, ConfigPatch, RuntimeState, ShortcutStatus,
};
use crate::system::{
    replace_global_shortcut, skip_current_wallpaper_from_system, synchronize_autostart,
    trigger_next_wallpaper,
};

const WALLPAPER_HISTORY_LIMIT: usize = 20;

pub(crate) fn is_switch_due(config: &AppConfig, now: OffsetDateTime) -> bool {
    if config.paused {
        return false;
    }
    let Some(last_switch_at) = config.last_switch_at.as_deref() else {
        return true;
    };
    OffsetDateTime::parse(last_switch_at, &Rfc3339)
        .map(|last_switch_at| {
            now - last_switch_at >= Duration::minutes(i64::from(config.interval_minutes))
        })
        .unwrap_or(true)
}

#[tauri::command]
pub async fn delete_current_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    let current = lock_config(&state)?
        .current_path
        .clone()
        .ok_or_else(|| "当前没有壁纸。".to_string())?;
    let path_to_delete = current.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if Path::new(&path_to_delete).exists() {
            trash::delete(&path_to_delete)
                .map_err(|error| std::io::Error::other(error.to_string()))
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|error| format!("删除壁纸任务中断: {error}"))?
    .map_err(|error| format!("无法删除当前壁纸: {error}"))?;
    state.image_assets.purge_source(&current);
    mutate(&app, &state, move |config| {
        config
            .favorite_paths
            .retain(|path| !same_path(path, &current));
        config
            .skipped_paths
            .retain(|path| !same_path(path, &current));
        if config
            .current_path
            .as_deref()
            .is_some_and(|path| same_path(path, &current))
        {
            config.current_path = None;
            let _ = switch_to_next_wallpaper(config);
        }
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub fn next_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    reason: Option<String>,
) -> Result<AppState, String> {
    let _ = reason;
    mutate_with_cached_scan(&app, &state, |config| switch_to_next_wallpaper(config))
}

#[tauri::command]
pub fn select_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    file_path: String,
) -> Result<AppState, String> {
    mutate_with_cached_scan(&app, &state, move |config| {
        select_wallpaper_path(config, &file_path)
    })
}

#[tauri::command]
pub fn skip_current_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    mutate_with_cached_scan(&app, &state, skip_current_wallpaper_config)
}

#[tauri::command]
pub fn toggle_favorite(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    file_path: String,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        toggle_favorite_path(config, &file_path)
    })
}

#[tauri::command]
pub fn restore_skipped(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    file_path: String,
) -> Result<AppState, String> {
    mutate(&app, &state, move |config| {
        config
            .skipped_paths
            .retain(|path| !same_path(path, &file_path));
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub fn restore_all_skipped(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    mutate(&app, &state, |config| {
        config.skipped_paths.clear();
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub fn delete_skipped(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    file_path: String,
) -> Result<AppState, String> {
    let delete_path = file_path.clone();
    let snapshot = mutate(&app, &state, move |config| {
        delete_skipped_file(config, &file_path)
    })?;
    state.image_assets.purge_source(&delete_path);
    Ok(snapshot)
}

#[tauri::command]
pub fn delete_all_skipped(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    let paths = lock_config(&state)?.skipped_paths.clone();
    let snapshot = mutate(&app, &state, |config| delete_all_skipped_files(config))?;
    for path in paths {
        state.image_assets.purge_source(&path);
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn toggle_paused(app: AppHandle, state: State<'_, RuntimeState>) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, |config| {
        config.paused = !config.paused;
        Ok(())
    })
}

#[tauri::command]
pub fn update_preferences(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    mut patch: ConfigPatch,
) -> Result<AppState, String> {
    if let Some(auto_start) = patch.auto_start {
        synchronize_autostart(&app, auto_start)?;
    }
    if patch.global_next_shortcut.is_some() {
        let requested_shortcut = patch
            .global_next_shortcut
            .as_ref()
            .and_then(|shortcut| shortcut.as_deref())
            .map(str::trim)
            .filter(|shortcut| !shortcut.is_empty())
            .map(str::to_string);
        let active_shortcut = lock_registered_shortcut(&state)?.clone();
        match replace_global_shortcut(
            &app,
            active_shortcut.as_deref(),
            requested_shortcut.as_deref(),
            trigger_next_wallpaper,
        ) {
            Ok((status, registered)) => {
                *lock_shortcut_status(&state)? = status;
                *lock_registered_shortcut(&state)? = registered;
                patch.global_next_shortcut = Some(requested_shortcut);
            }
            Err(message) => {
                *lock_shortcut_status(&state)? = ShortcutStatus::Error {
                    shortcut: requested_shortcut.unwrap_or_default(),
                    message,
                };
                patch.global_next_shortcut = None;
            }
        }
    }
    if patch.global_skip_shortcut.is_some() {
        let requested_shortcut = patch
            .global_skip_shortcut
            .as_ref()
            .and_then(|shortcut| shortcut.as_deref())
            .map(str::trim)
            .filter(|shortcut| !shortcut.is_empty())
            .map(str::to_string);
        let active_shortcut = lock_registered_skip_shortcut(&state)?.clone();
        match replace_global_shortcut(
            &app,
            active_shortcut.as_deref(),
            requested_shortcut.as_deref(),
            skip_current_wallpaper_from_system,
        ) {
            Ok((status, registered)) => {
                *lock_skip_shortcut_status(&state)? = status;
                *lock_registered_skip_shortcut(&state)? = registered;
                patch.global_skip_shortcut = Some(requested_shortcut);
            }
            Err(message) => {
                *lock_skip_shortcut_status(&state)? = ShortcutStatus::Error {
                    shortcut: requested_shortcut.unwrap_or_default(),
                    message,
                };
                patch.global_skip_shortcut = None;
            }
        }
    }
    let needs_library_rescan = patch.folders.is_some();
    let apply_patch = move |config: &mut AppConfig| {
        if let Some(folders) = patch.folders {
            config.folders = folders;
        }
        if let Some(interval_minutes) = patch.interval_minutes {
            config.interval_minutes = interval_minutes.max(1);
        }
        if let Some(display_mode) = patch.display_mode {
            config.display_mode = display_mode;
            if let Some(current_path) = config.current_path.clone() {
                set_desktop_wallpaper(Path::new(&current_path), &config.display_mode)?;
            }
        }
        if let Some(rotation_order) = patch.rotation_order {
            config.rotation_order = normalize_rotation_order(&rotation_order).to_string();
            config.remaining_paths.clear();
        }
        if let Some(auto_start) = patch.auto_start {
            config.auto_start = auto_start;
        }
        if let Some(paused) = patch.paused {
            config.paused = paused;
        }
        if let Some(follow_system_theme) = patch.follow_system_theme {
            config.follow_system_theme = follow_system_theme;
        }
        if let Some(hide_to_tray_on_close) = patch.hide_to_tray_on_close {
            config.hide_to_tray_on_close = hide_to_tray_on_close;
        }
        if let Some(global_next_shortcut) = patch.global_next_shortcut {
            config.global_next_shortcut = global_next_shortcut;
        }
        if let Some(global_skip_shortcut) = patch.global_skip_shortcut {
            config.global_skip_shortcut = global_skip_shortcut;
        }
        if let Some(online_directory) = patch.online_directory {
            config.online_directory = online_directory;
        }
        if let Some(limit) = patch.online_storage_limit_gb {
            config.online_storage_limit_gb = limit;
        }
        if let Some(resolution) = patch.online_minimum_resolution {
            config.online_minimum_resolution = resolution;
        }
        Ok(())
    };
    if needs_library_rescan {
        mutate(&app, &state, move |config| {
            apply_patch(config)?;
            rescan_config(config);
            Ok(())
        })
    } else {
        mutate_with_cached_scan(&app, &state, apply_patch)
    }
}

#[tauri::command]
pub fn reveal_wallpaper(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_file() || !is_supported_wallpaper(path) {
        return Err("该壁纸已不存在或格式不受支持。".to_string());
    }
    Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开图片所在目录: {error}"))?;
    Ok(())
}

fn remove_file_to_trash(file_path: &str) -> std::io::Result<()> {
    trash::delete(file_path).map_err(|error| std::io::Error::other(error.to_string()))
}

fn delete_skipped_file(config: &mut AppConfig, file_path: &str) -> Result<(), String> {
    delete_skipped_file_with(config, file_path, remove_file_to_trash)
}

fn delete_skipped_file_with(
    config: &mut AppConfig,
    file_path: &str,
    remove_file: impl Fn(&str) -> std::io::Result<()>,
) -> Result<(), String> {
    if !config
        .skipped_paths
        .iter()
        .any(|path| same_path(path, file_path))
    {
        return Ok(());
    }
    if Path::new(file_path).exists() {
        if let Err(error) = remove_file(file_path) {
            return Err(format!("无法删除已跳过图片: {error}"));
        }
    }
    config
        .skipped_paths
        .retain(|path| !same_path(path, file_path));
    config
        .favorite_paths
        .retain(|path| !same_path(path, file_path));
    rescan_config(config);
    Ok(())
}

fn delete_all_skipped_files(config: &mut AppConfig) -> Result<(), String> {
    delete_all_skipped_files_with(config, remove_file_to_trash)
}

fn delete_all_skipped_files_with(
    config: &mut AppConfig,
    remove_file: impl Fn(&str) -> std::io::Result<()> + Copy,
) -> Result<(), String> {
    let paths = config.skipped_paths.clone();
    for path in paths {
        delete_skipped_file_with(config, &path, remove_file)?;
    }
    Ok(())
}

pub(crate) fn skip_current_wallpaper_config(config: &mut AppConfig) -> Result<(), String> {
    let current = config
        .current_path
        .clone()
        .ok_or_else(|| "There is no active wallpaper to skip.".to_string())?;
    if !config
        .skipped_paths
        .iter()
        .any(|path| same_path(path, &current))
    {
        config.skipped_paths.push(current);
    }
    switch_to_next_wallpaper(config)
}

fn toggle_favorite_path(config: &mut AppConfig, file_path: &str) -> Result<(), String> {
    let path = Path::new(file_path);
    if !path.is_file() || !is_supported_wallpaper(path) {
        return Err("该壁纸已不存在或格式不受支持。".to_string());
    }

    if config
        .favorite_paths
        .iter()
        .any(|favorite| same_path(favorite, file_path))
    {
        config
            .favorite_paths
            .retain(|favorite| !same_path(favorite, file_path));
    } else {
        config.favorite_paths.push(file_path.to_string());
    }
    Ok(())
}

pub(crate) fn record_wallpaper_history(config: &mut AppConfig) {
    let Some(previous) = config.current_path.clone() else {
        return;
    };
    if config
        .wallpaper_history
        .first()
        .is_some_and(|path| same_path(path, &previous))
    {
        return;
    }
    config
        .wallpaper_history
        .retain(|path| !same_path(path, &previous));
    config.wallpaper_history.insert(0, previous);
    config.wallpaper_history.truncate(WALLPAPER_HISTORY_LIMIT);
}

fn select_wallpaper_path(config: &mut AppConfig, file_path: &str) -> Result<(), String> {
    if config
        .skipped_paths
        .iter()
        .any(|path| same_path(path, file_path))
    {
        return Err("已跳过的图片不能设为当前壁纸。".to_string());
    }

    let selected_path = if config
        .current_path
        .as_deref()
        .is_some_and(|path| same_path(path, file_path))
    {
        config.current_path.clone()
    } else {
        config
            .remaining_paths
            .iter()
            .find(|path| same_path(path, file_path))
            .cloned()
            .or_else(|| {
                let path = Path::new(file_path);
                (path.is_file() && is_supported_wallpaper(path)).then(|| file_path.to_string())
            })
    }
    .ok_or_else(|| "该预览图片已不在可切换队列中。".to_string())?;

    if config
        .current_path
        .as_deref()
        .is_some_and(|path| same_path(path, &selected_path))
    {
        return Ok(());
    }

    set_desktop_wallpaper(Path::new(&selected_path), &config.display_mode)?;
    record_wallpaper_history(config);
    config.current_path = Some(selected_path.clone());
    config
        .remaining_paths
        .retain(|path| !same_path(path, &selected_path));
    config.last_switch_at = Some(now_rfc3339());
    Ok(())
}

pub(crate) fn switch_to_next_wallpaper(config: &mut AppConfig) -> Result<(), String> {
    let Some((next_path, remaining_paths)) = take_next_path(
        &config.remaining_paths,
        &config.skipped_paths,
        config.current_path.as_deref(),
    ) else {
        return Err("No eligible wallpaper was found in the selected folders.".to_string());
    };

    set_desktop_wallpaper(Path::new(&next_path), &config.display_mode)?;
    record_wallpaper_history(config);
    config.current_path = Some(next_path);
    config.remaining_paths = remaining_paths;
    config.last_switch_at = Some(now_rfc3339());
    Ok(())
}

fn wallpaper_style_values(mode: &str) -> Option<(&'static str, &'static str)> {
    match mode {
        "fill" => Some(("10", "0")),
        "fit" => Some(("6", "0")),
        "stretch" => Some(("2", "0")),
        "tile" => Some(("0", "1")),
        "center" => Some(("0", "0")),
        "span" => Some(("22", "0")),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn set_desktop_wallpaper(path: &Path, display_mode: &str) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};

    const SPI_SETDESKWALLPAPER: u32 = 0x0014;
    const SPIF_UPDATEINIFILE: u32 = 0x0001;
    const SPIF_SENDCHANGE: u32 = 0x0002;

    set_wallpaper_display_mode(display_mode)?;

    #[link(name = "user32")]
    extern "system" {
        fn SystemParametersInfoW(
            ui_action: u32,
            ui_param: u32,
            pv_param: *mut c_void,
            f_win_ini: u32,
        ) -> i32;
    }

    let mut path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            path.as_mut_ptr().cast(),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    };

    if result == 0 {
        return Err(format!(
            "Windows rejected the wallpaper change: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_wallpaper_display_mode(display_mode: &str) -> Result<(), String> {
    let (wallpaper_style, tile_wallpaper) =
        wallpaper_style_values(display_mode).ok_or_else(|| "不支持的壁纸显示方式。".to_string())?;
    set_desktop_registry_string("WallpaperStyle", wallpaper_style)?;
    set_desktop_registry_string("TileWallpaper", tile_wallpaper)
}

#[cfg(target_os = "windows")]
fn set_desktop_registry_string(value_name: &str, value: &str) -> Result<(), String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

    type Hkey = isize;
    const HKEY_CURRENT_USER: Hkey = 0x8000_0001u32 as Hkey;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            h_key: Hkey,
            sub_key: *const u16,
            options: u32,
            desired_access: u32,
            result: *mut Hkey,
        ) -> i32;
        fn RegSetValueExW(
            h_key: Hkey,
            value_name: *const u16,
            reserved: u32,
            value_type: u32,
            data: *const u8,
            data_size: u32,
        ) -> i32;
        fn RegCloseKey(h_key: Hkey) -> i32;
    }

    let to_wide =
        |text: &str| -> Vec<u16> { OsStr::new(text).encode_wide().chain(Some(0)).collect() };
    let desktop_key = to_wide("Control Panel\\Desktop");
    let value_name = to_wide(value_name);
    let value = to_wide(value);
    let mut key = 0;
    let open_status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            desktop_key.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if open_status != 0 {
        return Err(format!("无法打开 Windows 桌面设置 ({open_status})。"));
    }
    let set_status = unsafe {
        RegSetValueExW(
            key,
            value_name.as_ptr(),
            0,
            REG_SZ,
            value.as_ptr().cast(),
            (value.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    unsafe { RegCloseKey(key) };
    if set_status != 0 {
        return Err(format!("无法保存 Windows 壁纸显示方式 ({set_status})。"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set_desktop_wallpaper(_path: &Path, _display_mode: &str) -> Result<(), String> {
    Err("Wallpaper switching is only available on Windows.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{delete_all_skipped_files_with, delete_skipped_file, delete_skipped_file_with, is_switch_due, record_wallpaper_history, toggle_favorite_path, wallpaper_style_values, WALLPAPER_HISTORY_LIMIT};
    use crate::state::AppConfig;
    use std::fs;
    use std::path::Path;
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn favorite_paths_are_deduplicated_and_toggle_by_normalized_path() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-favorite-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("favorite.jpg");
        fs::write(&path, b"wallpaper").unwrap();
        let path = path.to_string_lossy().into_owned();
        let mut config = AppConfig::default();

        toggle_favorite_path(&mut config, &path).unwrap();
        assert_eq!(config.favorite_paths, vec![path.clone()]);

        config.favorite_paths[0] = path.replace('\\', "/");
        toggle_favorite_path(&mut config, &path).unwrap();
        assert!(config.favorite_paths.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn deletes_only_a_registered_skipped_file_and_removes_its_record() {
        let path = std::env::temp_dir().join(format!("zx-wallpaper-{}.jpg", Uuid::new_v4()));
        fs::write(&path, b"test wallpaper").unwrap();
        let path = path.to_string_lossy().into_owned();
        let mut config = AppConfig {
            skipped_paths: vec![path.clone()],
            ..AppConfig::default()
        };

        delete_skipped_file_with(&mut config, &path, |path| fs::remove_file(path)).unwrap();

        assert!(!Path::new(&path).exists());
        assert!(config.skipped_paths.is_empty());
    }

    #[test]
    fn deletes_all_skipped_files_and_removes_their_records() {
        let paths = [
            std::env::temp_dir().join(format!("zx-wallpaper-{}.jpg", Uuid::new_v4())),
            std::env::temp_dir().join(format!("zx-wallpaper-{}.jpg", Uuid::new_v4())),
        ];
        for path in &paths {
            fs::write(path, b"test wallpaper").unwrap();
        }
        let paths = paths.map(|path| path.to_string_lossy().into_owned());
        let mut config = AppConfig {
            skipped_paths: paths.to_vec(),
            favorite_paths: paths.to_vec(),
            ..AppConfig::default()
        };

        delete_all_skipped_files_with(&mut config, |path| fs::remove_file(path)).unwrap();

        assert!(paths.iter().all(|path| !Path::new(path).exists()));
        assert!(config.skipped_paths.is_empty());
        assert!(config.favorite_paths.is_empty());
    }

    #[test]
    fn missing_skipped_files_are_removed_from_records_without_trash_roundtrip() {
        let path = std::env::temp_dir()
            .join(format!("zx-wallpaper-missing-{}.jpg", Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let mut config = AppConfig {
            skipped_paths: vec![path.clone()],
            ..AppConfig::default()
        };

        delete_skipped_file(&mut config, &path).unwrap();

        assert!(config.skipped_paths.is_empty());
    }

    #[test]
    fn wallpaper_history_records_previous_wallpapers_in_order() {
        let mut config = AppConfig {
            current_path: Some("D:\\Wallpapers\\a.jpg".into()),
            ..AppConfig::default()
        };

        record_wallpaper_history(&mut config);
        config.current_path = Some("D:\\Wallpapers\\b.jpg".into());
        record_wallpaper_history(&mut config);
        config.current_path = Some("D:\\Wallpapers\\c.jpg".into());

        assert_eq!(
            config.wallpaper_history,
            vec!["D:\\Wallpapers\\b.jpg", "D:\\Wallpapers\\a.jpg"]
        );
    }

    #[test]
    fn wallpaper_history_deduplicates_and_caps_at_limit() {
        let mut config = AppConfig::default();

        for index in 0..25 {
            config.current_path = Some(format!("D:\\Wallpapers\\{index}.jpg"));
            record_wallpaper_history(&mut config);
        }

        assert_eq!(config.wallpaper_history.len(), WALLPAPER_HISTORY_LIMIT);
        assert_eq!(
            config.wallpaper_history.first().map(String::as_str),
            Some("D:\\Wallpapers\\24.jpg")
        );
        assert_eq!(
            config.wallpaper_history.last().map(String::as_str),
            Some("D:\\Wallpapers\\5.jpg")
        );
    }

    #[test]
    fn maps_each_supported_display_mode_to_its_windows_style_values() {
        assert_eq!(wallpaper_style_values("fill"), Some(("10", "0")));
        assert_eq!(wallpaper_style_values("fit"), Some(("6", "0")));
        assert_eq!(wallpaper_style_values("stretch"), Some(("2", "0")));
        assert_eq!(wallpaper_style_values("tile"), Some(("0", "1")));
        assert_eq!(wallpaper_style_values("center"), Some(("0", "0")));
        assert_eq!(wallpaper_style_values("span"), Some(("22", "0")));
        assert_eq!(wallpaper_style_values("unsupported"), None);
    }

    #[test]
    fn schedules_switching_only_when_the_interval_has_elapsed_and_not_paused() {
        let now = OffsetDateTime::parse("2026-08-07T10:30:00Z", &Rfc3339).unwrap();
        let mut config = AppConfig {
            interval_minutes: 30,
            current_path: Some("D:\\Wallpapers\\current.jpg".into()),
            last_switch_at: Some("2026-08-07T10:00:00Z".into()),
            ..AppConfig::default()
        };

        assert!(is_switch_due(&config, now));
        config.paused = true;
        assert!(!is_switch_due(&config, now));
        config.paused = false;
        config.last_switch_at = Some("2026-08-07T10:05:00Z".into());
        assert!(!is_switch_due(&config, now));
    }
}
