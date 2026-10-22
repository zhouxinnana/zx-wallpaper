use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::domain::{is_supported_wallpaper, same_path};
use crate::image_assets::{ImageAsset, ImageAssetKind};
use crate::online::{now_rfc3339, prune_missing_online_images};
use crate::preferences::refresh_rotation_queue;
use crate::state::{
    build_state, build_state_from_scan, commit_scanned_state, get_state, lock_config,
    lock_library_scan, mutate, shortcut_statuses, AppState, AppConfig, FolderStatus, LibraryImage,
    LibraryScan, RuntimeState, WallpaperFolder,
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
    let (folder_statuses, local_paths, library_images) = inspect_folders(&config.folders);
    let online_paths = config
        .online_images
        .iter()
        .filter(|image| Path::new(&image.local_path).is_file())
        .map(|image| image.local_path.clone())
        .collect();
    LibraryScan {
        folder_statuses,
        candidates: merge_candidate_paths(local_paths, online_paths),
        library_images,
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
        // 首扫不枚举本地目录（与既有行为一致），图库在首次完整扫描后才可见本地图。
        library_images: Vec::new(),
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

fn inspect_folders(
    folders: &[WallpaperFolder],
) -> (
    HashMap<String, FolderStatus>,
    Vec<String>,
    Vec<LibraryImage>,
) {
    let mut statuses = HashMap::new();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut library_seen = HashSet::new();
    let mut library_images = Vec::new();

    for folder in folders {
        let path = Path::new(&folder.path);
        let scanned_at = now_rfc3339();
        // 图库的「按时间排序」需要文件修改时间；这里顺带用 WalkDir 已读到的元数据，
        // 不再额外 stat（千张目录多一次 stat 就是千次系统调用）。
        let mut modified_at_by_path: HashMap<String, String> = HashMap::new();
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
                        let resolved = entry.path().to_string_lossy().into_owned();
                        if let Some(stamp) = entry
                            .metadata()
                            .ok()
                            .and_then(|metadata| metadata.modified().ok())
                            .and_then(|modified| {
                                OffsetDateTime::from(modified).format(&Rfc3339).ok()
                            })
                        {
                            modified_at_by_path.insert(resolved.to_ascii_lowercase(), stamp);
                        }
                        Some(resolved)
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

        // 图库归属：停用目录的图片也可见，但只归属到首个出现的目录。
        for path in &paths {
            if library_seen.insert(path.to_ascii_lowercase()) {
                library_images.push(LibraryImage {
                    path: path.clone(),
                    folder_id: folder.id.clone(),
                    folder_enabled: folder.enabled,
                    modified_at: modified_at_by_path
                        .get(&path.to_ascii_lowercase())
                        .cloned(),
                });
            }
        }

        if folder.enabled {
            for candidate in paths {
                if seen.insert(candidate.to_ascii_lowercase()) {
                    candidates.push(candidate);
                }
            }
        }
        statuses.insert(folder.id.clone(), status);
    }

    (statuses, candidates, library_images)
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

        let (statuses, candidates, library_images) = inspect_folders(&[folder]);
        let status = statuses.get("test-folder").unwrap();

        assert_eq!(status.kind, "available");
        assert_eq!(status.available_count, 1);
        assert_eq!(status.invalid_count, 1);
        assert!(!status.scanned_at.is_empty());
        assert_eq!(candidates, vec![valid_path.to_string_lossy().into_owned()]);
        assert_eq!(library_images.len(), 1);
        assert_eq!(library_images[0].path, valid_path.to_string_lossy());
        assert_eq!(library_images[0].folder_id, "test-folder");
        assert!(library_images[0].folder_enabled);
        // 图库按时间排序依赖它，扫描时必须带出文件修改时间。
        assert!(
            library_images[0]
                .modified_at
                .as_deref()
                .is_some_and(|stamp| !stamp.is_empty()),
            "scan should record the file modification time"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn library_images_cover_disabled_folders_while_candidates_only_keep_enabled_ones() {
        let enabled_dir =
            std::env::temp_dir().join(format!("zx-wallpaper-enabled-{}", Uuid::new_v4()));
        let disabled_dir =
            std::env::temp_dir().join(format!("zx-wallpaper-disabled-{}", Uuid::new_v4()));
        fs::create_dir_all(&enabled_dir).unwrap();
        fs::create_dir_all(&disabled_dir).unwrap();
        let enabled_path = enabled_dir.join("enabled.png");
        let disabled_path = disabled_dir.join("disabled.png");
        for path in [&enabled_path, &disabled_path] {
            image::RgbImage::from_pixel(10, 10, image::Rgb([32, 64, 128]))
                .save_with_format(path, image::ImageFormat::Png)
                .unwrap();
        }

        let folders = vec![
            WallpaperFolder {
                id: "enabled-folder".into(),
                path: enabled_dir.to_string_lossy().into_owned(),
                enabled: true,
            },
            WallpaperFolder {
                id: "disabled-folder".into(),
                path: disabled_dir.to_string_lossy().into_owned(),
                enabled: false,
            },
        ];

        let (statuses, candidates, library_images) = inspect_folders(&folders);

        assert_eq!(candidates, vec![enabled_path.to_string_lossy().into_owned()]);
        assert_eq!(statuses.get("disabled-folder").unwrap().available_count, 1);
        assert_eq!(library_images.len(), 2);
        let disabled = library_images
            .iter()
            .find(|image| image.folder_id == "disabled-folder")
            .unwrap();
        assert_eq!(disabled.path, disabled_path.to_string_lossy());
        assert!(!disabled.folder_enabled);

        let _ = fs::remove_dir_all(enabled_dir);
        let _ = fs::remove_dir_all(disabled_dir);
    }

    #[test]
    fn library_images_keep_the_first_folder_ownership_for_a_duplicated_path() {
        let first_dir = std::env::temp_dir().join(format!("zx-wallpaper-first-{}", Uuid::new_v4()));
        // 第二个目录是第一个目录的子目录：递归扫描会让同一张图落在两个目录之下。
        let second_dir = first_dir.join("nested");
        fs::create_dir_all(&second_dir).unwrap();
        let shared_path = first_dir.join("shared.png");
        image::RgbImage::from_pixel(10, 10, image::Rgb([32, 64, 128]))
            .save_with_format(&shared_path, image::ImageFormat::Png)
            .unwrap();

        let folders = vec![
            WallpaperFolder {
                id: "first-folder".into(),
                path: first_dir.to_string_lossy().into_owned(),
                enabled: true,
            },
            WallpaperFolder {
                id: "second-folder".into(),
                path: second_dir.to_string_lossy().into_owned(),
                enabled: true,
            },
        ];

        let (_, candidates, library_images) = inspect_folders(&folders);

        assert_eq!(candidates.len(), 1);
        assert_eq!(library_images.len(), 1);
        assert_eq!(library_images[0].folder_id, "first-folder");
        assert_eq!(library_images[0].path, shared_path.to_string_lossy());

        let _ = fs::remove_dir_all(first_dir);
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
