import { contextBridge, ipcRenderer } from "electron";
import type {
  AppConfig,
  AppState,
  OnlineSource,
  WallpaperFolder,
} from "./shared";

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke("state:get"),
  updateConfig: (patch: Partial<AppConfig>): Promise<void> =>
    ipcRenderer.invoke("config:update", patch),
  addFolder: (): Promise<void> => ipcRenderer.invoke("folder:add"),
  removeFolder: (folderId: string): Promise<void> =>
    ipcRenderer.invoke("folder:remove", folderId),
  updateFolder: (folder: WallpaperFolder): Promise<void> =>
    ipcRenderer.invoke("folder:update", folder),
  openFolder: (folderId: string): Promise<void> =>
    ipcRenderer.invoke("folder:open", folderId),
  nextWallpaper: (): Promise<void> => ipcRenderer.invoke("wallpaper:next"),
  skipCurrentWallpaper: (): Promise<void> =>
    ipcRenderer.invoke("wallpaper:skip-current"),
  restoreSkippedPath: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("wallpaper:restore-skipped", filePath),
  restoreAllSkipped: (): Promise<void> =>
    ipcRenderer.invoke("wallpaper:restore-all-skipped"),
  deleteSkippedPath: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("wallpaper:delete-skipped", filePath),
  rescanFolders: (): Promise<void> => ipcRenderer.invoke("folder:rescan"),
  togglePaused: (): Promise<void> =>
    ipcRenderer.invoke("wallpaper:toggle-paused"),
  addOnlineSource: (url: string): Promise<void> =>
    ipcRenderer.invoke("online:add-source", url),
  updateOnlineSource: (source: OnlineSource): Promise<void> =>
    ipcRenderer.invoke("online:update-source", source),
  removeOnlineSource: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke("online:remove-source", sourceId),
  runOnlineSource: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke("online:run-source", sourceId),
  setOnlineImageAsWallpaper: (imageId: string): Promise<void> =>
    ipcRenderer.invoke("online:set-as-wallpaper", imageId),
  deleteOnlineImage: (imageId: string): Promise<void> =>
    ipcRenderer.invoke("online:delete-image", imageId),
  selectOnlineDirectory: (): Promise<void> =>
    ipcRenderer.invoke("online:select-directory"),
  revealOnlineImage: (imageId: string): Promise<void> =>
    ipcRenderer.invoke("online:reveal-image", imageId),
  getOnlineThumbnail: (imageId: string): Promise<string | null> =>
    ipcRenderer.invoke("online:get-thumbnail", imageId),
  getSkippedThumbnail: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke("wallpaper:get-skipped-thumbnail", filePath),
  onStateChanged: (listener: (state: AppState) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: AppState) =>
      listener(state);
    ipcRenderer.on("state:changed", callback);
    return () => ipcRenderer.removeListener("state:changed", callback);
  },
};

contextBridge.exposeInMainWorld("zxWallpaper", api);
