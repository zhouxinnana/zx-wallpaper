use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
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
    domain::{is_supported_wallpaper, refresh_remaining_paths, take_next_path},
    online,
};

const STATE_FILE_NAME: &str = "wallpaper-state.json";
const DIRECTORY_RESCAN_DEBOUNCE: StdDuration = StdDuration::from_millis(500);
const ONLINE_THUMBNAIL_MAX_WIDTH: u32 = 360;
const ONLINE_THUMBNAIL_MAX_HEIGHT: u32 = 200;
const ONLINE_THUMBNAIL_CACHE_CAPACITY: usize = 96;
const CURRENT_PREVIEW_MAX_WIDTH: u32 = 960;
const CURRENT_PREVIEW_MAX_HEIGHT: u32 = 540;
const PREVIEW_STRIP_SIZE: usize = 5;

#[derive(Debug, PartialEq, Eq)]
struct DirectoryWatchChanges {
    to_unwatch: Vec<PathBuf>,
    to_watch: Vec<PathBuf>,
}

#[derive(Default)]
struct ThumbnailWarmQueue {
    paths: VecDeque<PathBuf>,
    active: bool,
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
    pub kind: String,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub folders: Vec<WallpaperFolder>,
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "default_follow_system_theme")]
    pub follow_system_theme: bool,
    #[serde(default)]
    pub current_path: Option<String>,
    #[serde(default)]
    pub remaining_paths: Vec<String>,
    #[serde(default)]
    pub skipped_paths: Vec<String>,
    #[serde(default)]
    pub global_next_shortcut: Option<String>,
    #[serde(default)]
    pub last_switch_at: Option<String>,
    #[serde(default)]
    pub online_sources: Vec<OnlineSource>,
    #[serde(default)]
    pub online_images: Vec<OnlineImage>,
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
            auto_start: false,
            paused: false,
            follow_system_theme: default_follow_system_theme(),
            current_path: None,
            remaining_paths: Vec::new(),
            skipped_paths: Vec::new(),
            global_next_shortcut: None,
            last_switch_at: None,
            online_sources: built_in_sources(),
            online_images: Vec::new(),
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
    auto_start: Option<bool>,
    paused: Option<bool>,
    follow_system_theme: Option<bool>,
    global_next_shortcut: Option<Option<String>>,
    online_directory: Option<Option<String>>,
    online_storage_limit_gb: Option<u8>,
    online_minimum_resolution: Option<u16>,
}

pub struct RuntimeState {
    config: Mutex<AppConfig>,
    library_scan: Mutex<Option<LibraryScan>>,
    initial_scan_in_progress: AtomicBool,
    thumbnail_cache: Mutex<HashMap<String, String>>,
    thumbnail_warm_queue: Arc<Mutex<ThumbnailWarmQueue>>,
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
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let imported = legacy_settings_file()
                    .and_then(|path| fs::read_to_string(path).ok())
                    .and_then(|contents| parse_legacy_config(&contents).ok());
                if let Some(config) = imported {
                    persist(&state_file, &config)?;
                    config
                } else {
                    AppConfig::default()
                }
            }
            Err(error) => return Err(format!("Unable to read saved wallpaper settings: {error}")),
        };
        config.online_sources = merge_online_sources(config.online_sources);

        Ok(Self {
            config: Mutex::new(config),
            library_scan: Mutex::new(None),
            initial_scan_in_progress: AtomicBool::new(false),
            thumbnail_cache: Mutex::new(HashMap::new()),
            thumbnail_warm_queue: Arc::new(Mutex::new(ThumbnailWarmQueue::default())),
            state_file,
        })
    }
}

fn legacy_settings_file() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|directory| directory.join("ZX Wallpaper").join("settings.json"))
}

fn parse_legacy_config(contents: &str) -> Result<AppConfig, String> {
    serde_json::from_str(contents)
        .map_err(|error| format!("Unable to import Electron wallpaper settings: {error}"))
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
        let snapshot = build_state_from_scan(config, scan);
        let _ = app.emit("app://state-changed", &snapshot);
    });
}

