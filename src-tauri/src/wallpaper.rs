use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, State};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

use crate::domain::{is_supported_wallpaper, same_path, take_next_path};
use crate::online::{now_rfc3339, remember_excluded_urls};
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
/// 自动切换间隔允许的分钟范围，与前端 `INTERVAL_MINUTES` 保持一致（1 分钟 ~ 30 天）。
const MIN_INTERVAL_MINUTES: u32 = 1;
const MAX_INTERVAL_MINUTES: u32 = 43_200;

fn clamp_interval_minutes(minutes: u32) -> u32 {
    minutes.clamp(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)
}

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

// ---------------------------------------------------------------------------
// 批量治理命令（统一图库）
// ---------------------------------------------------------------------------

/// 批量跳过：把选中的图片并入跳过列表并移出切换队列；不碰磁盘，当前壁纸不动。
#[tauri::command]
pub fn batch_skip_paths(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    paths: Vec<String>,
) -> Result<AppState, String> {
    mutate_with_cached_scan(&app, &state, move |config| {
        batch_skip_paths_config(config, &paths);
        Ok(())
    })
}

/// 批量取消跳过：移出跳过列表，图片重新回到切换队列。
#[tauri::command]
pub fn batch_restore_skipped(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    paths: Vec<String>,
) -> Result<AppState, String> {
    mutate_with_cached_scan(&app, &state, move |config| {
        batch_restore_skipped_config(config, &paths);
        Ok(())
    })
}

/// 批量喜欢 / 取消喜欢。幂等：目标路径不存在时静默跳过，不报错。
#[tauri::command]
pub fn batch_favorite(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    paths: Vec<String>,
    favorite: bool,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        batch_favorite_config(config, &paths, favorite);
        Ok(())
    })
}

/// 批量删除：逐张移入系统回收站（不提供永久删除分支），
/// 并清理喜欢、跳过、历史与队列记录。删除集合含当前壁纸时自动切到下一张。
///
/// 部分失败语义：失败项收集后统一报错，但已成功的删除与记录清理仍然持久化。
#[tauri::command]
pub fn batch_delete_paths(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    paths: Vec<String>,
) -> Result<AppState, String> {
    let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let collected = failures.clone();
    let deleted_paths = paths.clone();
    let snapshot = mutate(&app, &state, move |config| {
        delete_batch_with(
            config,
            &paths,
            remove_file_to_trash,
            |config| switch_to_next_wallpaper(config),
            &collected,
        );
        Ok(())
    })?;

    for path in &deleted_paths {
        state.image_assets.purge_source(path);
    }

    let failures = failures.lock().map_err(|_| "无法读取删除结果。".to_string())?;
    if !failures.is_empty() {
        return Err(format!(
            "{} 张删除失败：{}",
            failures.len(),
            failures.first().cloned().unwrap_or_default()
        ));
    }
    Ok(snapshot)
}

/// 批量路径去重（按规范化路径），保留首次出现的顺序。
fn dedupe_batch_paths(paths: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths
        .iter()
        .filter(|path| {
            let key = path.replace('/', "\\").to_ascii_lowercase();
            !key.is_empty() && seen.insert(key)
        })
        .cloned()
        .collect()
}

pub(crate) fn batch_skip_paths_config(config: &mut AppConfig, paths: &[String]) {
    for path in dedupe_batch_paths(paths) {
        if !config
            .skipped_paths
            .iter()
            .any(|skipped| same_path(skipped, &path))
        {
            config.skipped_paths.push(path.clone());
        }
        config
            .remaining_paths
            .retain(|remaining| !same_path(remaining, &path));
    }
}

pub(crate) fn batch_restore_skipped_config(config: &mut AppConfig, paths: &[String]) {
    for path in dedupe_batch_paths(paths) {
        config
            .skipped_paths
            .retain(|skipped| !same_path(skipped, &path));
    }
}

