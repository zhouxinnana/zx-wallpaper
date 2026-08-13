use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration as StdDuration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as AutoStartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    domain::{is_supported_wallpaper, take_next_path},
    image_assets::{ImageAsset, ImageAssetKind, ImageAssetManager},
    online,
    preferences::{normalize_rotation_order, refresh_rotation_queue, RANDOM_ORDER},
};

const STATE_FILE_NAME: &str = "wallpaper-state.json";
const DIRECTORY_RESCAN_DEBOUNCE: StdDuration = StdDuration::from_millis(500);
const PREVIEW_STRIP_SIZE: usize = 5;
const ONLINE_SYNC_LOG_CAPACITY: usize = 40;

#[derive(Debug, PartialEq, Eq)]
struct DirectoryWatchChanges {
    to_unwatch: Vec<PathBuf>,
    to_watch: Vec<PathBuf>,
}

#[derive(Clone)]
struct LibraryScan {
    folder_statuses: HashMap<String, FolderStatus>,
    candidates: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperFolder {
    pub id: String,
    pub path: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub interval_hours: u8,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_discovered: usize,
    pub last_downloaded: usize,
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub category_statuses: Vec<OnlineSourceCategoryStatus>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSourceCategoryStatus {
    pub key: String,
    pub label: String,
    pub discovered: usize,
    pub downloaded: usize,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineImage {
    pub id: String,
    pub source_id: String,
    pub local_path: String,
    pub source_page_url: String,
    pub image_url: String,
    pub downloaded_at: String,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSyncLog {
    pub id: String,
    pub source_id: String,
    pub category_key: String,
    pub category_label: String,
    pub request_url: String,
    pub format: String,
    pub resolution: String,
    pub count: u8,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub status: String,
    pub response_status: Option<u16>,
    pub discovered: usize,
    pub downloaded: usize,
    pub skipped: usize,
    pub response_image_urls: Vec<String>,
    pub errors: Vec<String>,
    #[serde(default)]
    pub download_failures: Vec<OnlineDownloadFailure>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineDownloadFailure {
    pub image_url: String,
    pub resolved_url: Option<String>,
    pub response_status: Option<u16>,
    pub content_type: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub folders: Vec<WallpaperFolder>,
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
    #[serde(default = "default_rotation_order")]
    pub rotation_order: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "default_follow_system_theme")]
    pub follow_system_theme: bool,
    #[serde(default = "default_hide_to_tray_on_close")]
    pub hide_to_tray_on_close: bool,
    #[serde(default)]
    pub current_path: Option<String>,
    #[serde(default)]
    pub remaining_paths: Vec<String>,
    #[serde(default)]
    pub skipped_paths: Vec<String>,
    #[serde(default)]
    pub favorite_paths: Vec<String>,
    #[serde(default)]
    pub global_next_shortcut: Option<String>,
    #[serde(default)]
    pub last_switch_at: Option<String>,
    #[serde(default)]
    pub online_sources: Vec<OnlineSource>,
    #[serde(default)]
    pub online_images: Vec<OnlineImage>,
    #[serde(default)]
    pub online_sync_logs: Vec<OnlineSyncLog>,
    #[serde(default)]
    pub online_directory: Option<String>,
    #[serde(default = "default_storage_limit")]
    pub online_storage_limit_gb: u8,
    #[serde(default = "default_minimum_resolution")]
    pub online_minimum_resolution: u16,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            folders: Vec::new(),
            interval_minutes: default_interval_minutes(),
            display_mode: default_display_mode(),
            rotation_order: default_rotation_order(),
            auto_start: false,
            paused: false,
            follow_system_theme: default_follow_system_theme(),
            hide_to_tray_on_close: default_hide_to_tray_on_close(),
            current_path: None,
            remaining_paths: Vec::new(),
            skipped_paths: Vec::new(),
            favorite_paths: Vec::new(),
            global_next_shortcut: None,
            last_switch_at: None,
            online_sources: built_in_sources(),
            online_images: Vec::new(),
            online_sync_logs: Vec::new(),
            online_directory: None,
            online_storage_limit_gb: default_storage_limit(),
            online_minimum_resolution: default_minimum_resolution(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderStatus {
    kind: &'static str,
    available_count: usize,
    invalid_count: usize,
    scanned_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    #[serde(flatten)]
    config: AppConfig,
    available_count: usize,
    preview_url: Option<String>,
    preview_items: Vec<PreviewItem>,
    folder_statuses: HashMap<String, FolderStatus>,
    online_storage_bytes: u64,
    global_shortcut_registered: bool,
    shortcut_status: ShortcutStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ShortcutStatus {
    Disabled,
    Active { shortcut: String },
    Error { shortcut: String, message: String },
}

impl Default for ShortcutStatus {
    fn default() -> Self {
        Self::Disabled
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    path: String,
    preview_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    folders: Option<Vec<WallpaperFolder>>,
    interval_minutes: Option<u32>,
    display_mode: Option<String>,
    rotation_order: Option<String>,
    auto_start: Option<bool>,
    paused: Option<bool>,
    follow_system_theme: Option<bool>,
    hide_to_tray_on_close: Option<bool>,
    global_next_shortcut: Option<Option<String>>,
    online_directory: Option<Option<String>>,
    online_storage_limit_gb: Option<u8>,
    online_minimum_resolution: Option<u16>,
}

pub struct RuntimeState {
    config: Mutex<AppConfig>,
    library_scan: Mutex<Option<LibraryScan>>,
    initial_scan_in_progress: AtomicBool,
    pub(crate) image_assets: ImageAssetManager,
    shortcut_status: Mutex<ShortcutStatus>,
    registered_shortcut: Mutex<Option<String>>,
    upx8_next_request_at: Mutex<Instant>,
    state_file: PathBuf,
}

impl RuntimeState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let directory = app.path().app_config_dir().map_err(|error| {
            format!("Unable to resolve the application config directory: {error}")
        })?;
        fs::create_dir_all(&directory).map_err(|error| {
            format!("Unable to create the application config directory: {error}")
        })?;

        let state_file = directory.join(STATE_FILE_NAME);
        let mut config = match fs::read_to_string(&state_file) {
            Ok(contents) => serde_json::from_str(&contents)
                .map_err(|error| format!("Unable to read saved wallpaper settings: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
            Err(error) => return Err(format!("Unable to read saved wallpaper settings: {error}")),
        };
        config.online_sources = merge_online_sources(config.online_sources);
        sort_online_images_by_downloaded_at(&mut config.online_images);

        Ok(Self {
            config: Mutex::new(config),
            library_scan: Mutex::new(None),
            initial_scan_in_progress: AtomicBool::new(false),
            image_assets: ImageAssetManager::new(directory.join("image-cache")),
            shortcut_status: Mutex::new(ShortcutStatus::Disabled),
            registered_shortcut: Mutex::new(None),
            upx8_next_request_at: Mutex::new(Instant::now()),
            state_file,
        })
    }
}

pub fn start_background_tasks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let state = app.state::<RuntimeState>();
            run_due_tasks(&app, &state).await;
        }
    });
}

pub fn start_directory_watcher(app: AppHandle) {
    thread::spawn(move || {
        let (sender, receiver) = mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(sender, notify::Config::default()) {
            Ok(watcher) => watcher,
            Err(_) => return,
        };
        let mut watched_paths = HashSet::new();
        let mut pending_rescan: Option<Instant> = None;

        loop {
            let paths: HashSet<_> = lock_config(&app.state::<RuntimeState>())
                .map(|config| watched_folder_paths(&config))
                .unwrap_or_default()
                .into_iter()
                .collect();
            let changes = directory_watch_changes(&watched_paths, &paths);
            for path in changes.to_unwatch {
                if watcher.unwatch(&path).is_ok() {
                    watched_paths.remove(&path);
                }
            }
            for path in changes.to_watch {
                if !watched_paths.contains(&path)
                    && watcher.watch(&path, RecursiveMode::Recursive).is_ok()
                {
                    watched_paths.insert(path);
                }
            }

            let timeout = pending_rescan
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|| StdDuration::from_secs(1));
            match receiver.recv_timeout(timeout) {
                Ok(Ok(event)) if directory_event_requires_rescan(&event.kind) => {
                    pending_rescan = Some(directory_rescan_deadline(Instant::now()))
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            if directory_rescan_is_due(pending_rescan, Instant::now()) {
                let state = app.state::<RuntimeState>();
                let _ = mutate(&app, &state, |config| {
                    rescan_config(config);
                    Ok(())
                });
                pending_rescan = None;
            }
        }
    });
}

fn request_initial_scan(app: &AppHandle, state: &RuntimeState) {
    if state.initial_scan_in_progress.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<RuntimeState>();
        let config = match lock_config(&state) {
            Ok(config) => config.clone(),
            Err(_) => {
                state
                    .initial_scan_in_progress
                    .store(false, Ordering::Release);
                return;
            }
        };
        let scan = collect_candidates(&config);
        if let Ok(mut cached) = lock_library_scan(&state) {
            *cached = Some(scan.clone());
        }
        state
            .initial_scan_in_progress
            .store(false, Ordering::Release);
        let shortcut_status = shortcut_status(&state).unwrap_or_default();
        let snapshot = build_state_from_scan(config, scan, shortcut_status);
        let _ = app.emit("app://state-changed", &snapshot);
    });
}

pub fn synchronize_system_integration(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let config = lock_config(&state)?.clone();
    synchronize_autostart(app, config.auto_start)?;
    let requested = config.global_next_shortcut.as_deref();
    match replace_global_shortcut(app, None, requested) {
        Ok((status, registered)) => {
            *lock_shortcut_status(&state)? = status;
            *lock_registered_shortcut(&state)? = registered;
        }
        Err(message) => {
            *lock_shortcut_status(&state)? = ShortcutStatus::Error {
                shortcut: requested.unwrap_or_default().to_string(),
                message,
            };
        }
    }
    Ok(())
}

fn synchronize_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let registered = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("无法读取开机自启状态: {error}"))?;
    match autostart_action(enabled, registered) {
        AutoStartAction::Enable => app
            .autolaunch()
            .enable()
            .map_err(|error| format!("无法启用开机自启: {error}")),
        AutoStartAction::Disable => app
            .autolaunch()
            .disable()
            .map_err(|error| format!("无法关闭开机自启: {error}")),
        AutoStartAction::NoChange => Ok(()),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AutoStartAction {
    Enable,
    Disable,
    NoChange,
}

fn autostart_action(enabled: bool, registered: bool) -> AutoStartAction {
    match (enabled, registered) {
        (true, false) => AutoStartAction::Enable,
        (false, true) => AutoStartAction::Disable,
        _ => AutoStartAction::NoChange,
    }
}

fn replace_global_shortcut(
    app: &AppHandle,
    active_shortcut: Option<&str>,
    requested_shortcut: Option<&str>,
) -> Result<(ShortcutStatus, Option<String>), String> {
    let shortcuts = app.global_shortcut();
    let requested_shortcut = requested_shortcut.map(str::trim).filter(|value| !value.is_empty());
    if requested_shortcut == active_shortcut {
        return Ok(match requested_shortcut {
            Some(shortcut) => (
                ShortcutStatus::Active {
                    shortcut: shortcut.to_string(),
                },
                Some(shortcut.to_string()),
            ),
            None => (ShortcutStatus::Disabled, None),
        });
    }

    let Some(shortcut) = requested_shortcut else {
        if let Some(active_shortcut) = active_shortcut {
            shortcuts
                .unregister(active_shortcut)
                .map_err(|error| format!("无法注销全局快捷键: {error}"))?;
        }
        return Ok((ShortcutStatus::Disabled, None));
    };
    shortcuts
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                trigger_next_wallpaper(app);
            }
        })
        .map_err(|error| format!("无法注册全局快捷键: {error}"))?;
    if let Some(active_shortcut) = active_shortcut {
        if let Err(error) = shortcuts.unregister(active_shortcut) {
            let _ = shortcuts.unregister(shortcut);
            return Err(format!("无法替换旧全局快捷键: {error}"));
        }
    }
    Ok((
        ShortcutStatus::Active {
            shortcut: shortcut.to_string(),
        },
        Some(shortcut.to_string()),
    ))
}

