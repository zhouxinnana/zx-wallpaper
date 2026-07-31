import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  shell,
  Tray,
} from "electron";
import { watch, type FSWatcher } from "chokidar";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppConfig,
  AppState,
  FolderStatus,
  OnlineImage,
  OnlineSource,
  WallpaperFolder,
  WallpaperMode,
} from "./shared";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const acceptedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
]);
const maximumDownloadBytes = 30 * 1024 * 1024;
const imageValidationCacheLimit = 4_096;
const upx8Categories = [
  { key: "nature", label: "风景" },
  { key: "anime", label: "动漫" },
  { key: "game", label: "游戏" },
  { key: "animal", label: "动物" },
  { key: "city", label: "城市" },
  { key: "abstract", label: "抽象" },
  { key: "space", label: "宇宙" },
  { key: "car", label: "汽车" },
  { key: "girl", label: "美女" },
  { key: "sport", label: "运动" },
] as const;
const execFileAsync = promisify(execFile);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "zx-wallpaper-preview",
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
]);
const wallpaperStyles: Record<
  WallpaperMode,
  { wallpaperStyle: string; tileWallpaper: string }
> = {
  fill: { wallpaperStyle: "10", tileWallpaper: "0" },
  fit: { wallpaperStyle: "6", tileWallpaper: "0" },
  stretch: { wallpaperStyle: "2", tileWallpaper: "0" },
  tile: { wallpaperStyle: "0", tileWallpaper: "1" },
  center: { wallpaperStyle: "0", tileWallpaper: "0" },
  span: { wallpaperStyle: "22", tileWallpaper: "0" },
};

const setWallpaperScript = `$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ZxWallpaperNative { [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint parameter, string value, uint flags); }
'@
$imagePath = [Environment]::GetEnvironmentVariable('ZX_WALLPAPER_IMAGE_PATH')
if ([string]::IsNullOrWhiteSpace($imagePath)) { throw 'Wallpaper path is empty.' }
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value ([Environment]::GetEnvironmentVariable('ZX_WALLPAPER_STYLE'))
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value ([Environment]::GetEnvironmentVariable('ZX_WALLPAPER_TILE'))
if (-not [ZxWallpaperNative]::SystemParametersInfo(20, 0, $imagePath, 3)) { throw "SystemParametersInfoW failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())." }`;
const getWallpaperScript = `$ErrorActionPreference = 'Stop'; [Console]::Out.Write((Get-ItemPropertyValue -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper))`;

const builtInSources = (): OnlineSource[] => [
  {
    id: "bing-cn-4k",
    name: "必应每日壁纸 4K",
    kind: "builtin",
    url: "https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN",
    enabled: false,
    intervalHours: 24,
    lastRunAt: null,
    nextRunAt: null,
    lastDiscovered: 0,
    lastDownloaded: 0,
    lastError: null,
  },
  {
    id: "ltyuanfang-scenery",
    name: "远方风景 4K",
    kind: "builtin",
    url: "https://tu.ltyuanfang.cn/api/fengjing.php",
    enabled: false,
    intervalHours: 24,
    lastRunAt: null,
    nextRunAt: null,
    lastDiscovered: 0,
    lastDownloaded: 0,
    lastError: null,
  },
  {
    id: "upx8-4k",
    name: "UPX8 综合壁纸 4K",
    kind: "builtin",
    url: "https://wp.upx8.com/api.php?format=json",
    enabled: false,
    intervalHours: 24,
    lastRunAt: null,
    nextRunAt: null,
    lastDiscovered: 0,
    lastDownloaded: 0,
    lastError: null,
    categoryStatuses: [],
  },
  {
    id: "wallhaven-clbug-sfw",
    name: "Wallhaven SFW 国内镜像",
    kind: "builtin",
    url: "https://wallhaven.clbug.com/api/v1/search?purity=100&sorting=random",
    enabled: false,
    intervalHours: 24,
    lastRunAt: null,
    nextRunAt: null,
    lastDiscovered: 0,
    lastDownloaded: 0,
    lastError: null,
  },
  {
    id: "bing-ioliu",
    name: "Bing 壁纸国内镜像",
    kind: "builtin",
    url: "https://bing.ioliu.cn/",
    enabled: false,
    intervalHours: 24,
    lastRunAt: null,
    nextRunAt: null,
    lastDiscovered: 0,
    lastDownloaded: 0,
    lastError: null,
  },
];
const defaultConfig: AppConfig = {
  folders: [],
  intervalMinutes: 30,
  displayMode: "fill",
  autoStart: true,
  paused: false,
  followSystemTheme: true,
  currentPath: null,
  remainingPaths: [],
  skippedPaths: [],
  globalNextShortcut: null,
  lastSwitchAt: null,
  onlineSources: builtInSources(),
  onlineImages: [],
  onlineDirectory: null,
  onlineStorageLimitGb: 5,
  onlineMinimumResolution: 1920,
};

class ConfigStore {
  private config = structuredClone(defaultConfig);
  constructor(private readonly filePath: string) {}
  async load() {
    try {
      const saved = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<AppConfig> & { onlineDownloadLimit?: unknown };
      const {
        onlineDownloadLimit: _legacyOnlineDownloadLimit,
        ...savedConfig
      } = saved;
      this.config = {
        ...structuredClone(defaultConfig),
        ...savedConfig,
        onlineSources: mergeOnlineSources(savedConfig.onlineSources),
        onlineImages: savedConfig.onlineImages ?? [],
        skippedPaths: savedConfig.skippedPaths ?? [],
      };
      if ("onlineDownloadLimit" in saved) await this.save();
    } catch {
      await this.save();
    }
  }
  get value() {
    return this.config;
  }
  async update(patch: Partial<AppConfig>) {
    this.config = { ...this.config, ...patch };
    await this.save();
  }
  async save() {
    await writeFile(
      this.filePath,
      JSON.stringify(this.config, null, 2),
      "utf8",
    );
  }
}

interface ScanResult {
  paths: string[];
  invalidCount: number;
  accessible: boolean;
}
interface DownloadedImage {
  record: OnlineImage;
  byteLength: number;
}

class WallpaperService {
  private availablePaths: string[] = [];
  private folderStatuses: Record<string, FolderStatus> = {};
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sourceTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private lastNoticeKey: string | null = null;
  private shortcutRegistered = false;
  private onlineStorageBytes = 0;
  private previewPath: string | null = null;
  private previewBuffer: Buffer | null = null;
  private previewUrl: string | null = null;
  private readonly thumbnailCache = new Map<string, string>();
  private readonly imageValidationCache = new Map<string, boolean>();
  private readonly ignoredUnlinkPaths = new Set<string>();

