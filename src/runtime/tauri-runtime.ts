import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheckUpdate } from "@tauri-apps/plugin-updater";
import type {
  AppConfig,
  AppState,
  AppUpdateInfo,
  AppUpdateProgress,
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

/** 更新插件的下载事件（与 `@tauri-apps/plugin-updater` 的 DownloadEvent 同形）。 */
export type UpdaterDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** `check()` 返回的待安装更新；只保留 runtime 需要的面，便于测试注入 fake。 */
export interface PendingUpdateBinding {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall(
    onEvent: (event: UpdaterDownloadEvent) => void,
  ): Promise<void>;
}

/** 更新能力的底层依赖。缺省时才走真实 Tauri 插件，测试可整体替换。 */
export interface UpdaterBindings {
  check(): Promise<PendingUpdateBinding | null>;
  relaunch(): Promise<void>;
}

const defaultUpdater: UpdaterBindings = {
  check: () => tauriCheckUpdate({ timeout: 15_000 }),
  relaunch: () => tauriRelaunch(),
};

export interface TauriBindings {
  invoke: Invoke;
  listen: Listen;
  /** 可选：更新依赖。不传则用真实插件。 */
  updater?: UpdaterBindings;
}

export function createTauriRuntime(bindings: TauriBindings): DesktopRuntime {
  const updater = bindings.updater ?? defaultUpdater;
  /** 检查到的待安装更新：安装时复用，避免再发一次清单请求。 */
  let pendingUpdate: PendingUpdateBinding | null = null;
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
    batchSkipPaths: (paths) => command("batch_skip_paths", { paths }),
    batchRestoreSkipped: (paths) => command("batch_restore_skipped", { paths }),
    batchFavorite: (paths, favorite) => command("batch_favorite", { paths, favorite }),
    batchDeletePaths: (paths) => command("batch_delete_paths", { paths }),
    togglePaused: () => command("toggle_paused"),
    updateOnlineSource: (source) => command("update_online_source", { source }),
    runOnlineSource: (sourceId) => command("run_online_source", { sourceId }),
    runUpx8Category: (categoryKey) => command("run_upx8_category", { categoryKey }),
    setOnlineImageAsWallpaper: (imageId) =>
      command("set_online_image_as_wallpaper", { imageId }),
    deleteOnlineImage: (imageId) => command("delete_online_image", { imageId }),
    clearExcludedImageUrls: () => command("clear_excluded_image_urls"),
    removeExcludedImageUrl: (url) => command("remove_excluded_image_url", { url }),
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
    checkUpdate: async (): Promise<AppUpdateInfo | null> => {
      pendingUpdate = await updater.check();
      if (!pendingUpdate) return null;
      return {
        version: pendingUpdate.version,
        currentVersion: pendingUpdate.currentVersion,
        notes: pendingUpdate.body ?? null,
        date: pendingUpdate.date ?? null,
      };
    },
    installUpdate: async (onProgress?: (progress: AppUpdateProgress) => void) => {
      const update = pendingUpdate ?? (await updater.check());
      if (!update) throw new Error("没有可安装的更新，请重新检查。");
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          onProgress?.({ downloaded, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          onProgress?.({ downloaded, total });
        }
      });
      pendingUpdate = null;
      // Windows 上安装器启动后应用会自行退出（走不到这里）；其余平台靠这行重启。
      await updater.relaunch();
    },
  };
}

export const tauriRuntime = createTauriRuntime({
  invoke: tauriInvoke,
  listen: tauriListen,
});

export type { AppConfig, AppState, DesktopRuntime, OnlineSource, TaggingStatus, WallpaperFolder, WidgetLayout };
