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

/** 一张本地图在图库中的归属信息（由后端扫描派生，不落盘）。 */
export interface LibraryImage {
  path: string;
  folderId: string;
  folderEnabled: boolean;
  /** 文件修改时间（RFC3339）。图库「按时间排序」用它；读不到时为 null。 */
  modifiedAt: string | null;
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
  /** 定时同步参与的 UPX8 分类 key；缺省或空表示全部。 */
  syncCategories?: string[];
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

export interface WidgetLayout {
  docked: string | null;
  x: number | null;
  y: number | null;
}

export interface ImageTag {
  path: string;
  category: string;
  confidence: number;
  taggedAt: string;
}

export interface TaggingDownloadProgress {
  received: number;
  total: number | null;
}

export interface TaggingStatus {
  enabled: boolean;
  modelReady: boolean;
  downloading: TaggingDownloadProgress | null;
  pending: number;
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
  wallpaperHistory: string[];
  globalNextShortcut: string | null;
  globalSkipShortcut: string | null;
  lastSwitchAt: string | null;
  onlineSources: OnlineSource[];
  onlineImages: OnlineImage[];
  /** 被用户删除过的在线图源 URL（黑名单）：同步时永久跳过。 */
  excludedImageUrls: string[];
  onlineSyncLogs: OnlineSyncLog[];
  onlineDirectory: string | null;
  onlineStorageLimitGb: 1 | 5 | 10 | 20;
  onlineMinimumResolution: 1920 | 2560 | 3840;
  widgetLayout: WidgetLayout;
  imageTags: ImageTag[];
  taggingEnabled: boolean;
}

export interface AppState extends AppConfig {
  availableCount: number;
  previewUrl: string | null;
  previewItems: PreviewItem[];
  folderStatuses: Record<string, FolderStatus>;
  libraryImages: LibraryImage[];
  onlineStorageBytes: number;
  globalShortcutRegistered: boolean;
  shortcutStatus: ShortcutStatus;
  skipShortcutStatus: ShortcutStatus;
}

/** 更新清单里与 UI 相关的字段（后端 `Update` 句柄的投影，不跨进程传递）。 */
export interface AppUpdateInfo {
  /** 远端发布的新版本号，如 0.3.0。 */
  version: string;
  /** 当前运行版本号。 */
  currentVersion: string;
  /** Release notes；发布未填时为 null。 */
  notes: string | null;
  /** 发布时间（RFC 3339）；清单未提供时为 null。 */
  date: string | null;
}

/** 安装包下载进度：`total` 为 null 表示服务端未给 Content-Length。 */
export interface AppUpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface DesktopRuntime {
  getState(): Promise<AppState>;
  updateConfig(patch: Partial<AppConfig>): Promise<AppState>;
  addFolder(): Promise<AppState>;
  removeFolder(folderId: string): Promise<AppState>;  updateFolder(folder: WallpaperFolder): Promise<AppState>;
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
  batchSkipPaths(paths: string[]): Promise<AppState>;
  batchRestoreSkipped(paths: string[]): Promise<AppState>;
  batchFavorite(paths: string[], favorite: boolean): Promise<AppState>;
  batchDeletePaths(paths: string[]): Promise<AppState>;
  togglePaused(): Promise<AppState>;
  updateOnlineSource(source: OnlineSource): Promise<AppState>;
  runOnlineSource(sourceId: string): Promise<AppState>;
  runUpx8Category(categoryKey: string): Promise<AppState>;
  setOnlineImageAsWallpaper(imageId: string): Promise<AppState>;
  deleteOnlineImage(imageId: string): Promise<AppState>;
  clearExcludedImageUrls(): Promise<AppState>;
  removeExcludedImageUrl(url: string): Promise<AppState>;
  selectOnlineDirectory(): Promise<AppState>;
  revealOnlineImage(imageId: string): Promise<AppState>;
  revealWallpaper(filePath: string): Promise<void>;
  getWidgetLayout(): Promise<WidgetLayout>;
  setWidgetLayout(layout: WidgetLayout): Promise<AppState>;
  setTaggingEnabled(enabled: boolean): Promise<AppState>;
  getTaggingStatus(): Promise<TaggingStatus>;
  rescanTags(): Promise<AppState>;
  onStateChanged(listener: (state: AppState) => void): Promise<() => void>;
  /** 检查更新；无更新或非桌面环境返回 null。联网失败时抛错，由调用方决定是否展示。 */
  checkUpdate(): Promise<AppUpdateInfo | null>;
  /** 下载并安装已检查到的更新。Windows 上安装器会自行退出并重启应用。 */
  installUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<void>;
}
