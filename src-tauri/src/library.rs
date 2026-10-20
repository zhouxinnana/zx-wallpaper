use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::domain::{is_supported_wallpaper, same_path};
use crate::image_assets::{ImageAsset, ImageAssetKind};
use crate::online::{now_rfc3339, prune_missing_online_images};
use crate::preferences::refresh_rotation_queue;
use crate::state::{
    build_state, build_state_from_scan, commit_scanned_state, get_state, lock_config,
    lock_library_scan, mutate, shortcut_statuses, AppState, AppConfig, FolderStatus, LibraryScan,
    RuntimeState, WallpaperFolder,
};

pub fn request_initial_scan(app: &AppHandle, state: &RuntimeState) {
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
        let (shortcut_status, skip_shortcut_status) = shortcut_statuses(&state).unwrap_or_default();
        let snapshot = build_state_from_scan(config, scan, shortcut_status, skip_shortcut_status);
        let _ = app.emit("app://state-changed", &snapshot);
    });
}

#[tauri::command]
pub fn add_folder(
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

pub(crate) fn rescan_config(config: &mut AppConfig) {
    prune_missing_favorite_paths(config);
    let scan = collect_candidates(config);
    refresh_rotation_queue_for_config(config, &scan.candidates);
}

pub(crate) fn refresh_rotation_queue_for_config(config: &mut AppConfig, candidates: &[String]) {
    config.remaining_paths = refresh_rotation_queue(
        &config.rotation_order,
        &config.remaining_paths,
        candidates,
        &config.skipped_paths,
        config.current_path.as_deref(),
    );
}

pub(crate) fn collect_candidates(config: &AppConfig) -> LibraryScan {
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

fn prune_missing_favorite_paths(config: &mut AppConfig) {
    config.favorite_paths.retain(|path| {
        let path = Path::new(path);
        path.is_file() && is_supported_wallpaper(path)
    });
}

pub(crate) fn initial_scan(config: &AppConfig) -> LibraryScan {
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

fn open_folder_path<'a>(config: &'a AppConfig, folder_id: &str) -> Option<&'a str> {
    config
        .folders
        .iter()
        .find(|folder| folder.id == folder_id && folder.id != "online-library")
        .map(|folder| folder.path.as_str())
}

fn inspect_folders(folders: &[WallpaperFolder]) -> (HashMap<String, FolderStatus>, Vec<String>) {
    let mut statuses = HashMap::new();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    for folder in folders {
        let path = Path::new(&folder.path);
        let scanned_at = now_rfc3339();
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

#[cfg(test)]
mod tests {
    use super::{
        initial_scan, inspect_folders, merge_candidate_paths, open_folder_path,
        prune_missing_favorite_paths, same_path,
    };
    use crate::state::{AppConfig, OnlineImage, WallpaperFolder};
    use std::fs;
    use uuid::Uuid;

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
}