  constructor(
    private readonly store: ConfigStore,
    private readonly onStateChanged: () => void,
  ) {}

  async init() {
    await this.ensureOnlineDirectory();
    await this.refreshLibrary(true);
    this.startWatching();
    this.resetTimer();
    this.resetSourceTimer();
    this.applyLoginItemSetting();
    this.applyGlobalShortcut();
    void this.runDueSources();
  }

  getState(): AppState {
    return {
      ...this.store.value,
      availableCount: this.availablePaths.length,
      previewUrl: this.showCurrentPreview(),
      folderStatuses: this.folderStatuses,
      onlineStorageBytes: this.onlineStorageBytes,
      globalShortcutRegistered: this.shortcutRegistered,
    };
  }

  async updateConfig(patch: Partial<AppConfig>) {
    await this.store.update(patch);
    this.applyLoginItemSetting();
    this.resetTimer();
    this.resetSourceTimer();
    this.applyGlobalShortcut();
    if (
      patch.displayMode &&
      this.store.value.currentPath &&
      existsSync(this.store.value.currentPath)
    )
      await this.applyWallpaper(this.store.value.currentPath);
    this.onStateChanged();
    return this.getState();
  }

  async addFolder() {
    const result = await dialog.showOpenDialog({
      title: "选择壁纸文件夹",
      properties: ["openDirectory", "multiSelections"],
    });
    if (result.canceled) return this.getState();
    const known = new Set(
      this.store.value.folders.map((folder) => folder.path.toLowerCase()),
    );
    const folders = [...this.store.value.folders];
    for (const folderPath of result.filePaths)
      if (!known.has(folderPath.toLowerCase()))
        folders.push({ id: randomUUID(), path: folderPath, enabled: true });
    await this.store.update({ folders });
    return this.rescanFolders();
  }
  async updateFolder(folder: WallpaperFolder) {
    if (folder.id === "online-library") return this.getState();
    await this.store.update({
      folders: this.store.value.folders.map((item) =>
        item.id === folder.id ? folder : item,
      ),
    });
    return this.rescanFolders();
  }
  async removeFolder(folderId: string) {
    if (folderId === "online-library") return this.getState();
    await this.store.update({
      folders: this.store.value.folders.filter(
        (folder) => folder.id !== folderId,
      ),
    });
    return this.rescanFolders();
  }
  openFolder(folderId: string) {
    const folder = this.store.value.folders.find(
      (item) => item.id === folderId && item.id !== "online-library",
    );
    if (folder && existsSync(folder.path)) void shell.openPath(folder.path);
    return this.getState();
  }
  async rescanFolders() {
    await this.refreshLibrary();
    this.startWatching();
    this.onStateChanged();
    return this.getState();
  }

