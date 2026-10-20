import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  AppConfig,
  AppState,
  DesktopRuntime,
  OnlineSource,
  TaggingStatus,
  WallpaperFolder,
  WidgetLayout,
} from "./types";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Unlisten = () => void;
type Listen = <T>(
  event: string,
  listener: (event: { payload: T }) => void,
) => Promise<Unlisten>;

export interface TauriBindings {
  invoke: Invoke;
  listen: Listen;
}

export function createTauriRuntime(bindings: TauriBindings): DesktopRuntime {
  const command = <T>(name: string, args?: Record<string, unknown>) =>
    args === undefined
      ? bindings.invoke<T>(name)
      : bindings.invoke<T>(name, args);

  return {
    getState: () => command("get_state"),
    updateConfig: (patch) => command("update_preferences", { patch }),
    addFolder: () => command("add_folder"),
    removeFolder: (folderId) => command("remove_folder", { folderId }),
    updateFolder: (folder) => command("update_folder", { folder }),
    openFolder: (folderId) => command("open_folder", { folderId }),
    rescanFolders: () => command("rescan_folders"),
    nextWallpaper: () => command("next_wallpaper", { reason: "manual" }),
    selectWallpaper: (filePath) => command("select_wallpaper", { filePath }),
    getImageAsset: (filePath, kind) => command("get_image_asset", { filePath, kind }),
    prewarmImageAssets: (filePaths, kind) => command("prewarm_image_assets", { filePaths, kind }),
    skipCurrentWallpaper: () => command("skip_current_wallpaper"),
    toggleFavorite: (filePath) => command("toggle_favorite", { filePath }),
    restoreSkippedPath: (filePath) =>
      command("restore_skipped", { filePath }),
    restoreAllSkipped: () => command("restore_all_skipped"),
    deleteSkippedPath: (filePath) => command("delete_skipped", { filePath }),
    deleteAllSkipped: () => command("delete_all_skipped"),
    togglePaused: () => command("toggle_paused"),
    updateOnlineSource: (source) => command("update_online_source", { source }),
    runOnlineSource: (sourceId) => command("run_online_source", { sourceId }),
    runUpx8Category: (categoryKey) => command("run_upx8_category", { categoryKey }),
    setOnlineImageAsWallpaper: (imageId) =>
      command("set_online_image_as_wallpaper", { imageId }),
    deleteOnlineImage: (imageId) => command("delete_online_image", { imageId }),
    selectOnlineDirectory: () => command("select_online_directory"),
    revealOnlineImage: (imageId) => command("reveal_online_image", { imageId }),
    revealWallpaper: (filePath) => command("reveal_wallpaper", { filePath }),
    getWidgetLayout: () => command("get_widget_layout"),
    setWidgetLayout: (layout: WidgetLayout) => command("set_widget_layout", { layout }),
    setTaggingEnabled: (enabled: boolean) => command("set_tagging_enabled", { enabled }),
    getTaggingStatus: () => command("get_tagging_status"),
    rescanTags: () => command("rescan_tags"),
    onStateChanged: (listener) =>
      bindings.listen<AppState>("app://state-changed", ({ payload }) =>
        listener(payload),
      ),
  };
}

export const tauriRuntime = createTauriRuntime({
  invoke: tauriInvoke,
  listen: tauriListen,
});

export type { AppConfig, AppState, DesktopRuntime, OnlineSource, TaggingStatus, WallpaperFolder, WidgetLayout };