pub fn hide_to_tray_on_close(app: &AppHandle) -> bool {
    app.state::<RuntimeState>()
        .config
        .lock()
        .map(|config| config.hide_to_tray_on_close)
        .unwrap_or(true)
}

pub fn trigger_next_wallpaper(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let _ = mutate_with_cached_scan(app, &state, switch_to_next_wallpaper);
}

pub fn toggle_paused_from_system(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let _ = mutate_without_rescan(app, &state, |config| {
        config.paused = !config.paused;
        Ok(())
    });
}

async fn run_due_tasks(app: &AppHandle, state: &RuntimeState) {
    let now = OffsetDateTime::now_utc();
    let (should_switch, source_ids) = match lock_config(state) {
        Ok(config) => (is_switch_due(&config, now), due_source_ids(&config, now)),
        Err(_) => return,
    };

    if should_switch {
        let _ = mutate_with_cached_scan(app, state, |config| {
            if is_switch_due(config, now) {
                switch_to_next_wallpaper(config)
            } else {
                Ok(())
            }
        });
    }

    for source_id in source_ids {
        let _ = run_online_source_impl(app, state, source_id, None, false).await;
    }
}

fn built_in_sources() -> Vec<OnlineSource> {
    vec![OnlineSource {
        id: "upx8-4k".to_string(),
        name: "UPX8 综合壁纸 4K".to_string(),
        url: "https://wp.upx8.com/api.php".to_string(),
        enabled: false,
        interval_hours: 24,
        last_run_at: None,
        next_run_at: None,
        last_discovered: 0,
        last_downloaded: 0,
        last_error: None,
        category_statuses: default_upx8_category_statuses(),
    }]
}

fn default_upx8_category_statuses() -> Vec<OnlineSourceCategoryStatus> {
    online::UPX8_CATEGORIES
        .iter()
        .map(|(key, label)| OnlineSourceCategoryStatus {
            key: (*key).to_string(),
            label: (*label).to_string(),
            discovered: 0,
            downloaded: 0,
            last_error: None,
        })
        .collect()
}

fn normalize_upx8_category_statuses(
    statuses: &[OnlineSourceCategoryStatus],
) -> Vec<OnlineSourceCategoryStatus> {
    default_upx8_category_statuses()
        .into_iter()
        .map(|mut status| {
            if let Some(saved) = statuses.iter().find(|saved| saved.key == status.key) {
                status.discovered = saved.discovered;
                status.downloaded = saved.downloaded;
                status.last_error = saved.last_error.clone();
            }
            status
        })
        .collect()
}

fn merge_online_sources(saved: Vec<OnlineSource>) -> Vec<OnlineSource> {
    let mut saved_by_id: HashMap<_, _> = saved
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();
    let merged: Vec<_> = built_in_sources()
        .into_iter()
        .map(|mut builtin| {
            if let Some(saved) = saved_by_id.remove(builtin.id.as_str()) {
                builtin.enabled = saved.enabled;
                builtin.interval_hours = match saved.interval_hours {
                    1 | 6 | 12 | 24 => saved.interval_hours,
                    _ => 24,
                };
                builtin.last_run_at = saved.last_run_at.clone();
                builtin.next_run_at = saved.next_run_at.clone();
                builtin.last_discovered = saved.last_discovered;
                builtin.last_downloaded = saved.last_downloaded;
                builtin.last_error = saved.last_error.clone();
                builtin.category_statuses = normalize_upx8_category_statuses(&saved.category_statuses);
            }
            builtin
        })
        .collect();
    merged
}

#[tauri::command]
pub fn get_state(app: AppHandle, state: State<'_, RuntimeState>) -> Result<AppState, String> {
    let config = lock_config(&state)?.clone();
    let scan = lock_library_scan(&state)?.clone().unwrap_or_else(|| {
        request_initial_scan(&app, &state);
        initial_scan(&config)
    });
    Ok(build_state_from_scan(config, scan, shortcut_status(&state)?))
}