  async nextWallpaper(force = false) {
    if (this.store.value.paused && !force) return this.getState();
    if (!this.availablePaths.length) {
      await this.store.update({ paused: true });
      this.resetTimer();
      this.showNotice(
        "empty-library",
        "没有可用壁纸",
        "请重新扫描目录、恢复跳过图片或检查在线来源。",
      );
      this.onStateChanged();
      return this.getState();
    }
    const nextPath = await this.takeNextPath();
    if (!nextPath) return this.getState();
    try {
      await this.applyWallpaper(nextPath);
      await this.store.update({
        currentPath: nextPath,
        lastSwitchAt: new Date().toISOString(),
      });
      this.lastNoticeKey = null;
    } catch {
      this.showNotice(
        "wallpaper-failed",
        "壁纸切换失败",
        "无法将所选图片设置为 Windows 壁纸，请检查文件是否仍可访问。",
      );
    }
    this.onStateChanged();
    return this.getState();
  }
  async skipCurrentWallpaper() {
    const current = this.store.value.currentPath;
    if (!current) return this.getState();
    const skippedPaths = [
      ...new Set([...this.store.value.skippedPaths, current]),
    ];
    await this.store.update({
      skippedPaths,
      remainingPaths: this.store.value.remainingPaths.filter(
        (item) => item !== current,
      ),
    });
    this.availablePaths = this.availablePaths.filter(
      (item) => !pathsEqual(item, current),
    );
    return this.nextWallpaper(true);
  }
  async restoreSkippedPath(filePath: string) {
    if (
      !this.store.value.skippedPaths.some((item) => pathsEqual(item, filePath))
    )
      return this.getState();
    await this.store.update({
      skippedPaths: this.store.value.skippedPaths.filter(
        (item) => item !== filePath,
      ),
    });
    this.addAvailablePath(filePath, false);
    this.onStateChanged();
    return this.getState();
  }
  async restoreAllSkipped() {
    const skippedPaths = this.store.value.skippedPaths;
    await this.store.update({ skippedPaths: [] });
    for (const filePath of skippedPaths) this.addAvailablePath(filePath, false);
    this.onStateChanged();
    return this.getState();
  }
  async deleteSkippedPath(filePath: string) {
    if (
      !this.store.value.skippedPaths.some((item) => pathsEqual(item, filePath))
    )
      return this.getState();
    this.ignoredUnlinkPaths.add(path.resolve(filePath).toLowerCase());
    try {
      await unlink(filePath);
    } catch {}
    await this.removeDeletedPath(filePath);
    return this.getState();
  }
  async togglePaused() {
    await this.store.update({ paused: !this.store.value.paused });
    this.resetTimer();
    this.onStateChanged();
    return this.getState();
  }
  async resumeIfDue() {
    const last = this.store.value.lastSwitchAt
      ? Date.parse(this.store.value.lastSwitchAt)
      : 0;
    if (
      !this.store.value.paused &&
      last &&
      Date.now() - last >= this.store.value.intervalMinutes * 60_000
    )
      await this.nextWallpaper();
  }
  showCurrentPreview() {
    const current = this.store.value.currentPath;
    if (!current || !existsSync(current)) {
      this.previewPath = null;
      this.previewBuffer = null;
      this.previewUrl = null;
      return null;
    }
    if (this.previewPath === current && this.previewUrl) return this.previewUrl;
    const image = nativeImage.createFromPath(current);
    if (image.isEmpty()) return null;
    const preview =
      image.getSize().width > 960 ? image.resize({ width: 960 }) : image;
    this.previewPath = current;
    this.previewBuffer = preview.toJPEG(72);
    this.previewUrl = `zx-wallpaper-preview://current?path=${encodeURIComponent(current)}`;
    return this.previewUrl;
  }
  getCurrentPreviewResponse(requestUrl: string) {
    const request = new URL(requestUrl);
    const current = this.store.value.currentPath;
    if (
      request.hostname !== "current" ||
      !current ||
      request.searchParams.get("path") !== current ||
      !existsSync(current)
    )
      return null;
    this.showCurrentPreview();
    if (!this.previewBuffer) return null;
    return new Response(new Uint8Array(this.previewBuffer), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      },
    });
  }

  async addOnlineSource(url: string) {
    await validatePublicHttpsUrl(url);
    const source: OnlineSource = {
      id: randomUUID(),
      name: new URL(url).hostname,
      kind: "custom",
      url,
      enabled: true,
      intervalHours: 24,
      lastRunAt: null,
      nextRunAt: new Date().toISOString(),
      lastDiscovered: 0,
      lastDownloaded: 0,
      lastError: null,
    };
    await this.store.update({
      onlineSources: [...this.store.value.onlineSources, source],
    });
    this.resetSourceTimer();
    this.onStateChanged();
    return this.getState();
  }
  async updateOnlineSource(source: OnlineSource) {
    if (source.kind === "custom") await validatePublicHttpsUrl(source.url);
    const intervalHours = allowedInterval(source.intervalHours)
      ? source.intervalHours
      : 24;
    const updatedSource = {
      ...source,
      intervalHours,
      nextRunAt: source.enabled
        ? new Date(Date.now() + intervalHours * 3_600_000).toISOString()
        : null,
    };
    await this.store.update({
      onlineSources: this.store.value.onlineSources.map((item) =>
        item.id === source.id ? updatedSource : item,
      ),
    });
    this.resetSourceTimer();
    this.onStateChanged();
    return this.getState();
  }
  async removeOnlineSource(sourceId: string) {
    await this.store.update({
      onlineSources: this.store.value.onlineSources.filter(
        (item) => item.id !== sourceId,
      ),
    });
    this.resetSourceTimer();
    this.onStateChanged();
    return this.getState();
  }
  async runOnlineSource(sourceId: string) {
    const source = this.store.value.onlineSources.find(
      (item) => item.id === sourceId,
    );
    if (source) await this.runSource(source, true);
    return this.getState();
  }
  async setOnlineImageAsWallpaper(imageId: string) {
    const image = this.store.value.onlineImages.find(
      (item) => item.id === imageId,
    );
    if (!image || !existsSync(image.localPath)) return this.getState();
    try {
      await this.applyWallpaper(image.localPath);
      await this.store.update({
        currentPath: image.localPath,
        remainingPaths: this.store.value.remainingPaths.filter(
          (item) => !pathsEqual(item, image.localPath),
        ),
        paused: true,
        lastSwitchAt: new Date().toISOString(),
      });
      this.resetTimer();
      this.lastNoticeKey = null;
    } catch {
      this.showNotice(
        "wallpaper-failed",
        "壁纸切换失败",
        "无法将所选图片设置为 Windows 壁纸，请检查文件是否仍可访问。",
      );
    }
    this.onStateChanged();
    return this.getState();
  }
  async deleteOnlineImage(imageId: string) {
    const image = this.store.value.onlineImages.find(
      (item) => item.id === imageId,
    );
    if (!image) return this.getState();
    this.ignoredUnlinkPaths.add(path.resolve(image.localPath).toLowerCase());
    try {
      await unlink(image.localPath);
    } catch {}
    const { wasCurrent } = await this.removeDeletedPath(image.localPath);
    return wasCurrent ? this.nextWallpaper(true) : this.getState();
  }
  async selectOnlineDirectory() {
    const result = await dialog.showOpenDialog({
      title: "选择在线壁纸保存文件夹",
      defaultPath: this.store.value.onlineDirectory ?? undefined,
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return this.getState();
    return this.moveOnlineDirectory(result.filePaths[0]);
  }
  revealOnlineImage(imageId: string) {
    const image = this.store.value.onlineImages.find(
      (item) => item.id === imageId,
    );
    if (image && existsSync(image.localPath))
      shell.showItemInFolder(image.localPath);
    return this.getState();
  }
  getOnlineThumbnail(imageId: string) {
    const image = this.store.value.onlineImages.find(
      (item) => item.id === imageId,
    );
    return image ? this.getThumbnail(image.localPath) : null;
  }
  getSkippedThumbnail(filePath: string) {
    if (
      !this.store.value.skippedPaths.some((item) => pathsEqual(item, filePath))
    )
      return null;
    return this.getThumbnail(filePath);
  }
  private getThumbnail(filePath: string) {
    if (!existsSync(filePath)) return null;
    const cached = this.thumbnailCache.get(filePath);
    if (cached) {
      this.thumbnailCache.delete(filePath);
      this.thumbnailCache.set(filePath, cached);
      return cached;
    }
    const native = nativeImage.createFromPath(filePath);
    if (native.isEmpty()) return null;
    const thumbnail =
      native.getSize().width > 360 ? native.resize({ width: 360 }) : native;
    const dataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(72).toString("base64")}`;
    if (this.thumbnailCache.size >= 96) {
      const oldestPath = this.thumbnailCache.keys().next().value;
      if (oldestPath) this.thumbnailCache.delete(oldestPath);
    }
    this.thumbnailCache.set(filePath, dataUrl);
    return dataUrl;
  }

  private async ensureOnlineDirectory() {
    const onlineDirectory =
      this.store.value.onlineDirectory ??
      path.join(app.getPath("pictures"), "ZX Wallpaper", "Online");
    await mkdir(onlineDirectory, { recursive: true });
    const migratedPaths = new Map<string, string>();
    const onlineImages = this.store.value.onlineImages.map((image) => {
      if (existsSync(image.localPath)) return image;
      const migratedPath = path.join(
        onlineDirectory,
        path.basename(image.localPath),
      );
      if (!existsSync(migratedPath)) return image;
      migratedPaths.set(image.localPath, migratedPath);
      return { ...image, localPath: migratedPath };
    });
    const migratePath = (filePath: string) =>
      migratedPaths.get(filePath) ?? filePath;
    const hasFolder = this.store.value.folders.some(
      (folder) => folder.id === "online-library",
    );
    const folders = hasFolder
      ? this.store.value.folders.map((folder) =>
          folder.id === "online-library"
            ? { ...folder, path: onlineDirectory, enabled: true }
            : folder,
        )
      : [
          ...this.store.value.folders,
          { id: "online-library", path: onlineDirectory, enabled: true },
        ];
    await this.store.update({
      onlineDirectory,
      folders,
      onlineImages,
      skippedPaths: this.store.value.skippedPaths.map(migratePath),
      remainingPaths: this.store.value.remainingPaths.map(migratePath),
      currentPath: this.store.value.currentPath
        ? migratePath(this.store.value.currentPath)
        : null,
    });
  }
  private async moveOnlineDirectory(nextDirectory: string) {
    const currentDirectory = this.store.value.onlineDirectory;
    if (!currentDirectory || pathsEqual(currentDirectory, nextDirectory))
      return this.getState();
    await mkdir(nextDirectory, { recursive: true });
    const migrations = this.store.value.onlineImages.flatMap((image) => {
      if (
        !isPathWithin(currentDirectory, image.localPath) ||
        !existsSync(image.localPath)
      )
        return [];
      return [
        {
          from: image.localPath,
          to: path.join(nextDirectory, path.basename(image.localPath)),
        },
      ];
    });
    const destinations = new Set<string>();
    for (const migration of migrations) {
      const key = migration.to.toLowerCase();
      if (
        destinations.has(key) ||
        (existsSync(migration.to) && !pathsEqual(migration.from, migration.to))
      )
        throw new Error("目标文件夹已有同名在线图片，请选择其他文件夹。");
      destinations.add(key);
    }
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const migration of migrations) {
        await moveFile(migration.from, migration.to);
        moved.push(migration);
      }
    } catch (error) {
      await Promise.allSettled(
        moved
          .reverse()
          .map((migration) => moveFile(migration.to, migration.from)),
      );
      throw error;
    }
    const pathUpdates = new Map(migrations.map(({ from, to }) => [from, to]));
    const updatePath = (filePath: string) =>
      pathUpdates.get(filePath) ?? filePath;
    const folders = this.store.value.folders.map((folder) =>
      folder.id === "online-library"
        ? { ...folder, path: nextDirectory }
        : folder,
    );
    try {
      await this.store.update({
        onlineDirectory: nextDirectory,
        folders,
        onlineImages: this.store.value.onlineImages.map((image) => ({
          ...image,
          localPath: updatePath(image.localPath),
        })),
        skippedPaths: this.store.value.skippedPaths.map(updatePath),
        remainingPaths: this.store.value.remainingPaths.map(updatePath),
        currentPath: this.store.value.currentPath
          ? updatePath(this.store.value.currentPath)
          : null,
      });
    } catch (error) {
      await Promise.allSettled(
        moved
          .reverse()
          .map((migration) => moveFile(migration.to, migration.from)),
      );
      throw error;
    }
    return this.rescanFolders();
  }
  private async refreshLibrary(refreshOnlineStorage = false) {
    const enabled = this.store.value.folders.filter((folder) => folder.enabled);
    const scanned = await Promise.all(
      enabled.map(async (folder) => ({
        folder,
        result: await discoverImages(folder.path, this.imageValidationCache),
      })),
    );
    this.folderStatuses = Object.fromEntries(
      scanned.map(({ folder, result }) => [
        folder.id,
        {
          kind: !result.accessible
            ? "unavailable"
            : result.paths.length
              ? "available"
              : "empty",
          availableCount: result.paths.length,
          invalidCount: result.invalidCount,
          scannedAt: new Date().toISOString(),
        },
      ]),
    );
    this.availablePaths = [
      ...new Set(scanned.flatMap(({ result }) => result.paths)),
    ].filter((filePath) => !this.store.value.skippedPaths.includes(filePath));
    const remainingPaths = this.store.value.remainingPaths.filter((filePath) =>
      this.availablePaths.includes(filePath),
    );
    if (remainingPaths.length !== this.store.value.remainingPaths.length)
      await this.store.update({ remainingPaths });
    if (refreshOnlineStorage)
      this.onlineStorageBytes = await directoryBytes(
        this.store.value.onlineDirectory,
      );
  }
  private addAvailablePath(filePath: string, updateFolderStatus: boolean) {
    if (
      this.availablePaths.some((item) => pathsEqual(item, filePath)) ||
      !existsSync(filePath)
    )
      return true;
    const validationKey = imageValidationKey(filePath);
    let isValid = this.imageValidationCache.get(validationKey);
    if (isValid === undefined) {
      isValid = !nativeImage.createFromPath(filePath).isEmpty();
      setImageValidation(this.imageValidationCache, validationKey, isValid);
    }
    if (!isValid) return false;
    const folders = this.store.value.folders.filter(
      (folder) => folder.enabled && isPathWithin(folder.path, filePath),
    );
    if (
      !folders.length ||
      this.store.value.skippedPaths.some((item) => pathsEqual(item, filePath))
    )
      return true;

    this.availablePaths.push(filePath);
    if (!updateFolderStatus) return true;
    const scannedAt = new Date().toISOString();
    for (const folder of folders) {
      const status = this.folderStatuses[folder.id];
      if (!status || status.kind === "unavailable") continue;
      const availableCount = status.availableCount + 1;
      this.folderStatuses[folder.id] = {
        ...status,
        availableCount,
        kind: "available",
        scannedAt,
      };
    }
    return true;
  }
  private async removeDeletedPath(filePath: string) {
    const matches = (candidate: string) => pathsEqual(candidate, filePath);
    const onlineImage = this.store.value.onlineImages.find((image) =>
      matches(image.localPath),
    );
    const wasAvailable = this.availablePaths.some(matches);
    const wasSkipped = this.store.value.skippedPaths.some(matches);
    const wasCurrent = this.store.value.currentPath
      ? matches(this.store.value.currentPath)
      : false;
    const wasRemaining = this.store.value.remainingPaths.some(matches);
    const wasKnown =
      Boolean(onlineImage) ||
      wasAvailable ||
      wasSkipped ||
      wasCurrent ||
      wasRemaining;
    if (!wasKnown) return { handled: false, wasCurrent: false };

    this.availablePaths = this.availablePaths.filter(
      (candidate) => !matches(candidate),
    );
    this.thumbnailCache.delete(filePath);
    this.imageValidationCache.delete(imageValidationKey(filePath));
    const scannedAt = new Date().toISOString();
    for (const folder of this.store.value.folders.filter(
      (item) => item.enabled && isPathWithin(item.path, filePath),
    )) {
      const status = this.folderStatuses[folder.id];
      if (!status || status.kind === "unavailable") continue;
      const availableCount = Math.max(0, status.availableCount - 1);
      this.folderStatuses[folder.id] = {
        ...status,
        availableCount,
        kind: availableCount ? "available" : "empty",
        scannedAt,
      };
    }

    await this.store.update({
      onlineImages: onlineImage
        ? this.store.value.onlineImages.filter(
            (image) => !matches(image.localPath),
          )
        : this.store.value.onlineImages,
      skippedPaths: this.store.value.skippedPaths.filter(
        (candidate) => !matches(candidate),
      ),
      remainingPaths: this.store.value.remainingPaths.filter(
        (candidate) => !matches(candidate),
      ),
      currentPath: wasCurrent ? null : this.store.value.currentPath,
    });
    if (onlineImage)
      this.onlineStorageBytes = await directoryBytes(
        this.store.value.onlineDirectory,
      );
    this.onStateChanged();
    return { handled: true, wasCurrent };
  }
  private scheduleRescan() {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      void this.rescanFolders();
    }, 600);
  }
  private startWatching() {
    void this.watcher?.close();
    const folders = this.store.value.folders
      .filter((folder) => folder.enabled)
      .map((folder) => folder.path);
    if (!folders.length) {
      this.watcher = null;
      return;
    }
    this.watcher = watch(folders, { ignoreInitial: true, depth: 12 });
    this.watcher.on("all", (event, filePath) => {
      if (
        event === "add" &&
        imageExtensions.has(path.extname(filePath).toLowerCase())
      ) {
        if (this.addAvailablePath(filePath, true)) this.onStateChanged();
        else this.scheduleRescan();
        return;
      }
      if (
        event !== "unlink" ||
        !imageExtensions.has(path.extname(filePath).toLowerCase())
      ) {
        if (imageExtensions.has(path.extname(filePath).toLowerCase()))
          this.imageValidationCache.delete(imageValidationKey(filePath));
        this.scheduleRescan();
        return;
      }
      const normalizedPath = path.resolve(filePath).toLowerCase();
      this.imageValidationCache.delete(normalizedPath);
      if (this.ignoredUnlinkPaths.delete(normalizedPath)) return;
      void this.removeDeletedPath(filePath).then(({ handled }) => {
        if (!handled) this.scheduleRescan();
      });
    });
  }
  private async takeNextPath() {
    const remaining = this.store.value.remainingPaths.filter((filePath) =>
      this.availablePaths.includes(filePath),
    );
    if (!remaining.length) {
      const candidates = this.availablePaths.filter(
        (filePath) => filePath !== this.store.value.currentPath,
      );
      remaining.push(
        ...shuffle(candidates.length ? candidates : this.availablePaths),
      );
    }
    const nextPath = remaining.shift() ?? null;
    await this.store.update({ remainingPaths: remaining });
    return nextPath;
  }
  private resetTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.store.value.paused && this.store.value.intervalMinutes > 0)
      this.timer = setInterval(
        () => void this.nextWallpaper(),
        this.store.value.intervalMinutes * 60_000,
      );
  }
  private resetSourceTimer() {
    if (this.sourceTimer) clearInterval(this.sourceTimer);
    this.sourceTimer = setInterval(() => void this.runDueSources(), 60_000);
  }
  private async runDueSources() {
    for (const source of this.store.value.onlineSources.filter(
      (item) => item.enabled,
    ))
      if (!source.nextRunAt || Date.parse(source.nextRunAt) <= Date.now())
        await this.runSource(source, false);
  }
  private async runSource(source: OnlineSource, manual: boolean) {
    try {
      const fetched = await fetchSourceCandidates(
        source,
        this.store.value.onlineMinimumResolution,
      );
      const unique = fetched.candidates.filter(
        (item, index, all) =>
          all.findIndex((candidate) => candidate.imageUrl === item.imageUrl) ===
          index,
      );
      const sourceKnown = new Set(
        this.store.value.onlineImages.map((image) => image.imageUrl),
      );
      let downloaded = 0;
      let downloadedBytes = 0;
      const downloadedImages: DownloadedImage[] = [];
      const downloadsByCategory = new Map<string, number>();
      for (const candidate of unique) {
        if (
          sourceKnown.has(candidate.imageUrl) ||
          this.onlineStorageBytes + downloadedBytes >=
            this.store.value.onlineStorageLimitGb * 1024 ** 3
        )
          continue;
        const image = await this.downloadCandidate(source, candidate);
        if (image) {
          downloaded += 1;
          downloadedBytes += image.byteLength;
          downloadedImages.push(image);
          sourceKnown.add(image.record.imageUrl);
          if (candidate.categoryKey)
            downloadsByCategory.set(
              candidate.categoryKey,
              (downloadsByCategory.get(candidate.categoryKey) ?? 0) + 1,
            );
        }
      }
      const categoryStatuses = fetched.categoryStatuses?.map((status) => ({
        ...status,
        downloaded: downloadsByCategory.get(status.key) ?? 0,
      }));
      const failedCategoryCount =
        categoryStatuses?.filter((status) => status.lastError).length ?? 0;
      const next = new Date(
        Date.now() + source.intervalHours * 3_600_000,
      ).toISOString();
      await this.replaceSource(
        {
          ...source,
          lastRunAt: new Date().toISOString(),
          nextRunAt: next,
          lastDiscovered: unique.length,
          lastDownloaded: downloaded,
          lastError: failedCategoryCount
            ? `UPX8 ${failedCategoryCount} 个分类请求失败。`
            : null,
          categoryStatuses,
        },
        downloadedImages.map((image) => image.record),
      );
      for (const image of downloadedImages)
        this.addAvailablePath(image.record.localPath, true);
      this.onlineStorageBytes += downloadedBytes;
      this.onStateChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : "抓取失败";
      await this.replaceSource({
        ...source,
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(
          Date.now() + source.intervalHours * 3_600_000,
        ).toISOString(),
        lastDiscovered: 0,
        lastDownloaded: 0,
        lastError: message,
      });
      if (manual)
        this.showNotice(`source-${source.id}`, "在线来源不可用", message);
      this.onStateChanged();
    }
  }
  private async replaceSource(
    source: OnlineSource,
    onlineImages: OnlineImage[] = [],
  ) {
    await this.store.update({
      onlineSources: this.store.value.onlineSources.map((item) =>
        item.id === source.id ? source : item,
      ),
      onlineImages: onlineImages.length
        ? [...this.store.value.onlineImages, ...onlineImages]
        : this.store.value.onlineImages,
    });
  }
  private async downloadCandidate(
    source: OnlineSource,
    candidate: Candidate,
  ): Promise<DownloadedImage | null> {
    await validateDownloadUrl(source, candidate.imageUrl);
    const response = await fetch(candidate.imageUrl, {
      headers: { "User-Agent": "ZX-Wallpaper/0.1" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`下载图片失败 (${response.status})`);
    await validateDownloadUrl(source, response.url);
    const mimeType =
      response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "";
    if (!acceptedMimeTypes.has(mimeType)) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumDownloadBytes)
      return null;
    const extension =
      mimeType === "image/jpeg"
        ? ".jpg"
        : mimeType === "image/png"
          ? ".png"
          : mimeType === "image/webp"
            ? ".webp"
            : ".bmp";
    const localPath = path.join(
      this.store.value.onlineDirectory!,
      `${createHash("sha256").update(candidate.imageUrl).digest("hex")}${extension}`,
    );
    const temporaryPath = `${localPath}.${randomUUID()}.part`;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const output = await open(temporaryPath, "w");
    let byteLength = 0;
    let downloadError: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maximumDownloadBytes) {
          await reader.cancel();
          break;
        }
        await output.write(value);
      }
    } catch (error) {
      downloadError = error;
    } finally {
      reader.releaseLock();
      await output.close();
    }
    if (downloadError) {
      await unlink(temporaryPath).catch(() => {});
      throw downloadError;
    }
    if (!byteLength || byteLength > maximumDownloadBytes) {
      await unlink(temporaryPath).catch(() => {});
      return null;
    }
    await rename(temporaryPath, localPath);
    const image = nativeImage.createFromPath(localPath);
    const size = image.getSize();
    const minimumHeight =
      this.store.value.onlineMinimumResolution === 1920
        ? 1080
        : this.store.value.onlineMinimumResolution === 2560
          ? 1440
          : 2160;
    if (
      image.isEmpty() ||
      size.width < this.store.value.onlineMinimumResolution ||
      size.height < minimumHeight ||
      size.width < size.height
    ) {
      await unlink(localPath);
      return null;
    }
    const record: OnlineImage = {
      id: randomUUID(),
      sourceId: source.id,
      localPath,
      sourcePageUrl: candidate.sourcePageUrl,
      imageUrl: candidate.imageUrl,
      downloadedAt: new Date().toISOString(),
      width: size.width,
      height: size.height,
      mimeType,
    };
    return { record, byteLength };
  }
  private async applyWallpaper(imagePath: string) {
    if (process.env.ZX_WALLPAPER_TEST_MODE === "1") return;
    const style = wallpaperStyles[this.store.value.displayMode];
    await runPowerShell(setWallpaperScript, {
      ZX_WALLPAPER_IMAGE_PATH: imagePath,
      ZX_WALLPAPER_STYLE: style.wallpaperStyle,
      ZX_WALLPAPER_TILE: style.tileWallpaper,
    });
  }
  private applyLoginItemSetting() {
    app.setLoginItemSettings({
      openAtLogin: this.store.value.autoStart,
      args: ["--background"],
    });
  }
  private applyGlobalShortcut() {
    globalShortcut.unregisterAll();
    this.shortcutRegistered = false;
    const shortcut = this.store.value.globalNextShortcut;
    if (shortcut)
      this.shortcutRegistered = globalShortcut.register(
        shortcut,
        () => void this.nextWallpaper(),
      );
  }
  private showNotice(key: string, title: string, body: string) {
    if (this.lastNoticeKey === key || !Notification.isSupported()) return;
    this.lastNoticeKey = key;
    new Notification({ title, body }).show();
  }
}

interface Candidate {
  imageUrl: string;
  sourcePageUrl: string;
  categoryKey?: string;
}
interface SourceFetchResult {
  candidates: Candidate[];
  categoryStatuses?: OnlineSource["categoryStatuses"];
}
function mergeOnlineSources(savedSources: OnlineSource[] | undefined) {
  const savedById = new Map(
    (savedSources ?? []).map((source) => [source.id, source]),
  );
  const builtIns = builtInSources().map((source) => {
    const saved = savedById.get(source.id);
    return saved
      ? {
          ...source,
          enabled: saved.enabled,
          intervalHours: allowedInterval(saved.intervalHours)
            ? saved.intervalHours
            : source.intervalHours,
          lastRunAt: saved.lastRunAt,
          nextRunAt: saved.nextRunAt,
          lastDiscovered: saved.lastDiscovered,
          lastDownloaded: saved.lastDownloaded,
          lastError: saved.lastError,
          categoryStatuses: saved.categoryStatuses ?? source.categoryStatuses,
        }
      : source;
  });
  return [
    ...builtIns,
    ...(savedSources ?? []).filter((source) => source.kind === "custom"),
  ];
}
async function fetchSourceCandidates(
  source: OnlineSource,
  minimum: number,
): Promise<SourceFetchResult> {
  if (source.kind === "custom" || source.id === "bing-ioliu")
    return { candidates: await fetchCustomPage(source) };
  if (source.id === "bing-cn-4k")
    return { candidates: await fetchBingArchive(source) };
  if (source.id === "ltyuanfang-scenery") return fetchDirectImageSource(source);
  if (source.id === "upx8-4k") return fetchUpx8(source, minimum);
  if (source.id === "wallhaven-clbug-sfw")
    return { candidates: await fetchWallhavenMirror(source, minimum) };
  return { candidates: await fetchWallhaven(source, minimum) };
}
async function fetchWallhaven(
  source: OnlineSource,
  minimum: number,
): Promise<Candidate[]> {
  const minimumHeight =
    minimum === 1920 ? 1080 : minimum === 2560 ? 1440 : 2160;
  const url = new URL(source.url);
  url.searchParams.set("purity", "100");
  url.searchParams.set("sorting", "random");
  url.searchParams.set("atleast", `${minimum}x${minimumHeight}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "ZX-Wallpaper/0.1" },
  });
  if (!response.ok) throw new Error(`Wallhaven 请求失败 (${response.status})`);
  const payload = (await response.json()) as {
    data?: Array<{
      path: string;
      url: string;
      dimension_x: number;
      dimension_y: number;
      purity: string;
    }>;
  };
  return (payload.data ?? [])
    .filter(
      (item) =>
        item.purity === "sfw" &&
        item.dimension_x >= minimum &&
        item.dimension_y >= 1080 &&
        item.dimension_x >= item.dimension_y,
    )
    .map((item) => ({ imageUrl: item.path, sourcePageUrl: item.url }));
}
async function fetchBingArchive(source: OnlineSource): Promise<Candidate[]> {
  await validatePublicHttpsUrl(source.url);
  const response = await fetch(source.url, {
    headers: { "User-Agent": "ZX-Wallpaper/0.1" },
  });
  if (!response.ok) throw new Error(`必应请求失败 (${response.status})`);
  const payload = (await response.json()) as {
    images?: Array<{ urlbase?: string }>;
  };
  return (payload.images ?? []).flatMap((image) =>
    image.urlbase
      ? [
          {
            imageUrl: `https://cn.bing.com${image.urlbase}_UHD.jpg&rf=LaDigue_UHD.jpg&pid=hp`,
            sourcePageUrl: source.url,
          },
        ]
      : [],
  );
}
async function fetchWallhavenMirror(
  source: OnlineSource,
  minimum: number,
): Promise<Candidate[]> {
  const minimumHeight =
    minimum === 1920 ? 1080 : minimum === 2560 ? 1440 : 2160;
  const url = new URL(source.url);
  url.searchParams.set("purity", "100");
  url.searchParams.set("sorting", "random");
  url.searchParams.set("atleast", `${minimum}x${minimumHeight}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "ZX-Wallpaper/0.1" },
  });
  if (!response.ok)
    throw new Error(`Wallhaven 镜像请求失败 (${response.status})`);
  const payload = (await response.json()) as {
    data?: Array<{
      id: string;
      path: string;
      dimension_x: number;
      dimension_y: number;
      purity: string;
    }>;
  };
  return (payload.data ?? [])
    .filter(
      (item) =>
        item.purity === "sfw" &&
        item.dimension_x >= minimum &&
        item.dimension_y >= minimumHeight &&
        item.dimension_x >= item.dimension_y,
    )
    .map((item) => {
      const imageUrl = new URL(item.path);
      imageUrl.hostname = "w.wallhaven.clbug.com";
      return {
        imageUrl: imageUrl.toString(),
        sourcePageUrl: `https://wallhaven.clbug.com/w/${item.id}`,
      };
    });
}
async function fetchDirectImageSource(
  source: OnlineSource,
): Promise<SourceFetchResult> {
  await validatePublicHttpsUrl(source.url);
  const response = await fetch(source.url, {
    headers: { "User-Agent": "ZX-Wallpaper/0.1" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`图片接口请求失败 (${response.status})`);
  await validatePublicHttpsUrl(response.url);
  if (
    !acceptedMimeTypes.has(
      response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "",
    )
  )
    throw new Error("图片接口未返回静态图片。");
  await response.body?.cancel();
  return {
    candidates: [{ imageUrl: response.url, sourcePageUrl: source.url }],
  };
}
async function fetchUpx8(
  source: OnlineSource,
  minimum: number,
): Promise<SourceFetchResult> {
  await validatePublicHttpsUrl(source.url);
  const candidates: Candidate[] = [];
  const categoryStatuses: NonNullable<OnlineSource["categoryStatuses"]> = [];
  for (const category of upx8Categories) {
    try {
      const candidate = await fetchUpx8Category(source, category, minimum);
      candidates.push(...candidate);
      categoryStatuses.push({
        ...category,
        discovered: candidate.length,
        downloaded: 0,
        lastError: null,
      });
    } catch (error) {
      categoryStatuses.push({
        ...category,
        discovered: 0,
        downloaded: 0,
        lastError: error instanceof Error ? error.message : "请求失败",
      });
    }
  }
  return { candidates, categoryStatuses };
}
async function fetchUpx8Category(
  source: OnlineSource,
  category: (typeof upx8Categories)[number],
  minimum: number,
): Promise<Candidate[]> {
  const url = new URL(source.url);
  url.searchParams.set("format", "json");
  url.searchParams.set("category", category.key);
  url.searchParams.set("resolution", upx8Resolution(minimum));
  url.searchParams.set("count", "10");
  const response = await fetch(url, {
    headers: { "User-Agent": "ZX-Wallpaper/0.1" },
  });
  if (!response.ok) throw new Error(`UPX8 请求失败 (${response.status})`);
  await validatePublicHttpsUrl(response.url);
  const payload = (await response.json()) as {
    data?: { url?: string } | Array<{ url?: string }>;
  };
  const items = Array.isArray(payload.data)
    ? payload.data
    : payload.data
      ? [payload.data]
      : [];
  const candidates: Candidate[] = [];
  for (const item of items) {
    if (!item.url) continue;
    await validateDownloadUrl(source, item.url);
    candidates.push({
      imageUrl: item.url,
      sourcePageUrl: url.toString(),
      categoryKey: category.key,
    });
  }
  return candidates;
}
function upx8Resolution(minimum: number) {
  return minimum === 3840
    ? "3840x2160"
    : minimum === 2560
      ? "2560x1440"
      : "1920x1080";
}
async function fetchCustomPage(source: OnlineSource): Promise<Candidate[]> {
  await validatePublicHttpsUrl(source.url);
  const response = await fetch(source.url, {
    headers: { "User-Agent": "ZX-Wallpaper/0.1" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`页面请求失败 (${response.status})`);
  await validatePublicHttpsUrl(response.url);
  const html = await response.text();
  const urls = new Set<string>();
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = tag[0];
    const srcset = attribute(attributes, "srcset");
    const src = attribute(attributes, "src");
    const chosen =
      srcset
        ?.split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
        .at(-1) ?? src;
    if (chosen) urls.add(new URL(chosen, response.url).toString());
  }
  return [...urls]
    .filter((url) => /^https:\/\//i.test(url))
    .map((imageUrl) => ({ imageUrl, sourcePageUrl: response.url }));
}
function attribute(tag: string, name: string) {
  return (
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1] ??
    null
  );
}
async function validatePublicHttpsUrl(value: string) {
  await validatePublicUrl(value, false);
}
async function validateDownloadUrl(source: OnlineSource, value: string) {
  await validatePublicUrl(
    value,
    source.id === "upx8-4k" && isUpx8CdnUrl(value),
  );
}
function isUpx8CdnUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "cdn-hsyq-static.shanhutech.cn" &&
      url.pathname.startsWith("/bizhi/staticwp/")
    );
  } catch {
    return false;
  }
}
async function validatePublicUrl(value: string, allowHttp: boolean) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
    host === "localhost" ||
    host.endsWith(".local") ||
    isIP(host)
  )
    throw new Error("只允许公开 HTTPS 域名。");
  const addresses = await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw new Error("来源不能解析到私有网络。");
}
function isPrivateAddress(address: string) {
  if (
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80:")
  )
    return true;
  const parts = address.split(".").map(Number);
  return (
    parts.length === 4 &&
    (parts[0] === 10 ||
      parts[0] === 127 ||
      parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}
function pathsEqual(left: string, right: string) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
function isPathWithin(directory: string, filePath: string) {
  const relative = path.relative(directory, filePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}
async function moveFile(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EXDEV"
    )
      throw error;
    await copyFile(from, to);
    try {
      await unlink(from);
    } catch (unlinkError) {
      await unlink(to).catch(() => {});
      throw unlinkError;
    }
  }
}
function allowedInterval(value: number): value is 1 | 6 | 12 | 24 {
  return value === 1 || value === 6 || value === 12 || value === 24;
}
function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[next]] = [copy[next], copy[index]];
  }
  return copy;
}
function imageValidationKey(filePath: string) {
  return path.resolve(filePath).toLowerCase();
}
function setImageValidation(
  cache: Map<string, boolean>,
  key: string,
  isValid: boolean,
) {
  cache.delete(key);
  cache.set(key, isValid);
  if (cache.size > imageValidationCacheLimit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
}
async function discoverImages(
  folderPath: string,
  validationCache: Map<string, boolean>,
): Promise<ScanResult> {
  const paths: string[] = [];
  let invalidCount = 0;
  let accessible = true;
  async function visit(current: string) {
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(entryPath);
        else if (
          entry.isFile() &&
          imageExtensions.has(path.extname(entry.name).toLowerCase())
        ) {
          const key = imageValidationKey(entryPath);
          let isValid = validationCache.get(key);
          if (isValid === undefined) {
            isValid = !nativeImage.createFromPath(entryPath).isEmpty();
            setImageValidation(validationCache, key, isValid);
          }
          if (isValid) paths.push(entryPath);
          else invalidCount += 1;
        }
      }
    } catch {
      accessible = false;
    }
  }
  await visit(folderPath);
  return { paths, invalidCount, accessible };
}
async function directoryBytes(directory: string | null) {
  if (!directory) return 0;
  let total = 0;
  async function visit(current: string) {
    try {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const filePath = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(filePath);
        else if (entry.isFile()) total += (await stat(filePath)).size;
      }
    } catch {}
  }
  await visit(directory);
  return total;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: WallpaperService;
