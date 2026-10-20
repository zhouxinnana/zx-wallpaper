use std::{
    collections::HashSet,
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration as StdDuration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as AutoStartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use time::OffsetDateTime;

use crate::{
    library::rescan_config,
    online::{due_source_ids, run_online_source_impl},
    state::{
        lock_config, lock_registered_shortcut, lock_registered_skip_shortcut, lock_shortcut_status,
        lock_skip_shortcut_status, mutate, mutate_with_cached_scan, mutate_without_rescan,
        AppConfig, RuntimeState, ShortcutStatus,
    },
    wallpaper::{is_switch_due, skip_current_wallpaper_config, switch_to_next_wallpaper},
};

const DIRECTORY_RESCAN_DEBOUNCE: StdDuration = StdDuration::from_millis(500);

#[derive(Debug, PartialEq, Eq)]
struct DirectoryWatchChanges {
    to_unwatch: Vec<PathBuf>,
    to_watch: Vec<PathBuf>,
}

pub(crate) fn start_background_tasks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let state = app.state::<RuntimeState>();
            run_due_tasks(&app, &state).await;
        }
    });
}

pub(crate) fn start_directory_watcher(app: AppHandle) {
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
                // 智能分类增量打标：重扫后把新增未打标图片入队（未启用时为空操作）。
                crate::tagging::enqueue_pending(&state);
                pending_rescan = None;
            }
        }
    });
}

pub(crate) fn synchronize_system_integration(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let config = lock_config(&state)?.clone();
    synchronize_autostart(app, config.auto_start)?;
    let requested = config.global_next_shortcut.as_deref();
    match replace_global_shortcut(app, None, requested, trigger_next_wallpaper) {
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
    let requested = config.global_skip_shortcut.as_deref();
    match replace_global_shortcut(app, None, requested, skip_current_wallpaper_from_system) {
        Ok((status, registered)) => {
            *lock_skip_shortcut_status(&state)? = status;
            *lock_registered_skip_shortcut(&state)? = registered;
        }
        Err(message) => {
            *lock_skip_shortcut_status(&state)? = ShortcutStatus::Error {
                shortcut: requested.unwrap_or_default().to_string(),
                message,
            };
        }
    }
    Ok(())
}

pub(crate) fn synchronize_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
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

pub(crate) fn replace_global_shortcut(
    app: &AppHandle,
    active_shortcut: Option<&str>,
    requested_shortcut: Option<&str>,
    action: fn(&AppHandle),
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
        .on_shortcut(shortcut, move |app, _, event| {
            if event.state == ShortcutState::Pressed {
                action(app);
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

pub(crate) fn hide_to_tray_on_close(app: &AppHandle) -> bool {
    app.state::<RuntimeState>()
        .config
        .lock()
        .map(|config| config.hide_to_tray_on_close)
        .unwrap_or(true)
}

pub(crate) fn trigger_next_wallpaper(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let _ = mutate_with_cached_scan(app, &state, switch_to_next_wallpaper);
}

pub(crate) fn skip_current_wallpaper_from_system(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let _ = mutate_with_cached_scan(app, &state, skip_current_wallpaper_config);
}

pub(crate) fn toggle_paused_from_system(app: &AppHandle) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn watches_only_enabled_local_wallpaper_directories() {
        let config = AppConfig {
            folders: vec![
                crate::state::WallpaperFolder {
                    id: "enabled".into(),
                    path: "D:\\Wallpapers".into(),
                    enabled: true,
                },
                crate::state::WallpaperFolder {
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
}
