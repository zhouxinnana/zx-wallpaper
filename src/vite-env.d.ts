/// <reference types="vite/client" />

import type {
  AppConfig,
  AppState,
  OnlineSource,
  WallpaperFolder,
} from "../electron/shared";

declare global {
  interface Window {
    zxWallpaper?: {
      getState(): Promise<AppState>;
      updateConfig(patch: Partial<AppConfig>): Promise<void>;
      addFolder(): Promise<void>;
      removeFolder(folderId: string): Promise<void>;
      updateFolder(folder: WallpaperFolder): Promise<void>;
      openFolder(folderId: string): Promise<void>;
      nextWallpaper(): Promise<void>;
      skipCurrentWallpaper(): Promise<void>;
      restoreSkippedPath(filePath: string): Promise<void>;
      restoreAllSkipped(): Promise<void>;
      deleteSkippedPath(filePath: string): Promise<void>;
      rescanFolders(): Promise<void>;
      togglePaused(): Promise<void>;
      addOnlineSource(url: string): Promise<void>;
      updateOnlineSource(source: OnlineSource): Promise<void>;
      removeOnlineSource(sourceId: string): Promise<void>;
      runOnlineSource(sourceId: string): Promise<void>;
      setOnlineImageAsWallpaper(imageId: string): Promise<void>;
      deleteOnlineImage(imageId: string): Promise<void>;
      selectOnlineDirectory(): Promise<void>;
      revealOnlineImage(imageId: string): Promise<void>;
      getOnlineThumbnail(imageId: string): Promise<string | null>;
      getSkippedThumbnail(filePath: string): Promise<string | null>;
      onStateChanged(listener: (state: AppState) => void): () => void;
    };
  }
}

export {};
