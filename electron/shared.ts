export type WallpaperMode =
  | "fill"
  | "fit"
  | "stretch"
  | "tile"
  | "center"
  | "span";
export type FolderStatusKind = "available" | "empty" | "unavailable";
export type OnlineSourceKind = "builtin" | "custom";

export interface WallpaperFolder {
  id: string;
  path: string;
  enabled: boolean;
}

export interface FolderStatus {
  kind: FolderStatusKind;
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
  kind: OnlineSourceKind;
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
  previewUrl?: string | null;
  folderStatuses: Record<string, FolderStatus>;
  onlineStorageBytes: number;
  globalShortcutRegistered: boolean;
}
