use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::AtomicBool,
        Mutex,
    },
    time::Instant,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    domain::same_path,
    image_assets::ImageAssetManager,
    library::{collect_candidates, initial_scan, refresh_rotation_queue_for_config, request_initial_scan},
    online::{
        built_in_sources, merge_online_sources, online_storage_bytes, reconcile_online_candidates,
        sort_online_images_by_downloaded_at,
    },
    preferences::RANDOM_ORDER,
};

const STATE_FILE_NAME: &str = "wallpaper-state.json";
const PREVIEW_STRIP_SIZE: usize = 5;

#[derive(Clone)]
pub(crate) struct LibraryScan {
    pub(crate) folder_statuses: HashMap<String, FolderStatus>,
    pub(crate) candidates: Vec<String>,
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
    pub wallpaper_history: Vec<String>,
    #[serde(default)]
    pub global_next_shortcut: Option<String>,
    #[serde(default)]
    pub global_skip_shortcut: Option<String>,
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
            wallpaper_history: Vec::new(),
            global_next_shortcut: None,
            global_skip_shortcut: None,
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
pub(crate) struct FolderStatus {
    pub(crate) kind: &'static str,
    pub(crate) available_count: usize,
    pub(crate) invalid_count: usize,
    pub(crate) scanned_at: String,
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
    skip_shortcut_status: ShortcutStatus,
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
    pub(crate) folders: Option<Vec<WallpaperFolder>>,
    pub(crate) interval_minutes: Option<u32>,
    pub(crate) display_mode: Option<String>,
    pub(crate) rotation_order: Option<String>,
    pub(crate) auto_start: Option<bool>,
    pub(crate) paused: Option<bool>,
    pub(crate) follow_system_theme: Option<bool>,
    pub(crate) hide_to_tray_on_close: Option<bool>,
    pub(crate) global_next_shortcut: Option<Option<String>>,
    pub(crate) global_skip_shortcut: Option<Option<String>>,
    pub(crate) online_directory: Option<Option<String>>,
    pub(crate) online_storage_limit_gb: Option<u8>,
    pub(crate) online_minimum_resolution: Option<u16>,
}

pub struct RuntimeState {
    pub(crate) config: Mutex<AppConfig>,
    pub(crate) library_scan: Mutex<Option<LibraryScan>>,
    pub(crate) initial_scan_in_progress: AtomicBool,
    pub(crate) image_assets: ImageAssetManager,
    pub(crate) shortcut_status: Mutex<ShortcutStatus>,
    pub(crate) registered_shortcut: Mutex<Option<String>>,
    pub(crate) skip_shortcut_status: Mutex<ShortcutStatus>,
    pub(crate) registered_skip_shortcut: Mutex<Option<String>>,
    pub(crate) upx8_next_request_at: Mutex<Instant>,
    pub(crate) state_file: PathBuf,
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
            skip_shortcut_status: Mutex::new(ShortcutStatus::Disabled),
            registered_skip_shortcut: Mutex::new(None),
            upx8_next_request_at: Mutex::new(Instant::now()),
            state_file,
        })
    }
}

#[tauri::command]
pub fn get_state(app: AppHandle, state: State<'_, RuntimeState>) -> Result<AppState, String> {
    let config = lock_config(&state)?.clone();
    let scan = lock_library_scan(&state)?.clone().unwrap_or_else(|| {
        request_initial_scan(&app, &state);
        initial_scan(&config)
    });
    let (shortcut_status, skip_shortcut_status) = shortcut_statuses(&state)?;
    Ok(build_state_from_scan(
        config,
        scan,
        shortcut_status,
        skip_shortcut_status,
    ))
}

pub(crate) fn mutate<F>(app: &AppHandle, state: &RuntimeState, operation: F) -> Result<AppState, String>
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

pub(crate) fn mutate_with_cached_scan<F>(
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

pub(crate) fn commit_scanned_state(
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
    let (shortcut_status, skip_shortcut_status) = shortcut_statuses(state)?;
    let snapshot = build_state_from_scan(
        next_config.clone(),
        scan.clone(),
        shortcut_status,
        skip_shortcut_status,
    );
    *lock_library_scan(state)? = Some(scan);
    *lock_config(state)? = next_config;
    app.emit("app://state-changed", &snapshot)
        .map_err(|error| format!("Unable to publish the updated wallpaper state: {error}"))?;
    Ok(snapshot)
}

pub(crate) fn mutate_without_rescan<F>(
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
    let (shortcut_status, skip_shortcut_status) = shortcut_statuses(state)?;
    let snapshot = build_state_from_scan(
        next_config.clone(),
        scan.clone(),
        shortcut_status,
        skip_shortcut_status,
    );
    *lock_library_scan(state)? = Some(scan);
    *lock_config(state)? = next_config;
    app.emit("app://state-changed", &snapshot)
        .map_err(|error| format!("Unable to publish the updated wallpaper state: {error}"))?;
    Ok(snapshot)
}

pub(crate) fn lock_config(state: &RuntimeState) -> Result<std::sync::MutexGuard<'_, AppConfig>, String> {
    state.config.lock().map_err(|_| {
        "The wallpaper state is unavailable because another operation failed.".to_string()
    })
}

pub(crate) fn lock_library_scan(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, Option<LibraryScan>>, String> {
    state.library_scan.lock().map_err(|_| {
        "The wallpaper library scan is unavailable because another operation failed.".to_string()
    })
}

pub(crate) fn lock_shortcut_status(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, ShortcutStatus>, String> {
    state
        .shortcut_status
        .lock()
        .map_err(|_| "全局快捷键状态不可用。".to_string())
}

pub(crate) fn lock_registered_shortcut(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, Option<String>>, String> {
    state
        .registered_shortcut
        .lock()
        .map_err(|_| "全局快捷键注册状态不可用。".to_string())
}

pub(crate) fn lock_skip_shortcut_status(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, ShortcutStatus>, String> {
    state
        .skip_shortcut_status
        .lock()
        .map_err(|_| "跳过快捷键状态不可用。".to_string())
}

pub(crate) fn lock_registered_skip_shortcut(
    state: &RuntimeState,
) -> Result<std::sync::MutexGuard<'_, Option<String>>, String> {
    state
        .registered_skip_shortcut
        .lock()
        .map_err(|_| "跳过快捷键注册状态不可用。".to_string())
}

pub(crate) fn shortcut_statuses(state: &RuntimeState) -> Result<(ShortcutStatus, ShortcutStatus), String> {
    Ok((
        lock_shortcut_status(state)?.clone(),
        lock_skip_shortcut_status(state)?.clone(),
    ))
}

pub(crate) fn persist(path: &Path, config: &AppConfig) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to save wallpaper settings: {error}"))?;
    let temporary_path = path.with_extension("tmp");
    fs::write(&temporary_path, contents)
        .map_err(|error| format!("Unable to save wallpaper settings: {error}"))?;
    fs::rename(&temporary_path, path)
        .map_err(|error| format!("Unable to finalize wallpaper settings: {error}"))
}

pub(crate) fn build_state(config: AppConfig) -> AppState {
    build_state_from_scan(
        config.clone(),
        collect_candidates(&config),
        ShortcutStatus::Disabled,
        ShortcutStatus::Disabled,
    )
}

pub(crate) fn build_state_from_scan(
    config: AppConfig,
    scan: LibraryScan,
    shortcut_status: ShortcutStatus,
    skip_shortcut_status: ShortcutStatus,
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
        skip_shortcut_status,
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