pub(crate) fn batch_favorite_config(config: &mut AppConfig, paths: &[String], favorite: bool) {
    for path in dedupe_batch_paths(paths) {
        if favorite {
            let exists = Path::new(&path).is_file();
            if exists
                && !config
                    .favorite_paths
                    .iter()
                    .any(|existing| same_path(existing, &path))
            {
                config.favorite_paths.push(path);
            }
        } else {
            config
                .favorite_paths
                .retain(|existing| !same_path(existing, &path));
        }
    }
}

/// 批量删除的纯函数版本：注入删除实现与切换实现，便于单测。
/// 删除失败记入 `failures`，不中断其余项。
fn delete_batch_with(
    config: &mut AppConfig,
    paths: &[String],
    remove_file: impl Fn(&str) -> std::io::Result<()> + Copy,
    switch_next: impl Fn(&mut AppConfig) -> Result<(), String>,
    failures: &std::sync::Mutex<Vec<String>>,
) {
    let mut deleted = Vec::new();
    for path in dedupe_batch_paths(paths) {
        if Path::new(&path).exists() {
            if let Err(error) = remove_file(&path) {
                if let Ok(mut failures) = failures.lock() {
                    failures.push(format!("{path}（{error}）"));
                }
                continue;
            }
        }
        deleted.push(path);
    }

    for path in &deleted {
        // 删除即拉黑：先把该图对应的源 URL 记进排除列表，再移除记录。
        // 顺序不能反 —— 记录一旦移除就再也拿不到 image_url，同步会把这张图重新下回来。
        let excluded: Vec<String> = config
            .online_images
            .iter()
            .filter(|image| same_path(&image.local_path, path))
            .map(|image| image.image_url.clone())
            .collect();
        remember_excluded_urls(config, excluded);
        config
            .favorite_paths
            .retain(|favorite| !same_path(favorite, path));
        config
            .skipped_paths
            .retain(|skipped| !same_path(skipped, path));
        config
            .wallpaper_history
            .retain(|history| !same_path(history, path));
        config
            .remaining_paths
            .retain(|remaining| !same_path(remaining, path));
        // onlineImages 直接从 config 下发、不经过文件系统过滤，漏清会让已删除的在线图
        // 继续留在图库里，直到用户手动点「刷新」（rescan_folders 里才有 prune）。
        config
            .online_images
            .retain(|image| !same_path(&image.local_path, path));
    }

    let current_deleted = config
        .current_path
        .as_deref()
        .is_some_and(|current| deleted.iter().any(|path| same_path(current, path)));
    if current_deleted {
        config.current_path = None;
        // 队列为空时切换会失败，此时保持 current_path = None，由界面显示空态。
        let _ = switch_next(config);
    }
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
            config.interval_minutes = clamp_interval_minutes(interval_minutes);
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
    // 删除即拉黑：跳过列表里的在线图被删时同样要记住源 URL。
    let excluded: Vec<String> = config
        .online_images
        .iter()
        .filter(|image| same_path(&image.local_path, file_path))
        .map(|image| image.image_url.clone())
        .collect();
    remember_excluded_urls(config, excluded);
    config
        .skipped_paths
        .retain(|path| !same_path(path, file_path));
    config
        .favorite_paths
        .retain(|path| !same_path(path, file_path));
    config
        .online_images
        .retain(|image| !same_path(&image.local_path, file_path));
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
    use super::{
        batch_favorite_config, batch_restore_skipped_config, batch_skip_paths_config,
        clamp_interval_minutes, delete_all_skipped_files_with, delete_batch_with,
        delete_skipped_file, delete_skipped_file_with, is_switch_due, record_wallpaper_history,
        toggle_favorite_path, wallpaper_style_values, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES,
        WALLPAPER_HISTORY_LIMIT,
    };
    use crate::state::{AppConfig, OnlineImage};
    use std::fs;
    use std::path::Path;
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn clamps_manual_interval_to_supported_range() {
        assert_eq!(clamp_interval_minutes(0), MIN_INTERVAL_MINUTES);
        assert_eq!(clamp_interval_minutes(1), 1);
        assert_eq!(clamp_interval_minutes(90), 90);
        assert_eq!(clamp_interval_minutes(MAX_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
        assert_eq!(clamp_interval_minutes(u32::MAX), MAX_INTERVAL_MINUTES);
    }

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

    #[test]
    fn batch_skip_moves_paths_out_of_the_queue_and_records_them_once() {
        let mut config = AppConfig {
            remaining_paths: vec![
                "D:\\Wallpapers\\a.jpg".into(),
                "D:\\Wallpapers\\b.jpg".into(),
                "D:\\Wallpapers\\c.jpg".into(),
            ],
            ..AppConfig::default()
        };

        batch_skip_paths_config(
            &mut config,
            &[
                "D:\\Wallpapers\\a.jpg".into(),
                "D:\\Wallpapers\\b.jpg".into(),
                "d:\\wallpapers\\A.JPG".into(),
            ],
        );

        assert_eq!(config.skipped_paths.len(), 2);
        assert_eq!(config.remaining_paths, vec!["D:\\Wallpapers\\c.jpg"]);
    }

    #[test]
    fn batch_restore_skipped_returns_paths_to_the_queue() {
        let mut config = AppConfig {
            skipped_paths: vec![
                "D:\\Wallpapers\\a.jpg".into(),
                "D:\\Wallpapers\\b.jpg".into(),
            ],
            ..AppConfig::default()
        };

        batch_restore_skipped_config(&mut config, &["D:\\Wallpapers\\a.jpg".into()]);

        assert_eq!(config.skipped_paths, vec!["D:\\Wallpapers\\b.jpg"]);
    }

    #[test]
    fn batch_favorite_is_idempotent_and_tolerates_missing_paths() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-batch-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let existing = directory.join("favorite.jpg");
        fs::write(&existing, b"wallpaper").unwrap();
        let existing = existing.to_string_lossy().into_owned();
        let missing = directory.join("missing.jpg").to_string_lossy().into_owned();
        let mut config = AppConfig::default();

        batch_favorite_config(&mut config, &[existing.clone(), missing.clone()], true);
        batch_favorite_config(&mut config, &[existing.clone()], true);
        assert_eq!(config.favorite_paths, vec![existing.clone()]);

        batch_favorite_config(&mut config, &[existing.clone(), missing], false);
        assert!(config.favorite_paths.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_delete_removes_files_and_clears_their_records() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-batch-del-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let first = directory.join("first.jpg");
        let second = directory.join("second.jpg");
        fs::write(&first, b"wallpaper").unwrap();
        fs::write(&second, b"wallpaper").unwrap();
        let first = first.to_string_lossy().into_owned();
        let second = second.to_string_lossy().into_owned();
        let mut config = AppConfig {
            favorite_paths: vec![first.clone(), second.clone()],
            skipped_paths: vec![first.clone()],
            wallpaper_history: vec![second.clone()],
            remaining_paths: vec![first.clone(), second.clone()],
            ..AppConfig::default()
        };
        let failures = std::sync::Mutex::new(Vec::new());

        delete_batch_with(
            &mut config,
            &[first.clone(), second.clone()],
            |path| fs::remove_file(path),
            |_| Ok(()),
            &failures,
        );

        assert!(!Path::new(&first).exists());
        assert!(!Path::new(&second).exists());
        assert!(config.favorite_paths.is_empty());
        assert!(config.skipped_paths.is_empty());
        assert!(config.wallpaper_history.is_empty());
        assert!(config.remaining_paths.is_empty());
        assert!(failures.lock().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_delete_drops_online_image_records_so_the_gallery_stops_listing_them() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-batch-online-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let removed = directory.join("online-removed.jpg");
        let kept = directory.join("online-kept.jpg");
        fs::write(&removed, b"wallpaper").unwrap();
        fs::write(&kept, b"wallpaper").unwrap();
        let removed = removed.to_string_lossy().into_owned();
        let kept = kept.to_string_lossy().into_owned();
        let mut config = AppConfig {
            online_images: vec![
                OnlineImage {
                    local_path: removed.clone(),
                    image_url: "https://example.test/removed.jpg".into(),
                    ..OnlineImage::default()
                },
                OnlineImage {
                    local_path: kept.clone(),
                    ..OnlineImage::default()
                },
            ],
            ..AppConfig::default()
        };
        let failures = std::sync::Mutex::new(Vec::new());

        delete_batch_with(
            &mut config,
            &[removed.clone()],
            |path| fs::remove_file(path),
            |_| Ok(()),
            &failures,
        );

        // onlineImages 直接由 config 下发，不清记录会让已删除的在线图继续留在图库里。
        assert_eq!(config.online_images.len(), 1);
        assert_eq!(config.online_images[0].local_path, kept);
        // 删除即拉黑：源 URL 必须被记住，否则下一轮同步会把这张图重新下载回来。
        assert_eq!(
            config.excluded_image_urls,
            vec!["https://example.test/removed.jpg"]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn deleting_a_skipped_online_image_also_drops_its_online_record() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-skip-online-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("online-skipped.jpg");
        fs::write(&path, b"wallpaper").unwrap();
        let path = path.to_string_lossy().into_owned();
        let mut config = AppConfig {
            skipped_paths: vec![path.clone()],
            online_images: vec![OnlineImage {
                local_path: path.clone(),
                image_url: "https://example.test/skipped.jpg".into(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };

        delete_skipped_file_with(&mut config, &path, |file| fs::remove_file(file)).unwrap();

        assert!(config.skipped_paths.is_empty());
        assert!(config.online_images.is_empty());
        assert_eq!(
            config.excluded_image_urls,
            vec!["https://example.test/skipped.jpg"]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_delete_switches_away_when_the_current_wallpaper_is_removed() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-batch-cur-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let current = directory.join("current.jpg");
        let next = directory.join("next.jpg");
        fs::write(&current, b"wallpaper").unwrap();
        fs::write(&next, b"wallpaper").unwrap();
        let current = current.to_string_lossy().into_owned();
        let next = next.to_string_lossy().into_owned();
        let mut config = AppConfig {
            current_path: Some(current.clone()),
            remaining_paths: vec![next.clone()],
            ..AppConfig::default()
        };
        let failures = std::sync::Mutex::new(Vec::new());

        delete_batch_with(
            &mut config,
            &[current.clone()],
            |path| fs::remove_file(path),
            |config| {
                config.current_path = Some(next.clone());
                config.remaining_paths.clear();
                Ok(())
            },
            &failures,
        );

        assert_eq!(config.current_path, Some(next));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_delete_keeps_no_current_wallpaper_when_the_queue_is_empty() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-batch-empty-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let current = directory.join("current.jpg");
        fs::write(&current, b"wallpaper").unwrap();
        let current = current.to_string_lossy().into_owned();
        let mut config = AppConfig {
            current_path: Some(current.clone()),
            remaining_paths: Vec::new(),
            ..AppConfig::default()
        };
        let failures = std::sync::Mutex::new(Vec::new());

        delete_batch_with(
            &mut config,
            &[current.clone()],
            |path| fs::remove_file(path),
            |_| Err("没有可用的下一张壁纸。".to_string()),
            &failures,
        );

        assert_eq!(config.current_path, None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn batch_delete_reports_failures_but_keeps_the_successful_deletions() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-batch-fail-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let removable = directory.join("removable.jpg");
        let locked = directory.join("locked.jpg");
        fs::write(&removable, b"wallpaper").unwrap();
        fs::write(&locked, b"wallpaper").unwrap();
        let removable = removable.to_string_lossy().into_owned();
        let locked = locked.to_string_lossy().into_owned();
        let mut config = AppConfig::default();
        let failures = std::sync::Mutex::new(Vec::new());

        delete_batch_with(
            &mut config,
            &[removable.clone(), locked.clone()],
            |path| {
                if path == locked {
                    Err(std::io::Error::other("文件被占用"))
                } else {
                    fs::remove_file(path)
                }
            },
            |_| Ok(()),
            &failures,
        );

        assert!(!Path::new(&removable).exists());
        assert!(Path::new(&locked).exists());
        assert_eq!(failures.lock().unwrap().len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
