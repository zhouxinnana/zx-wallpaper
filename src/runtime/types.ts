export type WallpaperMode =
  | "fill"
  | "fit"
  | "stretch"
  | "tile"
  | "center"
  | "span";

export type RotationOrder = "random" | "sequential";

export type ShortcutStatus =
  | { state: "disabled" }
  | { state: "active"; shortcut: string }
  | { state: "error"; shortcut: string; message: string };

export interface WallpaperFolder {
  id: string;
  path: string;
  enabled: boolean;
}

export interface FolderStatus {
  kind: "available" | "empty" | "unavailable";
  availableCount: number;
  invalidCount: number;
  scannedAt: string;
}

export interface OnlineSourceCategoryStatus {
  key: string;
  label: string;
  discovered: number;
  downloaded: number;
  lastError: string | null;
}

export interface OnlineSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  intervalHours: 1 | 6 | 12 | 24;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastDiscovered: number;
  lastDownloaded: number;
  lastError: string | null;
  categoryStatuses?: OnlineSourceCategoryStatus[];
}

export interface OnlineImage {
  id: string;
  sourceId: string;
  localPath: string;
  sourcePageUrl: string;
  imageUrl: string;
  downloadedAt: string;
  width: number;
  height: number;
  mimeType: string;
}

export interface OnlineDownloadFailure {
  imageUrl: string;
  resolvedUrl: string | null;
  responseStatus: number | null;
  contentType: string | null;
  reason: string;
}

export interface OnlineSyncLog {
  id: string;
  sourceId: string;
  categoryKey: string;
  categoryLabel: string;
  requestUrl: string;
  format: string;
  resolution: string;
  count: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: "running" | "success" | "partial" | "failed";
  responseStatus: number | null;
  discovered: number;
  downloaded: number;
  skipped: number;
  responseImageUrls: string[];
  errors: string[];
  downloadFailures: OnlineDownloadFailure[];
}

export interface PreviewItem {
  path: string;
  previewUrl: string | null;
}

export type ImageAssetKind = "grid" | "strip" | "hero" | "original";

export interface ImageAsset {
  src: string;
  width: number;
  height: number;
  status: "ready";
}

export interface AppConfig {
  folders: WallpaperFolder[];
  intervalMinutes: number;
  displayMode: WallpaperMode;
  rotationOrder: RotationOrder;
  autoStart: boolean;
  paused: boolean;
  followSystemTheme: boolean;
  hideToTrayOnClose: boolean;
  currentPath: string | null;
  remainingPaths: string[];
  skippedPaths: string[];
  favoritePaths: string[];
  globalNextShortcut: string | null;
  globalSkipShortcut: string | null;
  lastSwitchAt: string | null;
  onlineSources: OnlineSource[];
  onlineImages: OnlineImage[];
  onlineSyncLogs: OnlineSyncLog[];
  onlineDirectory: string | null;
  onlineStorageLimitGb: 1 | 5 | 10 | 20;
  onlineMinimumResolution: 1920 | 2560 | 3840;
}

export interface AppState extends AppConfig {
  availableCount: number;
  previewUrl: string | null;
  previewItems: PreviewItem[];
  folderStatuses: Record<string, FolderStatus>;
  onlineStorageBytes: number;
  globalShortcutRegistered: boolean;
  shortcutStatus: ShortcutStatus;
  skipShortcutStatus: ShortcutStatus;
}

export interface DesktopRuntime {
  getState(): Promise<AppState>;
  updateConfig(patch: Partial<AppConfig>): Promise<AppState>;
  addFolder(): Promise<AppState>;
  removeFolder(folderId: string): Promise<AppState>;
  updateFolder(folder: WallpaperFolder): Promise<AppState>;
  openFolder(folderId: string): Promise<AppState>;
  rescanFolders(): Promise<AppState>;
  nextWallpaper(): Promise<AppState>;
  selectWallpaper(filePath: string): Promise<AppState>;
  getImageAsset(filePath: string, kind: ImageAssetKind): Promise<ImageAsset | null>;
  prewarmImageAssets(filePaths: string[], kind: ImageAssetKind): Promise<void>;
  skipCurrentWallpaper(): Promise<AppState>;
  toggleFavorite(filePath: string): Promise<AppState>;
  restoreSkippedPath(filePath: string): Promise<AppState>;
  restoreAllSkipped(): Promise<AppState>;
  deleteSkippedPath(filePath: string): Promise<AppState>;
  deleteAllSkipped(): Promise<AppState>;
  togglePaused(): Promise<AppState>;
  updateOnlineSource(source: OnlineSource): Promise<AppState>;
  runOnlineSource(sourceId: string): Promise<AppState>;
  runUpx8Category(categoryKey: string): Promise<AppState>;
  setOnlineImageAsWallpaper(imageId: string): Promise<AppState>;
  deleteOnlineImage(imageId: string): Promise<AppState>;
  selectOnlineDirectory(): Promise<AppState>;
  revealOnlineImage(imageId: string): Promise<AppState>;
  revealWallpaper(filePath: string): Promise<void>;
  onStateChanged(listener: (state: AppState) => void): Promise<() => void>;
}