pub fn synchronize_system_integration(app: &AppHandle) -> Result<(), String> {
    let config = lock_config(&app.state::<RuntimeState>())?.clone();
    synchronize_autostart(app, config.auto_start)?;
    synchronize_global_shortcut(app, config.global_next_shortcut.as_deref())
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

fn synchronize_global_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister_all()
        .map_err(|error| format!("无法更新全局快捷键: {error}"))?;
    let Some(shortcut) = shortcut else {
        return Ok(());
    };
    shortcuts
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                trigger_next_wallpaper(app);
            }
        })
        .map_err(|error| format!("无法注册全局快捷键: {error}"))
}

pub fn trigger_next_wallpaper(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let _ = mutate(app, &state, switch_to_next_wallpaper);
}

pub fn toggle_paused_from_system(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let _ = mutate(app, &state, |config| {
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
        let _ = mutate(app, state, |config| {
            if is_switch_due(config, now) {
                switch_to_next_wallpaper(config)
            } else {
                Ok(())
            }
        });
    }

    for source_id in source_ids {
        let _ = run_online_source_impl(app, state, source_id).await;
    }
}

fn built_in_sources() -> Vec<OnlineSource> {
    [
        (
            "bing-cn-4k",
            "必应每日壁纸 4K",
            "https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN",
        ),
        (
            "ltyuanfang-scenery",
            "远方风景 4K",
            "https://tu.ltyuanfang.cn/api/fengjing.php",
        ),
        (
            "upx8-4k",
            "UPX8 综合壁纸 4K",
            "https://wp.upx8.com/api.php?format=json",
        ),
        (
            "wallhaven-clbug-sfw",
            "Wallhaven SFW 国内镜像",
            "https://wallhaven.clbug.com/api/v1/search?purity=100&sorting=random",
        ),
        ("bing-ioliu", "Bing 壁纸国内镜像", "https://bing.ioliu.cn/"),
    ]
    .into_iter()
    .map(|(id, name, url)| OnlineSource {
        id: id.to_string(),
        name: name.to_string(),
        kind: "builtin".to_string(),
        url: url.to_string(),
        enabled: false,
        interval_hours: 24,
        last_run_at: None,
        next_run_at: None,
        last_discovered: 0,
        last_downloaded: 0,
        last_error: None,
        category_statuses: Vec::new(),
    })
    .collect()
}

fn merge_online_sources(saved: Vec<OnlineSource>) -> Vec<OnlineSource> {
    let mut saved_by_id: HashMap<_, _> = saved
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();
    let mut merged: Vec<_> = built_in_sources()
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
                builtin.category_statuses = saved.category_statuses.clone();
            }
            builtin
        })
        .collect();
    merged.extend(saved.into_iter().filter(|source| source.kind == "custom"));
    merged
}

#[tauri::command]
pub fn get_state(app: AppHandle, state: State<'_, RuntimeState>) -> Result<AppState, String> {
    let config = lock_config(&state)?.clone();
    let scan = lock_library_scan(&state)?.clone().unwrap_or_else(|| {
        request_initial_scan(&app, &state);
        initial_scan(&config)
    });
    Ok(build_state_from_scan(config, scan))
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
    mutate(&app, &state, |config| switch_to_next_wallpaper(config))
}

#[tauri::command]
pub fn select_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    file_path: String,
) -> Result<AppState, String> {
    mutate(&app, &state, move |config| select_wallpaper_path(config, &file_path))
}