let isQuitting = false;
function createBrandIcon() {
  return createTrayIcon();
}
function createTrayIcon() {
  const icon = nativeImage.createFromPath(
    app.isPackaged
      ? path.join(process.resourcesPath, "zx-wallpaper.ico")
      : path.join(app.getAppPath(), "build", "zx-wallpaper.ico"),
  );
  if (icon.isEmpty()) throw new Error("Unable to load tray icon");
  return icon;
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#111615",
    title: "ZX Wallpaper",
    icon: createBrandIcon(),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const devServerUrl =
    process.env.VITE_DEV_SERVER_URL ??
    (!app.isPackaged ? "http://127.0.0.1:5173" : undefined);
  if (devServerUrl) void mainWindow.loadURL(devServerUrl);
  else
    void mainWindow.loadFile(
      path.join(import.meta.dirname, "../dist/index.html"),
    );
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}
function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}
function refreshTray() {
  if (!tray) return;
  const state = service.getState();
  tray.setImage(createTrayIcon());
  tray.setToolTip(
    state.paused ? "ZX Wallpaper - 已暂停" : "ZX Wallpaper - 正在运行",
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "下一张",
        enabled: !state.paused && state.availableCount > 0,
        click: () => void service.nextWallpaper(),
      },
      {
        label: "跳过当前图片",
        enabled: Boolean(state.currentPath),
        click: () => void service.skipCurrentWallpaper(),
      },
      {
        label: state.paused ? "恢复自动切换" : "暂停自动切换",
        click: () => void service.togglePaused(),
      },
      { type: "separator" },
      { label: "打开设置", click: showWindow },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}