#[tauri::command]
pub async fn add_folder(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return get_state(app, state);
    };
    let path = folder
        .into_path()
        .map_err(|error| format!("The selected folder path is invalid: {error}"))?;
    let path = path.to_string_lossy().into_owned();

    mutate(&app, &state, move |config| {
        if config
            .folders
            .iter()
            .any(|folder| same_path(&folder.path, &path))
        {
            return Ok(());
        }
        config.folders.push(WallpaperFolder {
            id: Uuid::new_v4().to_string(),
            path,
            enabled: true,
        });
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub fn update_folder(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    folder: WallpaperFolder,
) -> Result<AppState, String> {
    mutate(&app, &state, move |config| {
        let saved = config
            .folders
            .iter_mut()
            .find(|saved| saved.id == folder.id)
            .ok_or_else(|| "The wallpaper folder no longer exists.".to_string())?;
        *saved = folder;
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub fn remove_folder(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    folder_id: String,
) -> Result<AppState, String> {
    mutate(&app, &state, move |config| {
        let previous_count = config.folders.len();
        config.folders.retain(|folder| folder.id != folder_id);
        if config.folders.len() == previous_count {
            return Err("The wallpaper folder no longer exists.".to_string());
        }
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub fn open_folder(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    folder_id: String,
) -> Result<AppState, String> {
    let path = {
        let config = lock_config(&state)?;
        open_folder_path(&config, &folder_id).map(str::to_string)
    };
    if let Some(path) = path.filter(|path| Path::new(path).is_dir()) {
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|error| format!("无法打开壁纸目录: {error}"))?;
    }
    let config = lock_config(&state)?.clone();
    let snapshot = build_state(config);
    app.emit("app://state-changed", &snapshot)
        .map_err(|error| format!("Unable to publish the updated wallpaper state: {error}"))?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn rescan_folders(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    let mut config = lock_config(&state)?.clone();
    prune_missing_online_images(&mut config);
    prune_missing_favorite_paths(&mut config);
    let scan_config = config.clone();
    let scan = tauri::async_runtime::spawn_blocking(move || collect_candidates(&scan_config))
        .await
        .map_err(|error| format!("刷新图片列表任务中断: {error}"))?;
    commit_scanned_state(&app, &state, config, scan)
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
    mutate_with_cached_scan(&app, &state, |config| {
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
    })
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
pub fn update_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source: OnlineSource,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        if source.id != "upx8-4k" {
            return Err("仅支持 UPX8 综合壁纸 4K 来源。".to_string());
        }
        let saved = config
            .online_sources
            .iter_mut()
            .find(|saved| saved.id == source.id)
            .ok_or_else(|| "该在线来源已不存在。".to_string())?;
        saved.enabled = source.enabled;
        saved.interval_hours = match source.interval_hours {
            1 | 6 | 12 | 24 => source.interval_hours,
            _ => 24,
        };
        Ok(())
    })
}

#[tauri::command]
pub async fn run_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source_id: String,
) -> Result<AppState, String> {
    run_online_source_impl(&app, &state, source_id, None, true).await
}

#[tauri::command]
pub async fn run_upx8_category(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    category_key: String,
) -> Result<AppState, String> {
    if online::upx8_category_label(&category_key).is_none() {
        return Err("UPX8 分类不存在。".to_string());
    }
    run_online_source_impl(&app, &state, "upx8-4k".to_string(), Some(category_key), true).await
}

async fn run_online_source_impl(
    app: &AppHandle,
    state: &RuntimeState,
    source_id: String,
    category_key: Option<String>,
    manual: bool,
) -> Result<AppState, String> {
    if source_id != "upx8-4k" {
        return Err("仅支持 UPX8 综合壁纸 4K 来源。".to_string());
    }
    let (source, directory, minimum_resolution, storage_limit, known_urls, storage_bytes) = {
        let config = lock_config(state)?;
        let source = config
            .online_sources
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
            .ok_or_else(|| "该在线来源已不存在。".to_string())?;
        let directory = config
            .online_directory
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_online_directory(state));
        let known_urls: HashSet<String> = config
            .online_images
            .iter()
            .map(|image| image.image_url.clone())
            .collect();
        (
            source,
            directory,
            config.online_minimum_resolution,
            u64::from(config.online_storage_limit_gb) * 1024 * 1024 * 1024,
            known_urls,
            online_storage_bytes(&config),
        )
    };
    if !source.enabled && !manual {
        return Err("该在线来源当前已禁用。".to_string());
    }

    let category_keys = category_key
        .as_deref()
        .map(|key| vec![key.to_string()])
        .unwrap_or_else(|| {
            online::UPX8_CATEGORIES
                .iter()
                .map(|(key, _)| (*key).to_string())
                .collect()
        });
    let log_ids = start_online_sync_logs(
        app,
        state,
        &source_id,
        &source.url,
        minimum_resolution,
        &category_keys,
    )?;
    let started = Instant::now();
    let fetched = match fetch_upx8_categories(
        state,
        &source.url,
        minimum_resolution,
        category_keys,
    )
    .await
    {
        Ok(fetched) => fetched,
        Err(error) => {
            let completed_at = online::now_rfc3339();
            let elapsed = started.elapsed().as_millis() as u64;
            let error_for_log = error.clone();
            mutate_without_rescan(app, state, move |config| {
                complete_online_sync_logs(
                    config,
                    &log_ids,
                    &[],
                    &HashMap::new(),
                    &HashMap::new(),
                    &HashMap::new(),
                    Some(&error_for_log),
                    &completed_at,
                    elapsed,
                );
                Ok(())
            })?;
            return Err(error);
        }
    };

    let candidates = fetched.candidates;
    let category_results = fetched.categories;
    let mut seen = known_urls;
    let mut downloaded = Vec::new();
    let mut downloaded_by_category = HashMap::new();
    let mut skipped_by_category = HashMap::new();
    let mut download_errors: HashMap<String, Vec<online::DownloadFailure>> = HashMap::new();
    let mut downloaded_bytes = 0;
    for candidate in candidates.iter().cloned() {
        let category_key = candidate.category_key.clone().unwrap_or_default();
        if seen.contains(&candidate.image_url) || storage_bytes + downloaded_bytes >= storage_limit
        {
            *skipped_by_category.entry(category_key).or_insert(0) += 1;
            continue;
        }
        match online::download_candidate(candidate, &directory).await {
            Ok(image) => {
                downloaded_bytes += image.byte_length;
                seen.insert(image.image_url.clone());
                downloaded.push(image);
                *downloaded_by_category.entry(category_key).or_insert(0) += 1;
            }
            Err(error) => download_errors.entry(category_key).or_default().push(error),
        }
    }

    let discovered = candidates.len();
    let completed_at = online::now_rfc3339();
    let elapsed = started.elapsed().as_millis() as u64;
    mutate_without_rescan(app, state, move |config| {
        let downloaded_count = downloaded.len();
        config
            .online_images
            .extend(downloaded.into_iter().map(|image| OnlineImage {
                id: Uuid::new_v4().to_string(),
                source_id: source_id.clone(),
                local_path: image.local_path.to_string_lossy().into_owned(),
                source_page_url: image.source_page_url,
                image_url: image.image_url,
                downloaded_at: image.downloaded_at,
                width: image.width,
                height: image.height,
                mime_type: image.mime_type,
            }));
        sort_online_images_by_downloaded_at(&mut config.online_images);
        if source_id == "upx8-4k" {
            let mut statuses = config
                .online_sources
                .iter()
                .find(|source| source.id == source_id)
                .map(|source| normalize_upx8_category_statuses(&source.category_statuses))
                .unwrap_or_else(default_upx8_category_statuses);
            for category in &category_results {
                if let Some(status) = statuses.iter_mut().find(|status| status.key == category.key) {
                    status.discovered = category.discovered;
                    status.downloaded = downloaded_by_category
                        .get(&category.key)
                        .copied()
                        .unwrap_or_default();
                    status.last_error = category.error.clone();
                }
            }
            if let Some(source) = config
                .online_sources
                .iter_mut()
                .find(|source| source.id == source_id)
            {
                source.category_statuses = statuses;
            }
        }
        complete_online_sync_logs(
            config,
            &log_ids,
            &category_results,
            &downloaded_by_category,
            &skipped_by_category,
            &download_errors,
            None,
            &completed_at,
            elapsed,
        );
        update_source_result(config, &source_id, discovered, downloaded_count, None);
        Ok(())
    })
}

fn start_online_sync_logs(
    app: &AppHandle,
    state: &RuntimeState,
    source_id: &str,
    source_url: &str,
    minimum_resolution: u16,
    category_keys: &[String],
) -> Result<HashMap<String, String>, String> {
    let started_at = online::now_rfc3339();
    let resolution = upx8_resolution(minimum_resolution).to_string();
    let log_ids: HashMap<String, String> = category_keys
        .iter()
        .cloned()
        .map(|key| (key, Uuid::new_v4().to_string()))
        .collect();
    let entries: Vec<OnlineSyncLog> = category_keys
        .iter()
        .map(|key| OnlineSyncLog {
            id: log_ids[key].clone(),
            source_id: source_id.to_string(),
            category_key: key.clone(),
            category_label: online::upx8_category_label(key)
                .unwrap_or(key.as_str())
                .to_string(),
            request_url: online::upx8_request_url(source_url, key, minimum_resolution)
                .map(|url| url.to_string())
                .unwrap_or_else(|_| source_url.to_string()),
            format: "json".to_string(),
            resolution: resolution.clone(),
            count: 10,
            started_at: started_at.clone(),
            finished_at: None,
            duration_ms: None,
            status: "running".to_string(),
            response_status: None,
            discovered: 0,
            downloaded: 0,
            skipped: 0,
            response_image_urls: Vec::new(),
            errors: Vec::new(),
            download_failures: Vec::new(),
        })
        .collect();
    mutate_without_rescan(app, state, move |config| {
        config.online_sync_logs.splice(0..0, entries);
        config.online_sync_logs.truncate(ONLINE_SYNC_LOG_CAPACITY);
        Ok(())
    })?;
    Ok(log_ids)
}

#[allow(clippy::too_many_arguments)]
fn complete_online_sync_logs(
    config: &mut AppConfig,
    log_ids: &HashMap<String, String>,
    category_results: &[online::CategoryResult],
    downloaded_by_category: &HashMap<String, usize>,
    skipped_by_category: &HashMap<String, usize>,
    download_errors: &HashMap<String, Vec<online::DownloadFailure>>,
    terminal_error: Option<&str>,
    completed_at: &str,
    duration_ms: u64,
) {
    for (category_key, id) in log_ids {
        let category = category_results
            .iter()
            .find(|category| category.key == *category_key);
        let mut errors = category
            .and_then(|category| category.error.clone())
            .into_iter()
            .collect::<Vec<_>>();
        if let Some(download_errors) = download_errors.get(category_key) {
            errors.extend(
                download_errors
                    .iter()
                    .map(|failure| failure.reason.clone()),
            );
        }
        if let Some(error) = terminal_error {
            errors.push(error.to_string());
        }
        let status = if terminal_error.is_some() || category.and_then(|category| category.error.as_ref()).is_some() {
            "failed"
        } else if errors.is_empty() {
            "success"
        } else {
            "partial"
        };
        if let Some(log) = config.online_sync_logs.iter_mut().find(|log| log.id == *id) {
            log.finished_at = Some(completed_at.to_string());
            log.duration_ms = Some(duration_ms);
            log.status = status.to_string();
            log.response_status = category.and_then(|category| category.response_status);
            if let Some(category) = category {
                log.request_url = category.request_url.clone();
            }
            log.discovered = category.map(|category| category.discovered).unwrap_or_default();
            log.downloaded = downloaded_by_category
                .get(category_key)
                .copied()
                .unwrap_or_default();
            log.skipped = skipped_by_category.get(category_key).copied().unwrap_or_default();
            log.response_image_urls = category
                .map(|category| category.response_image_urls.clone())
                .unwrap_or_default();
            log.errors = errors;
            log.download_failures = download_errors
                .get(category_key)
                .map(|failures| {
                    failures
                        .iter()
                        .map(|failure| OnlineDownloadFailure {
                            image_url: failure.image_url.clone(),
                            resolved_url: failure.resolved_url.clone(),
                            response_status: failure.response_status,
                            content_type: failure.content_type.clone(),
                            reason: failure.reason.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
        }
    }
}

fn upx8_resolution(minimum_resolution: u16) -> &'static str {
    match minimum_resolution {
        3840 => "3840x2160",
        2560 => "2560x1440",
        _ => "1920x1080",
    }
}

async fn fetch_upx8_categories(
    state: &RuntimeState,
    source_url: &str,
    minimum_resolution: u16,
    category_keys: Vec<String>,
) -> Result<online::SourceFetchResult, String> {
    let mut fetched = online::SourceFetchResult::default();
    for key in category_keys {
        online::upx8_category_label(&key).ok_or_else(|| "UPX8 分类不存在。".to_string())?;
        wait_for_upx8_request_slot(state).await?;
        match online::fetch_upx8_category(source_url, &key, minimum_resolution).await {
            Ok(response) => {
                fetched.categories.push(online::CategoryResult {
                    key,
                    request_url: response.request_url,
                    response_status: Some(response.response_status),
                    response_image_urls: response.image_urls,
                    discovered: response.candidates.len(),
                    error: None,
                });
                fetched.candidates.extend(response.candidates);
            }
            Err(error) => fetched.categories.push(online::CategoryResult {
                request_url: online::upx8_request_url(source_url, &key, minimum_resolution)
                    .map(|url| url.to_string())
                    .unwrap_or_else(|_| source_url.to_string()),
                key,
                response_status: None,
                response_image_urls: Vec::new(),
                discovered: 0,
                error: Some(error),
            }),
        }
    }
    Ok(fetched)
}

async fn wait_for_upx8_request_slot(state: &RuntimeState) -> Result<(), String> {
    let wait = {
        let mut next_request_at = state
            .upx8_next_request_at
            .lock()
            .map_err(|_| "无法获取 UPX8 请求限速器。".to_string())?;
        let now = Instant::now();
        let scheduled_at = (*next_request_at).max(now);
        *next_request_at = scheduled_at + StdDuration::from_secs(1);
        scheduled_at.saturating_duration_since(now)
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_online_image_as_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    image_id: String,
) -> Result<AppState, String> {
    let (path, display_mode) = {
        let config = lock_config(&state)?;
        let path = config
            .online_images
            .iter()
            .find(|image| image.id == image_id)
            .map(|image| image.local_path.clone())
            .ok_or_else(|| "该在线图片已不存在。".to_string())?;
        (path, config.display_mode.clone())
    };
    let wallpaper_path = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        set_desktop_wallpaper(&wallpaper_path, &display_mode)
    })
    .await
    .map_err(|error| format!("设置壁纸任务中断: {error}"))??;

    mutate_without_rescan(&app, &state, move |config| {
        select_online_wallpaper(config, &image_id)?;
        Ok(())
    })
}

#[tauri::command]
pub async fn delete_online_image(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    image_id: String,
) -> Result<AppState, String> {
    let path = {
        let config = lock_config(&state)?;
        config
            .online_images
            .iter()
            .find(|image| image.id == image_id)
            .map(|image| image.local_path.clone())
            .ok_or_else(|| "该在线图片已不存在。".to_string())?
    };
    let path_to_delete = path.clone();
    tauri::async_runtime::spawn_blocking(move || fs::remove_file(path_to_delete))
        .await
        .map_err(|error| format!("删除在线图片任务中断: {error}"))?
        .map_err(|error| format!("无法删除在线图片: {error}"))?;
    state.image_assets.purge_source(&path);
    mutate_without_rescan(&app, &state, move |config| {
        config.online_images.retain(|image| image.id != image_id);
        config
            .favorite_paths
            .retain(|favorite| !same_path(favorite, &path));
        Ok(())
    })
}

#[tauri::command]
pub async fn select_online_directory(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    let Some(directory) = app.dialog().file().blocking_pick_folder() else {
        return get_state(app, state);
    };
    let directory = directory
        .into_path()
        .map_err(|error| format!("所选在线壁纸目录无效: {error}"))?;
    mutate(&app, &state, move |config| {
        migrate_online_directory(config, &directory)
    })
}

#[tauri::command]
pub fn reveal_online_image(state: State<'_, RuntimeState>, image_id: String) -> Result<(), String> {
    let path = {
        let config = lock_config(&state)?;
        config
            .online_images
            .iter()
            .find(|image| image.id == image_id)
            .map(|image| image.local_path.clone())
            .ok_or_else(|| "该在线图片已不存在。".to_string())?
    };
    Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开图片所在目录: {error}"))?;
    Ok(())
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

#[tauri::command]
pub async fn get_image_asset(
    state: State<'_, RuntimeState>,
    file_path: String,
    kind: ImageAssetKind,
) -> Result<Option<ImageAsset>, String> {
    state.image_assets.get(file_path, kind).await
}

#[tauri::command]
pub fn prewarm_image_assets(
    state: State<'_, RuntimeState>,
    file_paths: Vec<String>,
    kind: ImageAssetKind,
) -> Result<(), String> {
    state.image_assets.prewarm(file_paths, kind);
    Ok(())
}

pub fn serve_image_asset(
    state: &RuntimeState,
    request_path: &str,
) -> tauri::http::Response<Vec<u8>> {
    state.image_assets.serve(request_path)
}

fn mutate<F>(app: &AppHandle, state: &RuntimeState, operation: F) -> Result<AppState, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    let next_config = {
        let config = lock_config(state)?;
        let mut next_config = config.clone();
        operation(&mut next_config)?;
        next_config
    };
    let scan = collect_candidates(&next_config);
    commit_scanned_state(app, state, next_config, scan)
}

fn mutate_with_cached_scan<F>(
    app: &AppHandle,
    state: &RuntimeState,
    operation: F,
) -> Result<AppState, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    let (mut next_config, scan) = {
        let config = lock_config(state)?;
        let mut next_config = config.clone();
        let scan = lock_library_scan(state)?
            .clone()
            .unwrap_or_else(|| initial_scan(&next_config));
        refresh_rotation_queue_for_config(&mut next_config, &scan.candidates);
        (next_config, scan)
    };
    operation(&mut next_config)?;
    commit_scanned_state(app, state, next_config, scan)
}

fn commit_scanned_state(
    app: &AppHandle,
    state: &RuntimeState,
    mut next_config: AppConfig,
    scan: LibraryScan,
) -> Result<AppState, String> {
    refresh_rotation_queue_for_config(&mut next_config, &scan.candidates);
    let mut live_paths = scan.candidates.clone();
    live_paths.extend(next_config.skipped_paths.iter().cloned());
    live_paths.extend(next_config.favorite_paths.iter().cloned());
    if let Some(current_path) = &next_config.current_path {
        live_paths.push(current_path.clone());
    }
    state.image_assets.prune_sources(&live_paths);
    persist(&state.state_file, &next_config)?;
    let snapshot = build_state_from_scan(next_config.clone(), scan.clone(), shortcut_status(state)?);
    *lock_library_scan(state)? = Some(scan);
    *lock_config(state)? = next_config;
    app.emit("app://state-changed", &snapshot)
        .map_err(|error| format!("Unable to publish the updated wallpaper state: {error}"))?;
    Ok(snapshot)
}

fn mutate_without_rescan<F>(
    app: &AppHandle,
    state: &RuntimeState,
    operation: F,
) -> Result<AppState, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    let (previous_online_images, mut next_config) = {
        let config = lock_config(state)?;
        let mut next_config = config.clone();
        operation(&mut next_config)?;
        (config.online_images.clone(), next_config)
    };
    let mut scan = lock_library_scan(state)?
        .clone()
        .unwrap_or_else(|| initial_scan(&next_config));
    reconcile_online_candidates(
        &mut scan,
        &previous_online_images,
        &next_config.online_images,
    );
    refresh_rotation_queue_for_config(&mut next_config, &scan.candidates);
    persist(&state.state_file, &next_config)?;
    let snapshot = build_state_from_scan(next_config.clone(), scan.clone(), shortcut_status(state)?);
    *lock_library_scan(state)? = Some(scan);
    *lock_config(state)? = next_config;
    app.emit("app://state-changed", &snapshot)
        .map_err(|error| format!("Unable to publish the updated wallpaper state: {error}"))?;
    Ok(snapshot)
}

fn lock_config(state: &RuntimeState) -> Result<std::sync::MutexGuard<'_, AppConfig>, String> {
    state.config.lock().map_err(|_| {
        "The wallpaper state is unavailable because another operation failed.".to_string()
    })
}

fn lock_library_scan(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, Option<LibraryScan>>, String> {
    state.library_scan.lock().map_err(|_| {
        "The wallpaper library scan is unavailable because another operation failed.".to_string()
    })
}

fn lock_shortcut_status(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, ShortcutStatus>, String> {
    state
        .shortcut_status
        .lock()
        .map_err(|_| "全局快捷键状态不可用。".to_string())
}

fn lock_registered_shortcut(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, Option<String>>, String> {
    state
        .registered_shortcut
        .lock()
        .map_err(|_| "全局快捷键注册状态不可用。".to_string())
}

fn shortcut_status(state: &RuntimeState) -> Result<ShortcutStatus, String> {
    Ok(lock_shortcut_status(state)?.clone())
}

fn persist(path: &Path, config: &AppConfig) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to save wallpaper settings: {error}"))?;
    let temporary_path = path.with_extension("tmp");
    fs::write(&temporary_path, contents)
        .map_err(|error| format!("Unable to save wallpaper settings: {error}"))?;
    fs::rename(&temporary_path, path)
        .map_err(|error| format!("Unable to finalize wallpaper settings: {error}"))
}

fn default_online_directory(state: &RuntimeState) -> PathBuf {
    state
        .state_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("online-wallpapers")
}

fn migrate_online_directory(config: &mut AppConfig, directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("无法创建在线壁纸目录: {error}"))?;
    let mut moved_paths = Vec::new();

    for image in &config.online_images {
        let source = Path::new(&image.local_path);
        if !source.is_file() || source.parent() == Some(directory) {
            continue;
        }
        let file_name = source
            .file_name()
            .ok_or_else(|| "在线图片缺少文件名。".to_string())?;
        let target = available_online_target_path(directory, file_name);
        match fs::rename(source, &target) {
            Ok(()) => {}
            Err(_) => {
                fs::copy(source, &target).map_err(|error| format!("无法迁移在线图片: {error}"))?;
                fs::remove_file(source)
                    .map_err(|error| format!("无法移除已迁移的在线图片: {error}"))?;
            }
        }
        moved_paths.push((
            image.local_path.clone(),
            target.to_string_lossy().into_owned(),
        ));
    }

    for (source, target) in &moved_paths {
        for image in &mut config.online_images {
            if same_path(&image.local_path, source) {
                image.local_path = target.clone();
            }
        }
        replace_config_path(&mut config.current_path, source, target);
        replace_config_paths(&mut config.remaining_paths, source, target);
        replace_config_paths(&mut config.skipped_paths, source, target);
        replace_config_paths(&mut config.favorite_paths, source, target);
    }
    config.online_directory = Some(directory.to_string_lossy().into_owned());
    rescan_config(config);
    Ok(())
}

fn available_online_target_path(directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let target = directory.join(file_name);
    if !target.exists() {
        return target;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("wallpaper");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    directory.join(format!("{stem}-{}{}", Uuid::new_v4(), extension))
}

fn replace_config_path(path: &mut Option<String>, source: &str, target: &str) {
    if path.as_deref().is_some_and(|path| same_path(path, source)) {
        *path = Some(target.to_string());
    }
}

fn replace_config_paths(paths: &mut [String], source: &str, target: &str) {
    for path in paths {
        if same_path(path, source) {
            *path = target.to_string();
        }
    }
}

fn online_storage_bytes(config: &AppConfig) -> u64 {
    config
        .online_images
        .iter()
        .filter_map(|image| fs::metadata(&image.local_path).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn sort_online_images_by_downloaded_at(images: &mut [OnlineImage]) {
    images.sort_by(|left, right| {
        let left_time = OffsetDateTime::parse(&left.downloaded_at, &Rfc3339).ok();
        let right_time = OffsetDateTime::parse(&right.downloaded_at, &Rfc3339).ok();
        match (left_time, right_time) {
            (Some(left_time), Some(right_time)) => right_time.cmp(&left_time),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| left.id.cmp(&right.id))
    });
}

fn update_source_result(
    config: &mut AppConfig,
    source_id: &str,
    discovered: usize,
    downloaded: usize,
    last_error: Option<String>,
) {
    if let Some(source) = config
        .online_sources
        .iter_mut()
        .find(|source| source.id == source_id)
    {
        source.last_run_at = Some(online::now_rfc3339());
        source.next_run_at = Some(online::next_run_at(source.interval_hours));
        source.last_discovered = discovered;
        source.last_downloaded = downloaded;
        source.last_error = last_error;
    }
}

fn is_switch_due(config: &AppConfig, now: OffsetDateTime) -> bool {
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

fn due_source_ids(config: &AppConfig, now: OffsetDateTime) -> Vec<String> {
    config
        .online_sources
        .iter()
        .filter(|source| source.enabled)
        .filter(|source| {
            source
                .next_run_at
                .as_deref()
                .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
                .map_or(true, |next_run_at| next_run_at <= now)
        })
        .map(|source| source.id.clone())
        .collect()
}

fn build_state(config: AppConfig) -> AppState {
    build_state_from_scan(
        config.clone(),
        collect_candidates(&config),
        ShortcutStatus::Disabled,
    )
}

fn build_state_from_scan(
    config: AppConfig,
    scan: LibraryScan,
    shortcut_status: ShortcutStatus,
) -> AppState {
    let online_storage_bytes = online_storage_bytes(&config);
    let preview_items = build_preview_items(&config, &scan);

    AppState {
        config,
        available_count: scan.candidates.len(),
        preview_url: None,
        preview_items,
        folder_statuses: scan.folder_statuses,
        online_storage_bytes,
        global_shortcut_registered: matches!(shortcut_status, ShortcutStatus::Active { .. }),
        shortcut_status,
    }
}

fn build_preview_items(config: &AppConfig, scan: &LibraryScan) -> Vec<PreviewItem> {
    let mut paths = Vec::with_capacity(PREVIEW_STRIP_SIZE);
    if let Some(current_path) = config.current_path.as_deref() {
        paths.push(current_path.to_string());
    }

    let queued_paths = if config.remaining_paths.is_empty() {
        &scan.candidates
    } else {
        &config.remaining_paths
    };
    for path in queued_paths {
        if paths.len() >= PREVIEW_STRIP_SIZE
            || paths.iter().any(|candidate| same_path(candidate, path))
            || config.skipped_paths.iter().any(|skipped| same_path(skipped, path))
        {
            continue;
        }
        paths.push(path.clone());
    }

    paths
        .into_iter()
        .map(|path| PreviewItem {
            path,
            preview_url: None,
        })
        .collect()
}

fn rescan_config(config: &mut AppConfig) {
    prune_missing_favorite_paths(config);
    let scan = collect_candidates(config);
    refresh_rotation_queue_for_config(config, &scan.candidates);
}

fn refresh_rotation_queue_for_config(config: &mut AppConfig, candidates: &[String]) {
    config.remaining_paths = refresh_rotation_queue(
        &config.rotation_order,
        &config.remaining_paths,
        candidates,
        &config.skipped_paths,
        config.current_path.as_deref(),
    );
}

fn watched_folder_paths(config: &AppConfig) -> Vec<PathBuf> {
    config
        .folders
        .iter()
        .filter(|folder| folder.enabled)
        .map(|folder| PathBuf::from(&folder.path))
        .collect()
}

fn directory_watch_changes(
    watched_paths: &HashSet<PathBuf>,
    desired_paths: &HashSet<PathBuf>,
) -> DirectoryWatchChanges {
    let mut to_unwatch: Vec<_> = watched_paths.difference(desired_paths).cloned().collect();
    let mut to_watch: Vec<_> = desired_paths.difference(watched_paths).cloned().collect();
    to_unwatch.sort_by_key(|path| path.to_string_lossy().to_ascii_lowercase());
    to_watch.sort_by_key(|path| path.to_string_lossy().to_ascii_lowercase());
    DirectoryWatchChanges {
        to_unwatch,
        to_watch,
    }
}

fn directory_rescan_deadline(changed_at: Instant) -> Instant {
    changed_at + DIRECTORY_RESCAN_DEBOUNCE
}

fn directory_event_requires_rescan(kind: &notify::EventKind) -> bool {
    matches!(
        kind,
        notify::EventKind::Any
            | notify::EventKind::Create(_)
            | notify::EventKind::Modify(_)
            | notify::EventKind::Remove(_)
    )
}

fn directory_rescan_is_due(deadline: Option<Instant>, now: Instant) -> bool {
    deadline.is_some_and(|deadline| now >= deadline)
}

fn collect_candidates(config: &AppConfig) -> LibraryScan {
    let (folder_statuses, local_paths) = inspect_folders(&config.folders);
    let online_paths = config
        .online_images
        .iter()
        .filter(|image| Path::new(&image.local_path).is_file())
        .map(|image| image.local_path.clone())
        .collect();
    LibraryScan {
        folder_statuses,
        candidates: merge_candidate_paths(local_paths, online_paths),
    }
}

fn prune_missing_online_images(config: &mut AppConfig) {
    config
        .online_images
        .retain(|image| Path::new(&image.local_path).is_file());
    if config
        .current_path
        .as_deref()
        .is_some_and(|path| !Path::new(path).is_file())
    {
        config.current_path = None;
    }
}

fn prune_missing_favorite_paths(config: &mut AppConfig) {
    config.favorite_paths.retain(|path| {
        let path = Path::new(path);
        path.is_file() && is_supported_wallpaper(path)
    });
}

fn initial_scan(config: &AppConfig) -> LibraryScan {
    let folder_statuses = config
        .folders
        .iter()
        .map(|folder| {
            let status = FolderStatus {
                kind: if Path::new(&folder.path).is_dir() {
                    "empty"
                } else {
                    "unavailable"
                },
                available_count: 0,
                invalid_count: 0,
                scanned_at: String::new(),
            };
            (folder.id.clone(), status)
        })
        .collect();
    let online_paths = config
        .online_images
        .iter()
        .filter(|image| Path::new(&image.local_path).is_file())
        .map(|image| image.local_path.clone())
        .collect();
    LibraryScan {
        folder_statuses,
        candidates: online_paths,
    }
}

fn merge_candidate_paths(local_paths: Vec<String>, online_paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    local_paths
        .into_iter()
        .chain(online_paths)
        .filter(|path| seen.insert(path.replace('/', "\\").to_ascii_lowercase()))
        .collect()
}

fn reconcile_online_candidates(
    scan: &mut LibraryScan,
    previous_images: &[OnlineImage],
    next_images: &[OnlineImage],
) {
    let key = |path: &str| path.replace('/', "\\").to_ascii_lowercase();
    let previous_paths: HashSet<_> = previous_images
        .iter()
        .map(|image| key(&image.local_path))
        .collect();
    let next_paths: HashSet<_> = next_images
        .iter()
        .map(|image| key(&image.local_path))
        .collect();
    scan.candidates.retain(|path| {
        let candidate = key(path);
        !previous_paths.contains(&candidate) || next_paths.contains(&candidate)
    });
    let mut candidate_paths: HashSet<_> = scan.candidates.iter().map(|path| key(path)).collect();
    for image in next_images {
        let image_path = Path::new(&image.local_path);
        let image_key = key(&image.local_path);
        if image_path.is_file() && candidate_paths.insert(image_key) {
            scan.candidates.push(image.local_path.clone());
        }
    }
}

fn open_folder_path<'a>(config: &'a AppConfig, folder_id: &str) -> Option<&'a str> {
    config
        .folders
        .iter()
        .find(|folder| folder.id == folder_id && folder.id != "online-library")
        .map(|folder| folder.path.as_str())
}

fn delete_skipped_file(config: &mut AppConfig, file_path: &str) -> Result<(), String> {
    if !config
        .skipped_paths
        .iter()
        .any(|path| same_path(path, file_path))
    {
        return Ok(());
    }
    match fs::remove_file(file_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法删除已跳过图片: {error}")),
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

fn select_online_wallpaper(config: &mut AppConfig, image_id: &str) -> Result<String, String> {
    let path = config
        .online_images
        .iter()
        .find(|image| image.id == image_id)
        .map(|image| image.local_path.clone())
        .ok_or_else(|| "该在线图片已不存在。".to_string())?;
    config.current_path = Some(path.clone());
    config.paused = true;
    Ok(path)
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
    config.current_path = Some(selected_path.clone());
    config
        .remaining_paths
        .retain(|path| !same_path(path, &selected_path));
    config.last_switch_at = Some(online::now_rfc3339());
    Ok(())
}

fn switch_to_next_wallpaper(config: &mut AppConfig) -> Result<(), String> {
    let Some((next_path, remaining_paths)) = take_next_path(
        &config.remaining_paths,
        &config.skipped_paths,
        config.current_path.as_deref(),
    ) else {
        return Err("No eligible wallpaper was found in the selected folders.".to_string());
    };

    set_desktop_wallpaper(Path::new(&next_path), &config.display_mode)?;
    config.current_path = Some(next_path);
    config.remaining_paths = remaining_paths;
    config.last_switch_at = Some(online::now_rfc3339());
    Ok(())
}

fn inspect_folders(folders: &[WallpaperFolder]) -> (HashMap<String, FolderStatus>, Vec<String>) {
    let mut statuses = HashMap::new();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    for folder in folders {
        let path = Path::new(&folder.path);
        let scanned_at = online::now_rfc3339();
        let (status, paths) = if !path.is_dir() {
            (
                FolderStatus {
                    kind: "unavailable",
                    available_count: 0,
                    invalid_count: 0,
                    scanned_at,
                },
                Vec::new(),
            )
        } else {
            let mut invalid_count = 0;
            let mut paths: Vec<_> = WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && is_supported_wallpaper(entry.path()))
                .filter_map(|entry| {
                    if image::image_dimensions(entry.path()).is_ok() {
                        Some(entry.path().to_string_lossy().into_owned())
                    } else {
                        invalid_count += 1;
                        None
                    }
                })
                .collect();
            paths.sort_by_key(|entry| entry.to_ascii_lowercase());
            let available_count = paths.len();
            (
                FolderStatus {
                    kind: if available_count == 0 {
                        "empty"
                    } else {
                        "available"
                    },
                    available_count,
                    invalid_count,
                    scanned_at,
                },
                paths,
            )
        };

        if folder.enabled {
            for candidate in paths {
                if seen.insert(candidate.to_ascii_lowercase()) {
                    candidates.push(candidate);
                }
            }
        }
        statuses.insert(folder.id.clone(), status);
    }

    (statuses, candidates)
}

fn same_path(left: &str, right: &str) -> bool {
    left.replace('/', "\\")
        .eq_ignore_ascii_case(&right.replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_corrupt_images_and_reports_the_scan_result() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let valid_path = directory.join("valid.png");
        image::RgbImage::from_pixel(10, 10, image::Rgb([32, 64, 128]))
            .save_with_format(&valid_path, image::ImageFormat::Png)
            .unwrap();
        fs::write(directory.join("corrupt.jpg"), b"not an image").unwrap();
        let folder = WallpaperFolder {
            id: "test-folder".into(),
            path: directory.to_string_lossy().into_owned(),
            enabled: true,
        };

        let (statuses, candidates) = inspect_folders(&[folder]);
        let status = statuses.get("test-folder").unwrap();

        assert_eq!(status.kind, "available");
        assert_eq!(status.available_count, 1);
        assert_eq!(status.invalid_count, 1);
        assert!(!status.scanned_at.is_empty());
        assert_eq!(candidates, vec![valid_path.to_string_lossy().into_owned()]);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn initial_scan_returns_immediately_with_known_online_images() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-initial-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("corrupt.jpg"), b"not an image").unwrap();
        let online_path = directory.join("online.jpg");
        fs::write(&online_path, b"online image placeholder").unwrap();
        let config = AppConfig {
            folders: vec![WallpaperFolder {
                id: "local".into(),
                path: directory.to_string_lossy().into_owned(),
                enabled: true,
            }],
            online_images: vec![OnlineImage {
                local_path: online_path.to_string_lossy().into_owned(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };

        let scan = initial_scan(&config);
        let status = scan.folder_statuses.get("local").unwrap();

        assert_eq!(status.kind, "empty");
        assert_eq!(status.available_count, 0);
        assert_eq!(status.invalid_count, 0);
        assert!(status.scanned_at.is_empty());
        assert_eq!(
            scan.candidates,
            vec![online_path.to_string_lossy().into_owned()]
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn reconciles_directory_watches_when_the_enabled_folders_change() {
        let current = HashSet::from([
            PathBuf::from("D:\\Wallpapers\\keep"),
            PathBuf::from("D:\\Wallpapers\\remove"),
        ]);
        let desired = HashSet::from([
            PathBuf::from("D:\\Wallpapers\\keep"),
            PathBuf::from("D:\\Wallpapers\\add"),
        ]);

        let changes = directory_watch_changes(&current, &desired);

        assert_eq!(
            changes.to_unwatch,
            vec![PathBuf::from("D:\\Wallpapers\\remove")]
        );
        assert_eq!(changes.to_watch, vec![PathBuf::from("D:\\Wallpapers\\add")]);
    }

    #[test]
    fn ignores_read_access_events_when_scheduling_directory_rescans() {
        assert!(!directory_event_requires_rescan(
            &notify::EventKind::Access(notify::event::AccessKind::Read,)
        ));
        assert!(directory_event_requires_rescan(&notify::EventKind::Create(
            notify::event::CreateKind::Any,
        )));
    }

    #[test]
    fn retains_only_upx8_when_migrating_saved_sources() {
        let saved = OnlineSource {
            id: "upx8-4k".into(),
            enabled: true,
            interval_hours: 6,
            last_downloaded: 3,
            ..OnlineSource::default()
        };
        let obsolete = OnlineSource {
            id: "bing-cn-4k".into(),
            enabled: true,
            ..OnlineSource::default()
        };
        let sources = merge_online_sources(vec![saved, obsolete]);
        assert_eq!(sources.len(), 1);
        let upx8 = sources
            .iter()
            .find(|source| source.id == "upx8-4k")
            .unwrap();
        assert!(upx8.enabled);
        assert_eq!(upx8.interval_hours, 6);
        assert_eq!(upx8.last_downloaded, 3);
    }

    #[test]
    fn merges_existing_online_images_into_the_wallpaper_candidate_set() {
        let candidates = merge_candidate_paths(
            vec!["D:\\Wallpapers\\local.jpg".into()],
            vec![
                "D:\\ZX Wallpaper\\Online\\downloaded.jpg".into(),
                "d:\\wallpapers\\LOCAL.jpg".into(),
            ],
        );

        assert_eq!(
            candidates,
            vec![
                "D:\\Wallpapers\\local.jpg",
                "D:\\ZX Wallpaper\\Online\\downloaded.jpg",
            ]
        );
    }

    #[test]
    fn orders_online_images_by_latest_download_with_a_stable_id_tiebreaker() {
        let mut images = vec![
            OnlineImage {
                id: "same-time-b".into(),
                downloaded_at: "2026-08-10T01:00:00Z".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "old".into(),
                downloaded_at: "2026-08-09T01:00:00Z".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "same-time-a".into(),
                downloaded_at: "2026-08-10T01:00:00Z".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "invalid".into(),
                downloaded_at: "not-a-timestamp".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "new".into(),
                downloaded_at: "2026-08-11T01:00:00Z".into(),
                ..OnlineImage::default()
            },
        ];

        sort_online_images_by_downloaded_at(&mut images);

        assert_eq!(
            images
                .iter()
                .map(|image| image.id.as_str())
                .collect::<Vec<_>>(),
            vec!["new", "same-time-a", "same-time-b", "old", "invalid"]
        );
    }

    #[test]
    fn removes_deleted_online_images_from_the_cached_candidate_set() {
        let deleted = OnlineImage {
            id: "online-image".into(),
            local_path: "D:\\ZX Wallpaper\\Online\\deleted.jpg".into(),
            ..OnlineImage::default()
        };
        let mut scan = LibraryScan {
            folder_statuses: HashMap::new(),
            candidates: vec![deleted.local_path.clone()],
        };

        reconcile_online_candidates(&mut scan, &[deleted], &[]);

        assert!(scan.candidates.is_empty());
    }

    #[test]
    fn refresh_prunes_missing_online_images_from_the_saved_state() {
        let missing_path = std::env::temp_dir()
            .join(format!("zx-wallpaper-missing-{}.jpg", Uuid::new_v4()));
        let mut config = AppConfig {
            current_path: Some(missing_path.to_string_lossy().into_owned()),
            online_images: vec![OnlineImage {
                id: "missing-online-image".into(),
                local_path: missing_path.to_string_lossy().into_owned(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };

        prune_missing_online_images(&mut config);

        assert!(config.online_images.is_empty());
        assert!(config.current_path.is_none());
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
    fn refresh_prunes_missing_favorite_paths() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-favorite-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let existing_path = directory.join("favorite.png");
        fs::write(&existing_path, b"wallpaper").unwrap();
        let missing_path = directory.join("missing.jpg");
        let mut config = AppConfig {
            favorite_paths: vec![
                existing_path.to_string_lossy().into_owned(),
                missing_path.to_string_lossy().into_owned(),
            ],
            ..AppConfig::default()
        };

        prune_missing_favorite_paths(&mut config);

        assert_eq!(config.favorite_paths.len(), 1);
        assert!(same_path(
            &config.favorite_paths[0],
            &existing_path.to_string_lossy()
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn selecting_an_online_image_pauses_automatic_switching() {
        let mut config = AppConfig {
            paused: false,
            online_images: vec![OnlineImage {
                id: "online-1".into(),
                local_path: "D:\\ZX Wallpaper\\Online\\chosen.jpg".into(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };

        select_online_wallpaper(&mut config, "online-1").unwrap();

        assert!(config.paused);
        assert_eq!(
            config.current_path.as_deref(),
            Some("D:\\ZX Wallpaper\\Online\\chosen.jpg")
        );
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

        delete_skipped_file(&mut config, &path).unwrap();

        assert!(!Path::new(&path).exists());
        assert!(config.skipped_paths.is_empty());
    }

    #[test]
    fn does_not_resolve_the_managed_online_directory_as_a_wallpaper_folder() {
        let config = AppConfig {
            folders: vec![
                WallpaperFolder {
                    id: "local".into(),
                    path: "D:\\Wallpapers".into(),
                    enabled: true,
                },
                WallpaperFolder {
                    id: "online-library".into(),
                    path: "D:\\ZX Wallpaper\\Online".into(),
                    enabled: true,
                },
            ],
            ..AppConfig::default()
        };

        assert_eq!(open_folder_path(&config, "local"), Some("D:\\Wallpapers"));
        assert_eq!(open_folder_path(&config, "online-library"), None);
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
    fn watches_only_enabled_local_wallpaper_directories() {
        let config = AppConfig {
            folders: vec![
                WallpaperFolder {
                    id: "enabled".into(),
                    path: "D:\\Wallpapers".into(),
                    enabled: true,
                },
                WallpaperFolder {
                    id: "disabled".into(),
                    path: "D:\\Archive".into(),
                    enabled: false,
                },
            ],
            ..AppConfig::default()
        };

        assert_eq!(
            watched_folder_paths(&config),
            vec![PathBuf::from("D:\\Wallpapers")]
        );
    }

    #[test]
    fn waits_for_the_debounce_window_before_rescanning_a_changed_directory() {
        let changed_at = std::time::Instant::now();
        let deadline = directory_rescan_deadline(changed_at);

        assert!(!directory_rescan_is_due(Some(deadline), changed_at));
        assert!(directory_rescan_is_due(Some(deadline), deadline));
    }

    #[test]
    fn leaves_an_absent_autostart_registration_unchanged_when_disabled() {
        assert_eq!(autostart_action(false, false), AutoStartAction::NoChange);
        assert_eq!(autostart_action(true, false), AutoStartAction::Enable);
        assert_eq!(autostart_action(false, true), AutoStartAction::Disable);
    }

    #[test]
    fn schedules_only_enabled_sources_that_are_due() {
        let now = OffsetDateTime::parse("2026-08-07T10:30:00Z", &Rfc3339).unwrap();
        let config = AppConfig {
            online_sources: vec![
                OnlineSource {
                    id: "due".into(),
                    enabled: true,
                    next_run_at: Some("2026-08-07T10:00:00Z".into()),
                    ..OnlineSource::default()
                },
                OnlineSource {
                    id: "future".into(),
                    enabled: true,
                    next_run_at: Some("2026-08-07T11:00:00Z".into()),
                    ..OnlineSource::default()
                },
                OnlineSource {
                    id: "disabled".into(),
                    enabled: false,
                    next_run_at: Some("2026-08-07T10:00:00Z".into()),
                    ..OnlineSource::default()
                },
            ],
            ..AppConfig::default()
        };

        assert_eq!(due_source_ids(&config, now), vec!["due"]);
    }

    #[test]
    fn migrates_existing_online_images_when_the_managed_directory_changes() {
        let root = std::env::temp_dir().join(format!("zx-wallpaper-{}", Uuid::new_v4()));
        let old_directory = root.join("old");
        let new_directory = root.join("new");
        fs::create_dir_all(&old_directory).unwrap();
        let old_path = old_directory.join("wallpaper.jpg");
        fs::write(&old_path, b"wallpaper").unwrap();
        let mut config = AppConfig {
            online_directory: Some(old_directory.to_string_lossy().into_owned()),
            online_images: vec![OnlineImage {
                id: "online-1".into(),
                local_path: old_path.to_string_lossy().into_owned(),
                ..OnlineImage::default()
            }],
            favorite_paths: vec![old_path.to_string_lossy().into_owned()],
            ..AppConfig::default()
        };

        migrate_online_directory(&mut config, &new_directory).unwrap();

        let migrated_path = new_directory.join("wallpaper.jpg");
        assert!(migrated_path.is_file());
        assert!(!old_path.exists());
        assert_eq!(
            config.online_images[0].local_path,
            migrated_path.to_string_lossy()
        );
        assert!(same_path(
            &config.favorite_paths[0],
            &migrated_path.to_string_lossy()
        ));
        fs::remove_dir_all(root).unwrap();
    }
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
fn set_desktop_wallpaper(path: &Path, display_mode: &str) -> Result<(), String> {
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
fn set_desktop_wallpaper(_path: &Path, _display_mode: &str) -> Result<(), String> {
    Err("Wallpaper switching is only available on Windows.".to_string())
}

fn default_interval_minutes() -> u32 {
    30
}

fn default_display_mode() -> String {
    "fill".to_string()
}

fn default_rotation_order() -> String {
    RANDOM_ORDER.to_string()
}

fn default_follow_system_theme() -> bool {
    true
}

fn default_hide_to_tray_on_close() -> bool {
    true
}

fn default_storage_limit() -> u8 {
    5
}

fn default_minimum_resolution() -> u16 {
    1920
}