#[tauri::command]
pub fn skip_current_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    mutate(&app, &state, |config| {
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
    mutate(&app, &state, move |config| {
        delete_skipped_file(config, &file_path)
    })
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
    patch: ConfigPatch,
) -> Result<AppState, String> {
    if let Some(auto_start) = patch.auto_start {
        synchronize_autostart(&app, auto_start)?;
    }
    if let Some(global_next_shortcut) = patch.global_next_shortcut.as_ref() {
        synchronize_global_shortcut(&app, global_next_shortcut.as_deref())?;
    }
    mutate(&app, &state, move |config| {
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
        if let Some(auto_start) = patch.auto_start {
            config.auto_start = auto_start;
        }
        if let Some(paused) = patch.paused {
            config.paused = paused;
        }
        if let Some(follow_system_theme) = patch.follow_system_theme {
            config.follow_system_theme = follow_system_theme;
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
        rescan_config(config);
        Ok(())
    })
}

#[tauri::command]
pub async fn add_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    url: String,
) -> Result<AppState, String> {
    let parsed = online::validate_public_https_url(&url).await?;
    let hostname = parsed.host_str().unwrap_or("在线来源").to_string();

    mutate_without_rescan(&app, &state, move |config| {
        if config.online_sources.iter().any(|source| source.url == url) {
            return Err("该在线来源已经存在。".to_string());
        }
        config.online_sources.push(OnlineSource {
            id: Uuid::new_v4().to_string(),
            name: hostname,
            kind: "custom".to_string(),
            url,
            enabled: true,
            interval_hours: 24,
            last_run_at: None,
            next_run_at: None,
            last_discovered: 0,
            last_downloaded: 0,
            last_error: None,
            category_statuses: Vec::new(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn update_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source: OnlineSource,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        let saved = config
            .online_sources
            .iter_mut()
            .find(|saved| saved.id == source.id)
            .ok_or_else(|| "该在线来源已不存在。".to_string())?;
        *saved = source;
        Ok(())
    })
}

#[tauri::command]
pub fn remove_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source_id: String,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        let count = config.online_sources.len();
        config
            .online_sources
            .retain(|source| source.id != source_id);
        if config.online_sources.len() == count {
            return Err("该在线来源已不存在。".to_string());
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn run_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source_id: String,
) -> Result<AppState, String> {
    run_online_source_impl(&app, &state, source_id).await
}

async fn run_online_source_impl(
    app: &AppHandle,
    state: &RuntimeState,
    source_id: String,
) -> Result<AppState, String> {
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
    if !source.enabled {
        return Err("该在线来源当前已禁用。".to_string());
    }

    let fetched =
        match online::fetch_source_candidates(&source.id, &source.url, minimum_resolution).await {
            Ok(candidates) => candidates,
            Err(error) => {
                let message = error.clone();
                let _ = mutate_without_rescan(app, state, move |config| {
                    update_source_result(config, &source_id, 0, 0, Some(message));
                    Ok(())
                });
                return Err(error);
            }
        };

    let candidates = fetched.candidates;
    let category_results = fetched.categories;
    let mut seen = known_urls;
    let mut downloaded = Vec::new();
    let mut downloaded_categories = Vec::new();
    let mut downloaded_bytes = 0;
    for candidate in candidates.iter().cloned() {
        if seen.contains(&candidate.image_url) || storage_bytes + downloaded_bytes >= storage_limit
        {
            continue;
        }
        let category_key = candidate.category_key.clone();
        if let Ok(image) =
            online::download_candidate(candidate, &directory, minimum_resolution).await
        {
            downloaded_bytes += image.byte_length;
            seen.insert(image.image_url.clone());
            downloaded.push(image);
            downloaded_categories.push(category_key);
        }
    }

    let discovered = candidates.len();
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
        if source_id == "upx8-4k" {
            let mut statuses: Vec<OnlineSourceCategoryStatus> = category_results
                .into_iter()
                .map(|category| OnlineSourceCategoryStatus {
                    key: category.key,
                    label: category.label,
                    discovered: category.discovered,
                    downloaded: 0,
                    last_error: category.error,
                })
                .collect();
            for category in downloaded_categories.into_iter().flatten() {
                if let Some(status) = statuses.iter_mut().find(|status| status.key == category) {
                    status.downloaded += 1;
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
        update_source_result(config, &source_id, discovered, downloaded_count, None);
        Ok(())
    })
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
    tauri::async_runtime::spawn_blocking(move || fs::remove_file(path))
        .await
        .map_err(|error| format!("删除在线图片任务中断: {error}"))?
        .map_err(|error| format!("无法删除在线图片: {error}"))?;
    mutate_without_rescan(&app, &state, move |config| {
        config.online_images.retain(|image| image.id != image_id);
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
pub async fn get_online_thumbnail(
    state: State<'_, RuntimeState>,
    image_id: String,
) -> Result<Option<String>, String> {
    let image = lock_config(&state)?
        .online_images
        .iter()
        .find(|image| image.id == image_id)
        .cloned();
    let Some(image) = image else {
        return Ok(None);
    };
    if let Some(thumbnail) = lock_thumbnail_cache(&state)?
        .get(&image.local_path)
        .cloned()
    {
        return Ok(Some(thumbnail));
    }

    let thumbnail_directory = thumbnail_cache_directory(&state);
    let image_path = PathBuf::from(&image.local_path);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        load_or_create_thumbnail(&thumbnail_directory, &image_path)
    })
    .await
    .map_err(|error| format!("Unable to prepare the online thumbnail: {error}"))?;
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let thumbnail = format!("data:image/jpeg;base64,{}", encode_base64(&bytes));
    let mut cache = lock_thumbnail_cache(&state)?;
    if cache.len() >= ONLINE_THUMBNAIL_CACHE_CAPACITY {
        if let Some(path) = cache.keys().next().cloned() {
            cache.remove(&path);
        }
    }
    cache.insert(image.local_path, thumbnail.clone());
    Ok(Some(thumbnail))
}

#[tauri::command]
pub async fn get_preview_thumbnail(
    state: State<'_, RuntimeState>,
    file_path: String,
) -> Result<Option<String>, String> {
    let image_path = PathBuf::from(&file_path);
    if !image_path.is_file() || !is_supported_wallpaper(&image_path) {
        return Ok(None);
    }
    if let Some(thumbnail) = lock_thumbnail_cache(&state)?.get(&file_path).cloned() {
        return Ok(Some(thumbnail));
    }

    let thumbnail_directory = thumbnail_cache_directory(&state);
    let cache_key = file_path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        load_or_create_thumbnail(&thumbnail_directory, &image_path)
    })
    .await
    .map_err(|error| format!("Unable to prepare the preview thumbnail: {error}"))?;
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let thumbnail = format!("data:image/jpeg;base64,{}", encode_base64(&bytes));
    let mut cache = lock_thumbnail_cache(&state)?;
    if cache.len() >= ONLINE_THUMBNAIL_CACHE_CAPACITY {
        if let Some(path) = cache.keys().next().cloned() {
            cache.remove(&path);
        }
    }
    cache.insert(cache_key, thumbnail.clone());
    Ok(Some(thumbnail))
}

#[tauri::command]
pub fn prewarm_online_thumbnails(
    state: State<'_, RuntimeState>,
    image_ids: Vec<String>,
) -> Result<(), String> {
    if image_ids.is_empty() {
        return Ok(());
    }
    let known_paths: HashMap<_, _> = lock_config(&state)?
        .online_images
        .iter()
        .map(|image| (image.id.clone(), PathBuf::from(&image.local_path)))
        .collect();
    let paths = image_ids
        .into_iter()
        .filter_map(|image_id| known_paths.get(&image_id).cloned())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(());
    }

    let queue = Arc::clone(&state.thumbnail_warm_queue);
    let should_start = {
        let mut pending = queue.lock().map_err(|_| {
            "The wallpaper thumbnail warm queue is unavailable because another operation failed."
                .to_string()
        })?;
        pending.paths.extend(paths);
        if pending.active {
            false
        } else {
            pending.active = true;
            true
        }
    };
    if !should_start {
        return Ok(());
    }

    let thumbnail_directory = thumbnail_cache_directory(&state);
    thread::spawn(move || run_thumbnail_warm_queue(queue, thumbnail_directory));
    Ok(())
}

#[tauri::command]
pub fn get_skipped_thumbnail(file_path: String) -> Result<Option<String>, String> {
    Ok(image_data_url(
        Path::new(&file_path),
        mime_type_for_path(Path::new(&file_path)),
    ))
}

fn image_data_url(path: &Path, mime_type: &str) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| format!("data:{mime_type};base64,{}", encode_base64(&bytes)))
}

fn thumbnail_jpeg_bytes(path: &Path) -> Option<Vec<u8>> {
    jpeg_bytes(path, ONLINE_THUMBNAIL_MAX_WIDTH, ONLINE_THUMBNAIL_MAX_HEIGHT)
}

fn preview_image_data_url(path: &Path) -> Option<String> {
    let bytes = jpeg_bytes(path, CURRENT_PREVIEW_MAX_WIDTH, CURRENT_PREVIEW_MAX_HEIGHT)?;
    Some(format!("data:image/jpeg;base64,{}", encode_base64(&bytes)))
}

fn jpeg_bytes(path: &Path, max_width: u32, max_height: u32) -> Option<Vec<u8>> {
    let image = image::open(path).ok()?.thumbnail(max_width, max_height);
    let mut bytes = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 72)
        .encode_image(&image)
        .ok()?;
    Some(bytes.into_inner())
}

