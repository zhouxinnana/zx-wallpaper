export type WallpaperMode =
  | "fill"
  | "fit"
  | "stretch"
  | "tile"
  | "center"
  | "span";

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
  kind: "builtin" | "custom";
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

export interface PreviewItem {
  path: string;
  previewUrl: string | null;
}

export interface AppConfig {
  folders: WallpaperFolder[];
  intervalMinutes: number;
  displayMode: WallpaperMode;
  autoStart: boolean;
  paused: boolean;
  followSystemTheme: boolean;
  currentPath: string | null;
  remainingPaths: string[];
  skippedPaths: string[];
  globalNextShortcut: string | null;
  lastSwitchAt: string | null;
  onlineSources: OnlineSource[];
  onlineImages: OnlineImage[];
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
  getPreviewThumbnail(filePath: string): Promise<string | null>;
  skipCurrentWallpaper(): Promise<AppState>;
  restoreSkippedPath(filePath: string): Promise<AppState>;
  restoreAllSkipped(): Promise<AppState>;
  deleteSkippedPath(filePath: string): Promise<AppState>;
  togglePaused(): Promise<AppState>;
  addOnlineSource(url: string): Promise<AppState>;
  updateOnlineSource(source: OnlineSource): Promise<AppState>;
  removeOnlineSource(sourceId: string): Promise<AppState>;
  runOnlineSource(sourceId: string): Promise<AppState>;
  setOnlineImageAsWallpaper(imageId: string): Promise<AppState>;
  deleteOnlineImage(imageId: string): Promise<AppState>;
  selectOnlineDirectory(): Promise<AppState>;
  revealOnlineImage(imageId: string): Promise<AppState>;
  getOnlineThumbnail(imageId: string): Promise<string | null>;
  prewarmOnlineThumbnails(imageIds: string[]): Promise<void>;
  getSkippedThumbnail(filePath: string): Promise<string | null>;
  onStateChanged(listener: (state: AppState) => void): Promise<() => void>;
}