function broadcastState() {
  refreshTray();
  mainWindow?.webContents.send("state:changed", service.getState());
}

app.whenReady().then(async () => {
  const store = new ConfigStore(
    path.join(app.getPath("userData"), "settings.json"),
  );
  await store.load();
  service = new WallpaperService(store, broadcastState);
  await service.init();
  protocol.handle(
    "zx-wallpaper-preview",
    (request) =>
      service.getCurrentPreviewResponse(request.url) ??
      new Response(null, { status: 404 }),
  );
  try {
    const current = (await runPowerShell(getWallpaperScript)).trim();
    if (!store.value.currentPath && current && existsSync(current))
      await store.update({ currentPath: current });
  } catch {}
  createWindow();
  tray = new Tray(createTrayIcon());
  tray.on("double-click", showWindow);
  refreshTray();
  if (!process.argv.includes("--background")) showWindow();
  ipcMain.handle("state:get", () => service.getState());
  ipcMain.handle("config:update", async (_event, patch: Partial<AppConfig>) => {
    await service.updateConfig(patch);
  });
  ipcMain.handle("folder:add", async () => {
    await service.addFolder();
  });
  ipcMain.handle("folder:remove", async (_event, id: string) => {
    await service.removeFolder(id);
  });
  ipcMain.handle("folder:update", async (_event, folder: WallpaperFolder) => {
    await service.updateFolder(folder);
  });
  ipcMain.handle("folder:open", (_event, id: string) => {
    service.openFolder(id);
  });
  ipcMain.handle("folder:rescan", async () => {
    await service.rescanFolders();
  });
  ipcMain.handle("wallpaper:next", async () => {
    await service.nextWallpaper();
  });
  ipcMain.handle("wallpaper:skip-current", async () => {
    await service.skipCurrentWallpaper();
  });
  ipcMain.handle(
    "wallpaper:restore-skipped",
    async (_event, filePath: string) => {
      await service.restoreSkippedPath(filePath);
    },
  );
  ipcMain.handle("wallpaper:restore-all-skipped", async () => {
    await service.restoreAllSkipped();
  });
  ipcMain.handle(
    "wallpaper:delete-skipped",
    async (_event, filePath: string) => {
      await service.deleteSkippedPath(filePath);
    },
  );
  ipcMain.handle("wallpaper:toggle-paused", async () => {
    await service.togglePaused();
  });
  ipcMain.handle("online:add-source", async (_event, url: string) => {
    await service.addOnlineSource(url);
  });
  ipcMain.handle(
    "online:update-source",
    async (_event, source: OnlineSource) => {
      await service.updateOnlineSource(source);
    },
  );
  ipcMain.handle("online:remove-source", async (_event, id: string) => {
    await service.removeOnlineSource(id);
  });
  ipcMain.handle("online:run-source", async (_event, id: string) => {
    await service.runOnlineSource(id);
  });
  ipcMain.handle("online:set-as-wallpaper", async (_event, id: string) => {
    await service.setOnlineImageAsWallpaper(id);
  });
  ipcMain.handle("online:delete-image", async (_event, id: string) => {
    await service.deleteOnlineImage(id);
  });
  ipcMain.handle("online:select-directory", async () => {
    await service.selectOnlineDirectory();
  });
  ipcMain.handle("online:reveal-image", (_event, id: string) => {
    service.revealOnlineImage(id);
  });
  powerMonitor.on("resume", () => void service.resumeIfDue());
  powerMonitor.on("unlock-screen", () => void service.resumeIfDue());
});
app.on("activate", showWindow);
app.on("window-all-closed", () => {});
app.on("will-quit", () => globalShortcut.unregisterAll());
ipcMain.handle("online:get-thumbnail", (_event, imageId: string) =>
  service.getOnlineThumbnail(imageId),
);
ipcMain.handle("wallpaper:get-skipped-thumbnail", (_event, filePath: string) =>
  service.getSkippedThumbnail(filePath),
);
async function runPowerShell(
  script: string,
  environment: Record<string, string> = {},
) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { env: { ...process.env, ...environment }, windowsHide: true },
  );
  return stdout;
}