fn thumbnail_cache_directory(state: &RuntimeState) -> PathBuf {
    state
        .state_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("thumbnail-cache")
}

fn load_or_create_thumbnail(cache_directory: &Path, original_path: &Path) -> Option<Vec<u8>> {
    let cache_path = cache_directory.join(thumbnail_cache_file_name(original_path));
    if let Ok(bytes) = fs::read(&cache_path) {
        return Some(bytes);
    }

    let bytes = thumbnail_jpeg_bytes(original_path)?;
    if fs::create_dir_all(cache_directory).is_ok() {
        let _ = fs::write(cache_path, &bytes);
    }
    Some(bytes)
}

fn run_thumbnail_warm_queue(queue: Arc<Mutex<ThumbnailWarmQueue>>, cache_directory: PathBuf) {
    loop {
        let next_path = match queue.lock() {
            Ok(mut pending) => match pending.paths.pop_front() {
                Some(path) => Some(path),
                None => {
                    pending.active = false;
                    None
                }
            },
            Err(_) => None,
        };
        let Some(path) = next_path else {
            return;
        };
        let _ = load_or_create_thumbnail(&cache_directory, &path);
    }
}

fn thumbnail_cache_file_name(path: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in path.to_string_lossy().to_ascii_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.jpg")
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(TABLE[((value >> 18) & 63) as usize] as char);
        encoded.push(TABLE[((value >> 12) & 63) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    encoded
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

fn commit_scanned_state(
    app: &AppHandle,
    state: &RuntimeState,
    mut next_config: AppConfig,
    scan: LibraryScan,
) -> Result<AppState, String> {
    next_config.remaining_paths = refresh_remaining_paths(
        &next_config.remaining_paths,
        &scan.candidates,
        &next_config.skipped_paths,
        next_config.current_path.as_deref(),
    );
    persist(&state.state_file, &next_config)?;
    let snapshot = build_state_from_scan(next_config.clone(), scan.clone());
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
    next_config.remaining_paths = refresh_remaining_paths(
        &next_config.remaining_paths,
        &scan.candidates,
        &next_config.skipped_paths,
        next_config.current_path.as_deref(),
    );
    persist(&state.state_file, &next_config)?;
    let snapshot = build_state_from_scan(next_config.clone(), scan.clone());
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

fn lock_thumbnail_cache(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, String>>, String> {
    state.thumbnail_cache.lock().map_err(|_| {
        "The wallpaper thumbnail cache is unavailable because another operation failed.".to_string()
    })
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
    build_state_from_scan(config.clone(), collect_candidates(&config))
}

fn build_state_from_scan(config: AppConfig, scan: LibraryScan) -> AppState {
    let online_storage_bytes = online_storage_bytes(&config);
    let preview_url = config
        .current_path
        .as_ref()
        .and_then(|path| preview_image_data_url(Path::new(path)));
    let preview_items = build_preview_items(&config, &scan);

    AppState {
        config,
        available_count: scan.candidates.len(),
        preview_url,
        preview_items,
        folder_statuses: scan.folder_statuses,
        online_storage_bytes,
        global_shortcut_registered: false,
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
    let scan = collect_candidates(config);
    config.remaining_paths = refresh_remaining_paths(
        &config.remaining_paths,
        &scan.candidates,
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
    rescan_config(config);
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
    rescan_config(config);
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
    rescan_config(config);
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
                    if image::open(entry.path()).is_ok() {
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
    fn creates_a_bounded_jpeg_thumbnail_for_an_online_image() {
        let path =
            std::env::temp_dir().join(format!("zx-wallpaper-thumbnail-{}.png", Uuid::new_v4()));
        let original = image::RgbImage::from_pixel(1200, 800, image::Rgb([32, 64, 128]));
        original
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();

        let thumbnail = thumbnail_jpeg_bytes(&path).expect("expected JPEG thumbnail bytes");
        let decoded =
            image::load_from_memory(&thumbnail).expect("expected decodable JPEG thumbnail");

        assert_eq!(
            image::guess_format(&thumbnail).unwrap(),
            image::ImageFormat::Jpeg
        );
        assert!(decoded.width() <= 360);
        assert!(decoded.height() <= 200);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_a_saved_thumbnail_when_the_original_is_unavailable() {
        let directory = std::env::temp_dir().join(format!("zx-wallpaper-cache-{}", Uuid::new_v4()));
        let original_path = directory.join("original.png");
        fs::create_dir_all(&directory).unwrap();
        image::RgbImage::from_pixel(1200, 800, image::Rgb([32, 64, 128]))
            .save_with_format(&original_path, image::ImageFormat::Png)
            .unwrap();

        let thumbnail = load_or_create_thumbnail(&directory.join("thumbnails"), &original_path)
            .expect("expected thumbnail to be created");
        fs::remove_file(&original_path).unwrap();

        let cached = load_or_create_thumbnail(&directory.join("thumbnails"), &original_path)
            .expect("expected thumbnail to be read from disk cache");

        assert_eq!(cached, thumbnail);
        let _ = fs::remove_dir_all(directory);
    }

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
    fn merges_builtin_sources_without_losing_saved_preferences() {
        let saved = OnlineSource {
            id: "upx8-4k".into(),
            enabled: true,
            interval_hours: 6,
            last_downloaded: 3,
            ..OnlineSource::default()
        };
        let sources = merge_online_sources(vec![saved]);
        assert_eq!(sources.len(), 5);
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
    fn imports_supported_fields_from_an_electron_settings_copy() {
        let config = parse_legacy_config(
            r#"{
              "folders": [{"id":"local","path":"D:\\Wallpapers","enabled":true}],
              "intervalMinutes": 60,
              "displayMode": "fit",
              "paused": true,
              "globalNextShortcut": "Ctrl+Alt+N"
            }"#,
        )
        .unwrap();

        assert_eq!(config.folders.len(), 1);
        assert_eq!(config.interval_minutes, 60);
        assert_eq!(config.display_mode, "fit");
        assert!(config.paused);
        assert_eq!(config.global_next_shortcut.as_deref(), Some("Ctrl+Alt+N"));
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

fn default_follow_system_theme() -> bool {
    true
}

fn default_storage_limit() -> u8 {
    5
}

fn default_minimum_resolution() -> u16 {
    1920
}
