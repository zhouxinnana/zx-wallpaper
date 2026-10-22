import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { pathKey, pathName, samePath } from "./shared/paths";
import {
  Archive,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Images,
  Keyboard,
  LayoutDashboard,
  LoaderCircle,
  Monitor,
  MonitorCog,
  MoreHorizontal,
  Maximize2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  SkipForward,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import type {
  AppConfig,
  AppState,
  DesktopRuntime,
  OnlineImage,
  OnlineSyncLog,
  OnlineSource,
  PreviewItem,
  RotationOrder,
  ShortcutStatus,
  TaggingStatus,
  WallpaperFolder,
  WallpaperMode,
} from "./runtime/types";
import { tauriRuntime } from "./runtime/tauri-runtime";

const previewImage =
  "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1600&q=85";

/** 切换间隔的手动输入范围（分钟）：与后端 `update_preferences` 的钳制保持一致。 */
const INTERVAL_MINUTES = { min: 1, max: 43_200 } as const;

const displayModes: Array<{ value: WallpaperMode; label: string }> = [
  { value: "fill", label: "填充" },
  { value: "fit", label: "适应" },
  { value: "stretch", label: "拉伸" },
  { value: "tile", label: "平铺" },
  { value: "center", label: "居中" },
  { value: "span", label: "跨区" },
];

const onlineIntervals = [1, 6, 12, 24] as const;
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
const GALLERY_PAGE_SIZE = 48;
export const SUCCESS_STATUS_DURATION_MS = 3_000;
type View = "workbench" | "gallery" | "favorites" | "lab" | "settings";

/** 图库条目：在线下载图与本地目录图字段不对等，用判别联合表达，不用假数据补齐。 */
type GalleryItem =
  | { kind: "online"; path: string; online: OnlineImage }
  | { kind: "local"; path: string; folderId: string; folderEnabled: boolean; modifiedAt: string | null };

type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel: string;
  busyKey: string;
  action: () => Promise<unknown>;
};

const navigation: Array<{
  key: View;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
}> = [
  { key: "workbench", label: "工作台", subtitle: "本地壁纸与切换", icon: LayoutDashboard },
  { key: "gallery", label: "图库", subtitle: "浏览与治理", icon: Images },
  { key: "favorites", label: "我的喜欢", subtitle: "保留的壁纸", icon: Heart },
  { key: "lab", label: "实验室", subtitle: "后置实验性功能", icon: WandSparkles },
  { key: "settings", label: "设置", subtitle: "偏好与系统集成", icon: Settings },
];

export default function App({ runtime }: { runtime?: DesktopRuntime }) {
  const [api] = useState(() => runtime ?? createDefaultRuntime());
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>("workbench");
  /** 图库来源由 App 持有，这样工作台的「查看 N 张」能直接跳到对应目录 tab。 */
  const [gallerySource, setGallerySource] = useState(ALL_GALLERY_SOURCE);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions | null>(null);
  const busyRef = useRef(false);
  const statusTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    void api.getState().then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setError("无法读取应用状态，请重试。");
      },
    );

    void api.onStateChanged((next) => {
      if (active) setState(next);
    }).then((stop) => {
      if (!active) {
        stop();
        return;
      }
      unsubscribe = stop;
    }, () => {
      if (active) setError("无法读取应用状态，请重试。");
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!state || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => {
      document.documentElement.dataset.theme =
        state.followSystemTheme && !media.matches ? "light" : "dark";
    };
    syncTheme();
    media.addEventListener?.("change", syncTheme);
    return () => media.removeEventListener?.("change", syncTheme);
  }, [state?.followSystemTheme]);

  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    busyRef.current = true;
    setBusy(key);
    setError(null);
    setStatus(operationMessage(key, "pending"));
    try {
      const nextState = await action();
      if (isAppState(nextState)) {
        setState(nextState);
      }
      const successMessage = operationMessage(key, "success");
      setStatus(successMessage);
      statusTimerRef.current = window.setTimeout(() => {
        setStatus((current) => current === successMessage ? null : current);
        statusTimerRef.current = null;
      }, SUCCESS_STATUS_DURATION_MS);
    } catch (cause) {
      setStatus(null);
      setError(operationError(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  const updateConfig = useCallback(
    (patch: Partial<AppConfig>) => void run("config", () => api.updateConfig(patch)),
    [api, run],
  );
  const openViewer = useCallback((filePath: string) => setViewerPath(filePath), []);
  /** 跳到图库并定位到指定本地目录来源。 */
  const openGallery = useCallback((folderId: string) => { setGallerySource(folderId); setView("gallery"); }, []);
  const openConfirm = useCallback((options: ConfirmOptions) => setConfirmOptions(options), []);
  const closeConfirm = useCallback(() => setConfirmOptions(null), []);
  const confirmAction = useCallback(async () => {
    const options = confirmOptions;
    setConfirmOptions(null);
    if (options) await run(options.busyKey, options.action);
  }, [confirmOptions, run]);

  if (!state) return <LoadingScreen />;

  const activeNavigation = navigation.find((item) => item.key === view)!;
  const content = {
    workbench: <WorkbenchView api={api} state={state} busy={busy} run={run} updateConfig={updateConfig} onOpenViewer={openViewer} openConfirm={openConfirm} onOpenGallery={openGallery} />,
    gallery: <GalleryView api={api} state={state} busy={busy} run={run} updateConfig={updateConfig} onOpenViewer={openViewer} openConfirm={openConfirm} source={gallerySource} onSourceChange={setGallerySource} />,
    favorites: <FavoritesView api={api} state={state} busy={busy} run={run} onOpenViewer={openViewer} />,
    lab: <LabView />,
    settings: <SettingsView state={state} api={api} busy={busy} run={run} updateConfig={updateConfig} />,
  }[view];
  const viewerFileDelete = viewerPath && state.skippedPaths.some((path) => samePath(path, viewerPath)) ? {
    fileName: pathName(viewerPath),
    onConfirm: () => openConfirm({
      title: "删除图片文件",
      description: `将从磁盘删除 ${pathName(viewerPath)}，移入系统回收站，并同步移除其跳过与喜欢记录。`,
      confirmLabel: "删除文件",
      busyKey: "delete-skipped-file",
      action: async () => {
        await api.deleteSkippedPath(viewerPath);
        setViewerPath(null);
      },
    }),
  } : undefined;

  return (
    <div className="zx-app-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <span className="zx-mark" aria-hidden="true">ZX</span>
          <span>ZX Wallpaper</span>
          <span className="titlebar-version">v0.1.5</span>
        </div>
      </header>
      <div className="app-body">
        <aside className="prototype-sidebar">
          <nav aria-label="主导航">
            {navigation.map((item) => {
              const Icon = item.icon;
              const active = item.key === view;
              return (
                <button
                  key={item.key}
                  type="button"
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={active ? "prototype-nav-item is-active" : "prototype-nav-item"}
                  onClick={() => setView(item.key)}
                >
                  <Icon size={16} />
                  <span className="prototype-nav-copy">
                    <strong>{item.label}{item.key === "lab" && <em>β</em>}</strong>
                    <small>{item.subtitle}</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-runtime">
            <span className={state.paused ? "runtime-dot is-paused" : "runtime-dot"} />
            <span>{state.paused ? "已暂停" : "后台运行中"}</span>
            <small>ZX Wallpaper · v0.1.5</small>
          </div>
        </aside>
        <main className="prototype-main">
          <div className="page-titlebar">
            <h1>{activeNavigation.label}</h1>
            <span>{activeNavigation.subtitle}</span>
            {view === "lab" && <span className="beta-label">后置实验性功能</span>}
          </div>
          {error && (
            <div className="runtime-error" role="alert">
              <CircleAlert size={15} /> {error}
            </div>
          )}
          {status && (
            <div className="runtime-status" role="status" aria-live="polite">
              {busy && <LoaderCircle className="spin" size={15} />} {status}
            </div>
          )}
          {content}
        </main>
      </div>
      {viewerPath && <OriginalImageViewer api={api} filePath={viewerPath} onClose={() => setViewerPath(null)} fileDelete={viewerFileDelete} />}
      {confirmOptions && <ConfirmDialog options={confirmOptions} busy={busy} onConfirm={confirmAction} onCancel={closeConfirm} />}
    </div>
  );
}

function WorkbenchView({
  api,
  state,
  busy,
  run,
  updateConfig,
  onOpenViewer,
  openConfirm,
  onOpenGallery,
}: {
  api: DesktopRuntime;
  state: AppState;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => void;
  onOpenViewer: (filePath: string) => void;
  openConfirm: (options: ConfirmOptions) => void;
  onOpenGallery: (folderId: string) => void;
}) {
  const [skippedFilter, setSkippedFilter] = useState("");
  const folders = state.folders.filter((folder) => folder.id !== "online-library");
  const keyword = skippedFilter.trim().toLowerCase();
  const skippedPaths = keyword
    ? state.skippedPaths.filter((path) => pathName(path).toLowerCase().includes(keyword))
    : state.skippedPaths;
  const currentName = pathName(state.currentPath ?? "") || "尚未选择壁纸";
  const currentPath = state.currentPath ?? "";
  const currentIsFavorite = Boolean(currentPath) && state.favoritePaths.some((path) => samePath(path, currentPath));
  const currentPreviewUrl = state.previewUrl ?? previewImage;
  const [previousPreview, setPreviousPreview] = useState<{ path: string; url: string } | null>(null);
  const lastPreviewRef = useRef<{ path: string; url: string } | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const current = { path: currentPath, url: currentPreviewUrl };
    const previous = lastPreviewRef.current;
    if (previous && !samePath(previous.path, current.path)) {
      setPreviousPreview(previous);
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
      transitionTimerRef.current = window.setTimeout(() => setPreviousPreview(null), 550);
    }
    lastPreviewRef.current = current;
  }, [currentPath, currentPreviewUrl]);

  useEffect(() => {
    if (state.paused) {
      setNow(Date.now());
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.paused, state.lastSwitchAt, state.intervalMinutes]);

  useEffect(() => () => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
  }, []);

  const switchProgress = getAutoSwitchProgress(state.lastSwitchAt, state.intervalMinutes, now);
  return (
    <div className="prototype-page workbench-page">
      <section className="wallpaper-hero" aria-label="当前壁纸">
        {previousPreview && <img className="hero-image hero-image-previous" src={previousPreview.url} alt="" aria-hidden="true" />}
        <CurrentPreview path={currentPath} previewUrl={currentPreviewUrl} api={api} />
        <div className="wallpaper-tint" />
        <div className="hero-status">
          <span className={state.paused ? "runtime-dot is-paused" : "runtime-dot"} />
          {state.paused ? "已暂停" : "自动切换中"}
          {!state.paused && <small>· {formatInterval(state.intervalMinutes)}</small>}
        </div>
        {state.previewItems.length > 0 && <div className="hero-thumbnails" aria-label="预览图片切换">
          {state.previewItems.map((item) => {
            const isCurrent = samePath(item.path, currentPath);
            return <button
              key={item.path}
              type="button"
              className={isCurrent ? "is-current" : undefined}
              aria-label={`切换到 ${pathName(item.path)}`}
              aria-current={isCurrent ? "true" : undefined}
              disabled={isCurrent || busy !== null}
              onClick={() => void run("select-preview", () => api.selectWallpaper(item.path))}
            >
              <PreviewThumbnail item={item} api={api} />
            </button>;
          })}
        </div>}
        <div className="hero-details">
          <div>
            <strong>{currentName}</strong>
            <span>{parentPath(state.currentPath ?? "")}</span>
          </div>
          <div className="hero-tags"><button className="icon-button" type="button" aria-label={`查看原图 ${currentName}`} title="查看原图" disabled={!currentPath} onClick={() => onOpenViewer(currentPath)}><Maximize2 size={16} /></button><button className={currentIsFavorite ? "icon-button favorite-toggle is-favorite" : "icon-button favorite-toggle"} type="button" aria-label={`${currentIsFavorite ? "取消喜欢" : "喜欢"} ${currentName}`} title={currentIsFavorite ? "取消喜欢" : "喜欢"} disabled={!currentPath || busy !== null} onClick={() => void run("favorite-current", () => api.toggleFavorite(currentPath))}><Heart size={16} fill={currentIsFavorite ? "currentColor" : "none"} /></button><Tag tone="cyan">所有显示器同步</Tag></div>
        </div>
        {!state.paused && <div className="hero-progress" aria-label={`自动切换进度 ${Math.round(switchProgress * 100)}%`}>
          <div className="hero-progress-fill" style={{ width: `${switchProgress * 100}%` }} />
        </div>}
      </section>
      <section className="hero-controls" aria-label="壁纸控制">
        <button className="action-button is-primary" type="button" disabled={busy === "next"} onClick={() => void run("next", () => api.nextWallpaper())}>
          <SkipForward size={15} /> 下一张
        </button>
        <button className="action-button" type="button" disabled={busy === "pause"} onClick={() => void run("pause", () => api.togglePaused())}>
          {state.paused ? <Play size={15} /> : <Pause size={15} />} {state.paused ? "恢复切换" : "暂停切换"}
        </button>
        <button className="action-button" type="button" disabled={busy === "skip" || !state.currentPath} onClick={() => void run("skip", () => api.skipCurrentWallpaper())}>
          <SkipForward size={15} /> 跳过此图
        </button>
        <span className="control-divider" />
        <label className="inline-select">显示方式
          <select aria-label="显示方式" value={state.displayMode} onChange={(event) => updateConfig({ displayMode: event.target.value as WallpaperMode })}>
            {displayModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </label>
        <button className="action-button is-icon-right" type="button" disabled title="当前壁纸所在目录由系统能力提供"><FolderOpen size={15} /></button>
      </section>
      {state.wallpaperHistory.length > 0 && <section className="content-section history-section" aria-label="最近壁纸">
        <SectionHeading title="最近壁纸" />
        <div className="history-strip">
          {state.wallpaperHistory.filter((path) => !samePath(path, currentPath)).map((path) => (
            <HistoryCard key={path} path={path} api={api} busy={busy} run={run} />
          ))}
        </div>
      </section>}
      <section className="content-section">
        <SectionHeading title="壁纸目录" action={<button className="action-button is-primary is-small" type="button" disabled={busy === "folder"} onClick={() => void run("folder", () => api.addFolder())}><Plus size={14} /> 添加目录</button>} />
        <div className="folder-table">
          {folders.length === 0 ? <EmptyState text="尚未添加壁纸目录" /> : folders.map((folder) => (
            <FolderRow key={folder.id} folder={folder} status={state.folderStatuses[folder.id]} libraryCount={state.libraryImages.filter((image) => image.folderId === folder.id).length} busy={busy} api={api} run={run} onOpenGallery={onOpenGallery} />
          ))}
        </div>
      </section>
      <section className="content-section skipped-section">
        <SectionHeading title={<>已跳过图片 {state.skippedPaths.length > 0 && <b>({state.skippedPaths.length})</b>}</>} action={state.skippedPaths.length ? <div className="section-actions"><input className="section-filter-input" type="search" aria-label="筛选已跳过图片" placeholder="按文件名筛选" value={skippedFilter} onChange={(event) => setSkippedFilter(event.target.value)} /><button className="action-button is-small" type="button" onClick={() => void run("restore-all", () => api.restoreAllSkipped())}>全部恢复</button><button className="action-button is-small is-danger" type="button" disabled={busy !== null} onClick={() => openConfirm({ title: "删除全部已跳过图片", description: `将把 ${state.skippedPaths.length} 张图片从磁盘删除并移入系统回收站，同时移除其喜欢记录。回收站中的文件仍可手动还原。`, confirmLabel: "全部删除", busyKey: "delete-all-skipped", action: () => api.deleteAllSkipped() })}>全部删除</button></div> : undefined} />
        {state.skippedPaths.length === 0 ? <EmptyState text="暂无跳过的图片" /> : skippedPaths.length === 0 ? <EmptyState text="没有匹配的图片" /> : <div className="skipped-grid">
          {skippedPaths.map((path) => <SkippedCard key={path} path={path} previewUrl={state.previewUrl ?? previewImage} api={api} run={run} onOpenViewer={onOpenViewer} />)}
        </div>}
      </section>
    </div>
  );
}

function PreviewThumbnail({ item, api }: { item: PreviewItem; api: DesktopRuntime }) {
  const [thumbnail, setThumbnail] = useState(item.previewUrl ?? previewImage);

  useEffect(() => {
    let active = true;
    void api.getImageAsset(item.path, "strip").then((asset) => {
      if (active && asset) setThumbnail(asset.src);
    });
    return () => { active = false; };
  }, [api, item.path]);

  return <img src={thumbnail} alt="" decoding="async" />;
}

function CurrentPreview({ path, previewUrl, api }: { path: string; previewUrl: string; api: DesktopRuntime }) {
  const [thumbnail, setThumbnail] = useState(previewUrl);

  useEffect(() => {
    let active = true;
    setThumbnail(previewUrl);
    if (!path) return () => { active = false; };
    void (async () => {
      const grid = await api.getImageAsset(path, "grid");
      if (active && grid) setThumbnail(grid.src);
      const hero = await api.getImageAsset(path, "hero");
      if (active && hero) setThumbnail(hero.src);
    })().catch(() => {});
    return () => { active = false; };
  }, [api, path, previewUrl]);

  return <img className="hero-image hero-image-current" key={path || thumbnail} src={thumbnail} alt="当前壁纸预览" decoding="async" />;
}

function FolderRow({ folder, status, libraryCount, busy, api, run, onOpenGallery }: { folder: WallpaperFolder; status: AppState["folderStatuses"][string] | undefined; libraryCount: number; busy: string | null; api: DesktopRuntime; run: (key: string, action: () => Promise<unknown>) => Promise<void>; onOpenGallery: (folderId: string) => void }) {
  const label = status?.kind === "unavailable" ? "不可访问" : status?.kind === "empty" ? "无图片" : status?.invalidCount ? `${status.invalidCount} 无效` : "正常";
  const tone = status?.kind === "unavailable" ? "red" : status?.kind === "empty" || status?.invalidCount ? "amber" : "green";
  return <div className="folder-row">
    <Toggle label={`启用 ${folder.path}`} checked={folder.enabled} onChange={(enabled) => void run(`folder-${folder.id}`, () => api.updateFolder({ ...folder, enabled }))} />
    <strong>{pathName(folder.path)}</strong>
    <span className="folder-path">{folder.path}</span>
    <span className="folder-count">{status?.kind === "available" ? status.availableCount : "—"}</span>
    <Tag tone={tone}>{label}</Tag>
    <div className="row-actions">
      <button type="button" aria-label={`在图库中查看 ${folder.path} 的 ${libraryCount} 张图片`} title="在图库中查看" disabled={libraryCount === 0} onClick={() => onOpenGallery(folder.id)}><Images size={14} /></button>
      <button type="button" aria-label={`重新扫描 ${folder.path}`} disabled={busy === `scan-${folder.id}`} onClick={() => void run(`scan-${folder.id}`, () => api.rescanFolders())}><RefreshCw size={14} /></button>
      <button type="button" aria-label={`打开 ${folder.path}`} onClick={() => void run(`open-${folder.id}`, () => api.openFolder(folder.id))}><FolderOpen size={14} /></button>
      <button type="button" aria-label={`移除 ${folder.path}`} className="danger" onClick={() => void run(`remove-${folder.id}`, () => api.removeFolder(folder.id))}><Trash2 size={14} /></button>
    </div>
  </div>;
}

function HistoryCard({ path, api, busy, run }: { path: string; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const [thumbnail, setThumbnail] = useState(previewImage);
  useEffect(() => { let active = true; void api.getImageAsset(path, "strip").then((asset) => { if (active && asset) setThumbnail(asset.src); }); return () => { active = false; }; }, [api, path]);
  return <button
    className="history-item"
    type="button"
    title={`回到 ${pathName(path)}`}
    aria-label={`回到 ${pathName(path)}`}
    disabled={busy !== null}
    onClick={() => void run(`history-${path}`, () => api.selectWallpaper(path))}
  >
    <img src={thumbnail} alt="" loading="lazy" decoding="async" />
    <small>{pathName(path)}</small>
  </button>;
}

function SkippedCard({ path, previewUrl, api, run, onOpenViewer }: { path: string; previewUrl: string; api: DesktopRuntime; run: (key: string, action: () => Promise<unknown>) => Promise<void>; onOpenViewer: (filePath: string) => void }) {
  const [thumbnail, setThumbnail] = useState(previewUrl);
  useEffect(() => { let active = true; void api.getImageAsset(path, "grid").then((asset) => { if (active && asset) setThumbnail(asset.src); }); return () => { active = false; }; }, [api, path]);
  return <article className="skipped-card">
    <img src={thumbnail} alt="" loading="lazy" decoding="async" />
    <strong title={pathName(path)}>{pathName(path)}</strong>
    <div><button className="action-button is-small" type="button" onClick={() => void run(`restore-${path}`, () => api.restoreSkippedPath(path))}>恢复</button><button className="icon-button" type="button" aria-label={`查看原图 ${pathName(path)}`} title="查看原图" onClick={() => onOpenViewer(path)}><Maximize2 size={14} /></button></div>
  </article>;
}

function FavoritesView({ api, state, busy, run, onOpenViewer }: { api: DesktopRuntime; state: AppState; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; onOpenViewer: (filePath: string) => void }) {
  const onlineImages = new Map(state.onlineImages.map((image) => [image.localPath.toLowerCase(), image]));
  const [favoriteFilter, setFavoriteFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const tagByPath = new Map(state.imageTags.map((tag) => [tag.path.toLowerCase(), tag.category]));
  const keyword = favoriteFilter.trim().toLowerCase();
  const favoritePaths = (keyword
    ? state.favoritePaths.filter((path) => pathName(path).toLowerCase().includes(keyword))
    : state.favoritePaths
  ).filter((path) => matchesCategoryFilter(path, tagByPath, categoryFilter));
  return <div className="prototype-page favorites-page">
    <section className="content-section favorite-section">
      <SectionHeading title={<>喜欢的壁纸 {state.favoritePaths.length > 0 && <b>({state.favoritePaths.length})</b>}</>} action={state.favoritePaths.length > 0 ? <div className="section-actions">{state.taggingEnabled && <label className="inline-select">分类<select aria-label="按分类筛选喜欢的壁纸" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部分类</option>{upx8Categories.map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}<option value="untagged">未打标</option></select></label>}<input className="section-filter-input" type="search" aria-label="筛选喜欢的壁纸" placeholder="按文件名筛选" value={favoriteFilter} onChange={(event) => setFavoriteFilter(event.target.value)} /></div> : undefined} />
      {state.favoritePaths.length === 0 ? <EmptyState text="暂无喜欢的壁纸" /> : favoritePaths.length === 0 ? <EmptyState text="没有匹配的壁纸" /> : <div className="favorite-grid">{favoritePaths.map((path) => <FavoriteCard key={path} path={path} onlineImage={onlineImages.get(path.toLowerCase())} api={api} busy={busy} run={run} onOpenViewer={onOpenViewer} />)}</div>}
    </section>
  </div>;
}

function FavoriteCard({ path, onlineImage, api, busy, run, onOpenViewer }: { path: string; onlineImage?: OnlineImage; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; onOpenViewer: (filePath: string) => void }) {
  const [thumbnail, setThumbnail] = useState(previewImage);
  useEffect(() => { let active = true; void api.getImageAsset(path, "grid").then((asset) => { if (active && asset) setThumbnail(asset.src); }); return () => { active = false; }; }, [api, path]);
  const setFavoriteWallpaper = () => onlineImage ? api.setOnlineImageAsWallpaper(onlineImage.id) : api.selectWallpaper(path);
  return <article className="favorite-card">
    <img src={thumbnail} alt={pathName(path)} loading="lazy" decoding="async" />
    <div><strong title={pathName(path)}>{pathName(path)}</strong><span title={parentPath(path)}>{parentPath(path)}</span><div className="image-actions"><button className="action-button is-small is-primary" type="button" disabled={busy !== null} onClick={() => void run(`set-favorite-${path}`, setFavoriteWallpaper)}>设为壁纸</button><button className="icon-button" type="button" aria-label={`查看原图 ${pathName(path)}`} title="查看原图" onClick={() => onOpenViewer(path)}><Maximize2 size={14} /></button><button className="icon-button" type="button" aria-label={`打开 ${pathName(path)}`} title="打开所在目录" disabled={busy !== null} onClick={() => void run(`reveal-favorite-${path}`, () => api.revealWallpaper(path))}><FolderOpen size={14} /></button><button className="icon-button favorite-toggle is-favorite" type="button" aria-label={`取消喜欢 ${pathName(path)}`} title="取消喜欢" disabled={busy !== null} onClick={() => void run(`favorite-${path}`, () => api.toggleFavorite(path))}><Heart size={14} fill="currentColor" /></button></div></div>
  </article>;
}

/** 图库排序方式。时间口径：在线图用下载时间，本地图用文件修改时间（扫描时带出）。 */
type GallerySort = "name" | "time";
const gallerySortOptions: { value: GallerySort; label: string }[] = [
  { value: "name", label: "按名称" },
  { value: "time", label: "按时间（新→旧）" },
];

function galleryTimestamp(item: GalleryItem): number | null {
  const raw = item.kind === "online" ? item.online.downloadedAt : item.modifiedAt;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareGalleryItems(left: GalleryItem, right: GalleryItem, sort: GallerySort): number {
  if (sort === "time") {
    const leftTime = galleryTimestamp(left);
    const rightTime = galleryTimestamp(right);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
    // 拿不到时间的（元数据读取失败）沉到最后，别插在有效时间中间。
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
  }
  return left.path.localeCompare(right.path);
}

const ALL_GALLERY_SOURCE = "all";
const ONLINE_GALLERY_SOURCE = "online";

function GalleryView({ api, state, busy, run, updateConfig, onOpenViewer, openConfirm, source, onSourceChange }: { api: DesktopRuntime; state: AppState; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; updateConfig: (patch: Partial<AppConfig>) => void; onOpenViewer: (filePath: string) => void; openConfirm: (options: ConfirmOptions) => void; source: string; onSourceChange: (source: string) => void }) {
  const [galleryFilter, setGalleryFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sort, setSort] = useState<GallerySort>("name");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(GALLERY_PAGE_SIZE);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [marqueeActive, setMarqueeActive] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const marqueeStartRef = useRef<{ x: number; y: number; clientX: number; clientY: number; additive: boolean; cardPath: string | null } | null>(null);
  const marqueeRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const marqueeMovedRef = useRef(false);
  /** 最近一次卡片按下的坐标：用来区分「真点击」和「框选结束后浏览器补发的那次 click」。 */
  const pointerDownRef = useRef<{ path: string; x: number; y: number } | null>(null);  const prewarmedImagePaths = useRef(new Set<string>());
  const galleryKeyword = galleryFilter.trim().toLowerCase();
  const tagByPath = useMemo(() => new Map(state.imageTags.map((tag) => [pathKey(tag.path), tag.category])), [state.imageTags]);
  const folderById = useMemo(() => new Map(state.folders.map((folder) => [folder.id, folder])), [state.folders]);
  const skippedKeys = useMemo(() => new Set(state.skippedPaths.map(pathKey)), [state.skippedPaths]);
  const favoriteKeys = useMemo(() => new Set(state.favoritePaths.map(pathKey)), [state.favoritePaths]);
  const currentKey = state.currentPath ? pathKey(state.currentPath) : null;

  /** 在线图与本地图合并去重后按当前排序方式排列；与轮转顺序无关，UI 上有标注。 */
  const items = useMemo(() => {
    const deduped = new Map<string, GalleryItem>();
    for (const image of state.onlineImages) deduped.set(pathKey(image.localPath), { kind: "online", path: image.localPath, online: image });
    for (const image of state.libraryImages) {
      const key = pathKey(image.path);
      if (deduped.has(key)) continue;
      deduped.set(key, { kind: "local", path: image.path, folderId: image.folderId, folderEnabled: image.folderEnabled, modifiedAt: image.modifiedAt });
    }
    return [...deduped.values()].sort((left, right) => compareGalleryItems(left, right, sort));
  }, [state.onlineImages, state.libraryImages, sort]);

  const sourceTabs = useMemo(() => [
    { id: ALL_GALLERY_SOURCE, label: "全部", count: items.length, enabled: true },
    { id: ONLINE_GALLERY_SOURCE, label: "在线下载", count: state.onlineImages.length, enabled: true },
    // 受管在线目录由 config.online_directory 单独管理，不是用户目录，不作为来源 tab。
    ...state.folders.filter((folder) => folder.id !== "online-library").map((folder) => ({
      id: folder.id,
      label: pathName(folder.path),
      count: items.filter((item) => item.kind === "local" && item.folderId === folder.id).length,
      enabled: folder.enabled,
    })),
  ], [items, state.folders, state.onlineImages.length]);

  const images = items
    .filter((item) => source === ALL_GALLERY_SOURCE ? true : source === ONLINE_GALLERY_SOURCE ? item.kind === "online" : item.kind === "local" && item.folderId === source)
    .filter((item) => !galleryKeyword || item.path.toLowerCase().includes(galleryKeyword))
    .filter((item) => matchesCategoryFilter(item.path, tagByPath, categoryFilter));

  const totalPages = Math.max(1, Math.ceil(images.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = images.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pathByKey = useMemo(() => new Map(items.map((item) => [pathKey(item.path), item.path])), [items]);
  const selectedPathList = useMemo(() => [...selectedPaths].map((key) => pathByKey.get(key)).filter((path): path is string => path !== undefined), [selectedPaths, pathByKey]);
  const pageSelectedCount = pageItems.filter((item) => selectedPaths.has(pathKey(item.path))).length;
  const everySelectedSkipped = selectedPathList.length > 0 && selectedPathList.every((path) => skippedKeys.has(pathKey(path)));
  const everySelectedFavorite = selectedPathList.length > 0 && selectedPathList.every((path) => favoriteKeys.has(pathKey(path)));
  const multiSelected = selectedPaths.size > 1;
  const selectedLog = state.onlineSyncLogs.find((log) => log.id === selectedLogId) ?? null;

  const clearSelection = () => setSelectedPaths(new Set());
  const toggleSelected = (path: string) => {
    const key = pathKey(path);
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const selectPage = () => setSelectedPaths((current) => { const next = new Set(current); pageItems.forEach((item) => next.add(pathKey(item.path))); return next; });
  const unselectPage = () => setSelectedPaths((current) => { const next = new Set(current); pageItems.forEach((item) => next.delete(pathKey(item.path))); return next; });
  const selectAllFiltered = () => setSelectedPaths(new Set(images.map((item) => pathKey(item.path))));
  const invertPage = () => setSelectedPaths((current) => {
    const next = new Set(current);
    pageItems.forEach((item) => { const key = pathKey(item.path); if (next.has(key)) next.delete(key); else next.add(key); });
    return next;
  });

  useEffect(() => { clearSelection(); }, [source, galleryFilter, categoryFilter]);
  useEffect(() => { setPage(1); }, [source, galleryFilter, categoryFilter, pageSize, sort]);
  useEffect(() => {
    setSelectedLogId((current) => current && state.onlineSyncLogs.some((log) => log.id === current) ? current : null);
  }, [state.onlineSyncLogs]);

  /** 框选：按住左键在网格里拖出一个矩形，松手时把与矩形相交的卡片纳入选择。 */
  useEffect(() => {
    if (!marqueeActive) return;
    const onMove = (event: MouseEvent) => {
      const container = gridRef.current;
      const start = marqueeStartRef.current;
      if (!container || !start) return;
      const bounds = container.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      if (!marqueeMovedRef.current && Math.abs(x - start.x) + Math.abs(y - start.y) < 4) return;
      marqueeMovedRef.current = true;
      const rect = { left: Math.min(start.x, x), top: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
      marqueeRectRef.current = rect;
      setMarquee(rect);
    };
    const onUp = (event: MouseEvent) => {
      const container = gridRef.current;
      const start = marqueeStartRef.current;
      const rect = marqueeRectRef.current;
      if (container && start && rect && marqueeMovedRef.current) {
        const bounds = container.getBoundingClientRect();
        const region = { left: bounds.left + rect.left, top: bounds.top + rect.top, right: bounds.left + rect.left + rect.width, bottom: bounds.top + rect.top + rect.height };
        const hit: string[] = [];
        container.querySelectorAll<HTMLElement>("[data-gallery-path]").forEach((card) => {
          const cardBounds = card.getBoundingClientRect();
          if (cardBounds.left < region.right && cardBounds.right > region.left && cardBounds.top < region.bottom && cardBounds.bottom > region.top) {
            const path = card.dataset.galleryPath;
            if (path) hit.push(path);
          }
        });
        if (hit.length > 0) {
          setSelectedPaths((current) => {
            const next = start.additive ? new Set(current) : new Set<string>();
            hit.forEach((path) => next.add(pathKey(path)));
            return next;
          });
        }
        // 浏览器在 mouseup 之后还会在起点卡片上补发一次 click。那次 click 的坐标是
        // 松开时的位置，与按下位置不同；用它和按下坐标比对，就能把拖拽余波和真点击区分开。
        pointerDownRef.current = start.cardPath ? { path: start.cardPath, x: start.clientX, y: start.clientY } : null;
      }
      marqueeStartRef.current = null;
      marqueeRectRef.current = null;
      marqueeMovedRef.current = false;
      setMarquee(null);
      setMarqueeActive(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marqueeActive]);

  const handleGridMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 控件上的按下不启动框选，避免和按钮、复选框打架。
    if (target.closest("button, input, label, a")) return;
    const container = gridRef.current;
    if (!container) return;
    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    const cardPath = target.closest("[data-gallery-path]")?.getAttribute("data-gallery-path") ?? null;
    marqueeStartRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, clientX: event.clientX, clientY: event.clientY, additive: event.ctrlKey || event.metaKey, cardPath };
    pointerDownRef.current = cardPath ? { path: cardPath, x: event.clientX, y: event.clientY } : null;
    marqueeMovedRef.current = false;
    marqueeRectRef.current = null;
    setMarqueeActive(true);
  };
  const handleCardClick = (path: string, event: ReactMouseEvent<HTMLElement>) => {
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    // 拖拽结束后浏览器会在起点卡片补发一次 click；它的坐标是松开位置，与按下位置不同。
    // 坐标一致才是用户真的点了一下。
    if (down && down.path === path && (Math.abs(event.clientX - down.x) > 2 || Math.abs(event.clientY - down.y) > 2)) return;
    toggleSelected(path);
  };

  useEffect(() => {
    const filePaths = images
      .slice((currentPage - 1) * pageSize, currentPage * pageSize + pageSize)
      .map((item) => item.path)
      .filter((filePath) => !prewarmedImagePaths.current.has(filePath));
    if (filePaths.length === 0) return;
    filePaths.forEach((filePath) => prewarmedImagePaths.current.add(filePath));
    void api.prewarmImageAssets(filePaths, "grid").catch(() => {
      filePaths.forEach((filePath) => prewarmedImagePaths.current.delete(filePath));
    });
  }, [api, images, currentPage, pageSize]);

  const runBatch = (key: string, action: () => Promise<unknown>) => run(key, async () => { await action(); clearSelection(); });
  const pageNumbers = useMemo(() => {
    const pages: number[] = [];
    const window = 2;
    for (let index = 1; index <= totalPages; index += 1) {
      if (index === 1 || index === totalPages || Math.abs(index - currentPage) <= window) pages.push(index);
    }
    return pages;
  }, [currentPage, totalPages]);

  return <div className="prototype-page online-page">
    <div className="online-layout">
      <div className="online-primary">
        <section className="content-section gallery-section">
          <SectionHeading title={<>图库 <b>({images.length})</b></>} action={<div className="gallery-controls"><input className="section-filter-input" type="search" aria-label="筛选图库图片" placeholder="按文件名筛选" value={galleryFilter} onChange={(event) => { setGalleryFilter(event.target.value); }} />{state.taggingEnabled && <label className="inline-select">分类<select aria-label="按分类筛选图库图片" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); }}><option value="all">全部分类</option>{upx8Categories.map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}<option value="untagged">未打标</option></select></label>}<label className="inline-select">排序<select aria-label="图库排序方式" value={sort} onChange={(event) => setSort(event.target.value as GallerySort)}>{gallerySortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button className="action-button is-small" type="button" aria-label="刷新图库" disabled={busy !== null} onClick={() => void run("refresh-gallery", () => api.rescanFolders())}><RefreshCw size={14} /> 刷新</button></div>} />
          <div className="gallery-source-tabs" role="tablist" aria-label="图库来源">
            {sourceTabs.map((tab) => <button key={tab.id} className={source === tab.id ? "gallery-source-tab is-active" : "gallery-source-tab"} type="button" role="tab" aria-selected={source === tab.id} onClick={() => onSourceChange(tab.id)}>{tab.label}{!tab.enabled && <span className="gallery-source-flag">已停用</span>}<small>{tab.count}</small></button>)}
          </div>
          <p className="gallery-hint">当前{sort === "name" ? "按文件名排列" : "按更新时间排列（新→旧；本地图取文件修改时间，在线图取下载时间）"}，与切换顺序无关；停用目录的图片可见但不会参与轮转。点击图片或按住左键拖动可框选。</p>
          <div className="gallery-batch-bar" role="region" aria-label="批量操作">
            <span>已选 {selectedPaths.size} 张</span>
            <button className="action-button is-small" type="button" onClick={pageSelectedCount === pageItems.length && pageItems.length > 0 ? unselectPage : selectPage}>{pageSelectedCount === pageItems.length && pageItems.length > 0 ? "取消全选本页" : "全选本页"}</button>
            <button className="action-button is-small" type="button" onClick={selectAllFiltered}>全选筛选结果</button>
            <button className="action-button is-small" type="button" onClick={invertPage}>反选本页</button>
            <button className="action-button is-small" type="button" onClick={clearSelection}>清空</button>
            <span className="gallery-batch-divider" />
            <button className="action-button is-small" type="button" disabled={busy !== null || selectedPaths.size === 0} onClick={() => void runBatch("batch-skip", () => api.batchSkipPaths(selectedPathList))}>跳过</button>
            <button className="action-button is-small" type="button" disabled={busy !== null || selectedPaths.size === 0 || !everySelectedSkipped} title={everySelectedSkipped ? undefined : "仅当所选图片全部处于跳过状态时可用"} onClick={() => void runBatch("batch-restore", () => api.batchRestoreSkipped(selectedPathList))}>取消跳过</button>
            <button className="action-button is-small" type="button" disabled={busy !== null || selectedPaths.size === 0 || everySelectedFavorite} onClick={() => void runBatch("batch-favorite", () => api.batchFavorite(selectedPathList, true))}>喜欢</button>
            <button className="action-button is-small" type="button" disabled={busy !== null || selectedPaths.size === 0 || !everySelectedFavorite} onClick={() => void runBatch("batch-unfavorite", () => api.batchFavorite(selectedPathList, false))}>取消喜欢</button>
            <button className="action-button is-small is-danger" type="button" disabled={busy !== null || selectedPaths.size === 0} onClick={() => openConfirm({ title: `删除 ${selectedPaths.size} 张图片`, description: `将从磁盘删除所选 ${selectedPaths.size} 张图片并移入系统回收站，同时清理其跳过与喜欢记录。回收站中的文件仍可手动还原。`, confirmLabel: "删除", busyKey: "batch-delete", action: () => api.batchDeletePaths(selectedPathList).then((next) => { clearSelection(); return next; }) })}>删除</button>
          </div>
          {images.length === 0 ? <EmptyState text={items.length === 0 ? "图库还没有图片，先添加壁纸目录或同步在线来源" : "没有匹配的图片"} /> : <div className="online-gallery" ref={gridRef} onMouseDown={handleGridMouseDown}>
            {pageItems.map((item) => <GalleryCard key={pathKey(item.path)} item={item} folderName={item.kind === "local" ? pathName(folderById.get(item.folderId)?.path ?? item.folderId) : undefined} category={tagByPath.get(pathKey(item.path))} isCurrent={currentKey === pathKey(item.path)} isSkipped={skippedKeys.has(pathKey(item.path))} isFavorite={favoriteKeys.has(pathKey(item.path))} selected={selectedPaths.has(pathKey(item.path))} multiSelected={multiSelected} onCardClick={handleCardClick} onToggleSelect={toggleSelected} api={api} busy={busy} run={run} onOpenViewer={onOpenViewer} openConfirm={openConfirm} />)}
            {marquee && <div className="gallery-marquee" aria-hidden="true" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} />}
          </div>}
          {images.length > 0 && <div className="gallery-pagination" role="navigation" aria-label="图库分页">
            <span className="gallery-pagination-summary">第 {currentPage} / {totalPages} 页 · 共 {images.length} 张</span>
            <button className="action-button is-small" type="button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            {pageNumbers.map((pageNumber, index) => <span key={pageNumber} className="gallery-pagination-item">{index > 0 && pageNumber - pageNumbers[index - 1] > 1 && <i>…</i>}<button className={pageNumber === currentPage ? "gallery-page-button is-active" : "gallery-page-button"} type="button" aria-label={`第 ${pageNumber} 页`} aria-current={pageNumber === currentPage ? "page" : undefined} onClick={() => setPage(pageNumber)}>{pageNumber}</button></span>)}
            <button className="action-button is-small" type="button" aria-label="下一页" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
            <label className="inline-select gallery-page-size">每页<select aria-label="每页显示张数" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[24, 48, 96, 192].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
          </div>}
        </section>
      </div>
      <aside className="online-settings">
        <section className="side-panel" aria-label="存储概览">
          <div className="side-panel-heading"><span>存储概览</span></div>
          <div className="storage-compact">
            <div><span>已占用</span><strong>{(state.onlineStorageBytes / 1024 ** 3).toFixed(1)} GB</strong><small>/ {state.onlineStorageLimitGb} GB 上限</small></div>
            <div><span>已下载</span><strong>{state.onlineImages.length}</strong><small>张原图</small></div>
            <div><span>请求分辨率</span><strong>{state.onlineMinimumResolution}p</strong><small>UPX8 参数</small></div>
          </div>
        </section>
        <div className="side-setting"><span>受管在线目录</span><strong title={state.onlineDirectory ?? ""}>{state.onlineDirectory ?? "尚未设置"}</strong><button className="action-button is-small" type="button" onClick={() => void run("select-directory", () => api.selectOnlineDirectory())}><FolderOpen size={14} /> 选择目录</button></div>
        <div className="side-setting"><label>容量上限<select aria-label="在线目录容量上限" value={state.onlineStorageLimitGb} onChange={(event) => updateConfig({ onlineStorageLimitGb: Number(event.target.value) as AppConfig["onlineStorageLimitGb"] })}>{[1, 5, 10, 20].map((size) => <option key={size} value={size}>{size} GB</option>)}</select></label></div>
        <div className="side-setting"><label>请求分辨率<select aria-label="在线图片请求分辨率" value={state.onlineMinimumResolution} onChange={(event) => updateConfig({ onlineMinimumResolution: Number(event.target.value) as AppConfig["onlineMinimumResolution"] })}>{[1920, 2560, 3840].map((size) => <option key={size} value={size}>{size}p</option>)}</select></label></div>
        <p>在线来源默认关闭，只有启用或手动抓取后才会联网。</p>
        <div className="side-setting">
          <span>已排除下载 ({state.excludedImageUrls.length})</span>
          <strong>{state.excludedImageUrls.length === 0 ? "暂无排除记录" : "删除过的图不会被再次同步"}</strong>
          {state.excludedImageUrls.length > 0 && <details className="excluded-list">
            <summary>查看已排除的 {state.excludedImageUrls.length} 个地址</summary>
            <ul>
              {state.excludedImageUrls.map((url) => <li key={url}><code title={url}>{url}</code><button className="icon-button" type="button" aria-label={`移出排除 ${url}`} title="移出排除，下次同步会重新下载" disabled={busy !== null} onClick={() => void run(`excluded-remove-${url}`, () => api.removeExcludedImageUrl(url))}><X size={12} /></button></li>)}
            </ul>
          </details>}
          <button className="action-button is-small" type="button" disabled={busy !== null || state.excludedImageUrls.length === 0} onClick={() => openConfirm({ title: "清空排除记录", description: `将忘记 ${state.excludedImageUrls.length} 个已删除图片的源地址，之后同步来源时会重新下载它们。`, confirmLabel: "清空", busyKey: "clear-excluded", action: () => api.clearExcludedImageUrls() })}>清空排除记录</button>
        </div>
        <details className="side-collapse">
          <summary>抓取来源 ({state.onlineSources.length})</summary>
          <div className="source-list">
            {state.onlineSources.map((source) => <SourceRow key={source.id} source={source} api={api} busy={busy} run={run} />)}
          </div>
        </details>
        <details className="side-collapse" open>
          <summary>同步记录 ({state.onlineSyncLogs.length})</summary>
          {state.onlineSyncLogs.length === 0 ? <div className="sync-log-empty">暂无同步记录</div> : <>
            <div className="sync-log-list">
              {state.onlineSyncLogs.map((log) => <SyncLogListItem key={log.id} log={log} selected={log.id === selectedLog?.id} onSelect={() => setSelectedLogId(log.id)} />)}
            </div>
            {selectedLog && <SyncLogDetail log={selectedLog} />}
          </>}
        </details>
      </aside>
    </div>
  </div>;
}

function SyncLogListItem({ log, selected, onSelect }: { log: OnlineSyncLog; selected: boolean; onSelect: () => void }) {
  const tone = log.status === "success" ? "green" : log.status === "partial" ? "amber" : log.status === "failed" ? "red" : "cyan";
  const label = log.status === "success" ? "成功" : log.status === "partial" ? "部分完成" : log.status === "failed" ? "失败" : "进行中";
  return <button className={selected ? "sync-log-list-item is-selected" : "sync-log-list-item"} type="button" aria-label={`查看${log.categoryLabel}同步详情`} aria-pressed={selected} onClick={onSelect}>
    <span className={`sync-log-indicator is-${tone}`} aria-hidden="true" />
    <span className="sync-log-list-copy"><strong>{log.categoryLabel}</strong><small>{formatLogTime(log.startedAt)} · {log.discovered} 返回 · {log.downloaded} 下载</small></span>
    <span className={`sync-log-status is-${tone}`}>{label}</span>
    <ChevronRight size={14} aria-hidden="true" />
  </button>;
}

function SyncLogDetail({ log }: { log: OnlineSyncLog }) {
  const tone = log.status === "success" ? "green" : log.status === "partial" ? "amber" : log.status === "failed" ? "red" : "cyan";
  const label = log.status === "success" ? "成功" : log.status === "partial" ? "部分完成" : log.status === "failed" ? "失败" : "进行中";
  return <section className="sync-log-detail" aria-label={`${log.categoryLabel} 同步详情`}>
    <div className="sync-log-header"><div><strong>{log.categoryLabel}同步</strong><small>{formatLogTime(log.startedAt)}{log.durationMs !== null ? ` · ${(log.durationMs / 1000).toFixed(1)} 秒` : ""}</small></div><Tag tone={tone}>{label}</Tag></div>
    <div className="sync-log-request"><span>GET</span><code>{log.requestUrl}</code></div>
    <div className="sync-log-metrics"><span>format={log.format}</span><span>category={log.categoryKey}</span><span>resolution={log.resolution}</span><span>count={log.count}</span><span>HTTP {log.responseStatus ?? "—"}</span><span>{log.discovered} 返回 · {log.downloaded} 下载{log.skipped ? ` · ${log.skipped} 跳过` : ""}</span></div>
    {log.downloadFailures.length > 0 && <details className="sync-log-response" open><summary>下载失败 ({log.downloadFailures.length})</summary><ol>{log.downloadFailures.map((failure, index) => <li key={`${log.id}-failure-${index}`}><strong>{failure.reason}</strong><code>{failure.imageUrl}</code>{failure.resolvedUrl && failure.resolvedUrl !== failure.imageUrl && <code>{failure.resolvedUrl}</code>}<small>HTTP {failure.responseStatus ?? "—"} · Content-Type {failure.contentType ?? "—"}</small></li>)}</ol></details>}
    {log.errors.filter((error) => !log.downloadFailures.some((failure) => failure.reason === error)).length > 0 && <ul className="sync-log-errors">{log.errors.filter((error) => !log.downloadFailures.some((failure) => failure.reason === error)).map((error, index) => <li key={`${log.id}-${index}`}>{error}</li>)}</ul>}
    {log.responseImageUrls.length > 0 && <details className="sync-log-response"><summary>返回 URL ({log.responseImageUrls.length})</summary><ol>{log.responseImageUrls.map((url) => <li key={url}><code>{url}</code></li>)}</ol></details>}
  </section>;
}

function SourceRow({ source, api, busy, run }: { source: OnlineSource; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const nextSource = (patch: Partial<OnlineSource>) => ({ ...source, ...patch });
  const statuses = new Map((source.categoryStatuses ?? []).map((status) => [status.key, status]));
  return <article className="source-row">
    <div className="source-row-header">
      <Toggle label={`启用 ${source.name}`} checked={source.enabled} onChange={(enabled) => void run(`source-${source.id}`, () => api.updateOnlineSource(nextSource({ enabled })))} />
      <div className="source-copy"><strong>{source.name}</strong><span>{source.url}</span><small>{source.lastDiscovered} 发现 · {source.lastDownloaded} 下载 {source.nextRunAt ? `· 下次 ${formatTime(source.nextRunAt)}` : ""}</small>{source.lastError && <small className="source-error">{source.lastError}</small>}</div>
      <div className="source-actions"><label className="inline-select">间隔<select aria-label={`抓取间隔 ${source.name}`} value={source.intervalHours} onChange={(event) => void run(`source-${source.id}`, () => api.updateOnlineSource(nextSource({ intervalHours: Number(event.target.value) as OnlineSource["intervalHours"] })))}>{onlineIntervals.map((hours) => <option key={hours} value={hours}>{hours} 小时</option>)}</select></label><button className="action-button is-small" type="button" disabled={busy !== null} onClick={() => void run(`run-${source.id}`, () => api.runOnlineSource(source.id))}><CloudDownload size={14} /> 同步全部</button></div>
    </div>
    <div className="source-category-grid" aria-label="UPX8 分类同步">
      {upx8Categories.map((category) => {
        const status = statuses.get(category.key);
        return <div className="source-category" key={category.key}><div><strong>{category.label}</strong><small>{status ? `${status.discovered} 发现 · ${status.downloaded} 下载` : "尚未同步"}</small>{status?.lastError && <em>{status.lastError}</em>}</div><button className="action-button is-small" type="button" aria-label={`同步分类 ${category.label}`} disabled={busy !== null} onClick={() => void run(`run-upx8-${category.key}`, () => api.runUpx8Category(category.key))}><RefreshCw size={13} /> 同步</button></div>;
      })}
    </div>
  </article>;
}

function GalleryCard({ item, folderName, category, isCurrent, isSkipped, isFavorite, selected, multiSelected, onCardClick, onToggleSelect, api, busy, run, onOpenViewer, openConfirm }: { item: GalleryItem; folderName?: string; category?: string; isCurrent: boolean; isSkipped: boolean; isFavorite: boolean; selected: boolean; multiSelected: boolean; onCardClick: (path: string, event: ReactMouseEvent<HTMLElement>) => void; onToggleSelect: (path: string) => void; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; onOpenViewer: (filePath: string) => void; openConfirm: (options: ConfirmOptions) => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const isOnline = item.kind === "online";
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "480px 0px" });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    void api.getImageAsset(item.path, "grid")
      .then((asset) => { if (!cancelled && asset) setThumbnail(asset.src); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, item.path, isVisible]);
  const setAsWallpaper = isOnline ? () => api.setOnlineImageAsWallpaper(item.online.id) : () => api.selectWallpaper(item.path);
  const reveal = isOnline ? () => api.revealOnlineImage(item.online.id) : () => api.revealWallpaper(item.path);
  const deleteKey = isOnline ? `delete-image-${item.online.id}` : `delete-local-${item.path}`;
  const requestDelete = () => openConfirm(isOnline
    ? { title: "删除在线图片", description: `将从磁盘删除 ${pathName(item.path)} 并移入系统回收站，同时移除其喜欢记录。回收站中的文件仍可手动还原。`, confirmLabel: "删除", busyKey: deleteKey, action: () => api.deleteOnlineImage(item.online.id) }
    : { title: "删除图片文件", description: `将从磁盘删除 ${pathName(item.path)}，移入系统回收站，并同步移除其跳过与喜欢记录。`, confirmLabel: "删除", busyKey: deleteKey, action: () => api.batchDeletePaths([item.path]) });
  const categoryLabel = category ? upx8Categories.find((entry) => entry.key === category)?.label ?? category : null;
  return <article ref={cardRef} data-gallery-path={item.path} className={selected ? "online-image-card is-selected" : "online-image-card"} onClick={(event) => onCardClick(item.path, event)}>
    <label className="gallery-card-select" onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={selected} aria-label={`选择 ${pathName(item.path)}`} onChange={() => onToggleSelect(item.path)} />
    </label>
    {thumbnail ? <img src={thumbnail} alt={pathName(item.path)} loading="lazy" decoding="async" draggable={false} /> : <div className="online-image-placeholder" role="img" aria-label={`${pathName(item.path)} 缩略图加载中`} />}
    <div>
      <strong title={pathName(item.path)}>{pathName(item.path)}</strong>
      <span>{isOnline ? `${item.online.width}×${item.online.height} · ${formatDate(item.online.downloadedAt)}` : `${folderName ?? item.folderId}${item.kind === "local" && !item.folderEnabled ? " · 已停用" : ""}`}</span>
      <div className="gallery-card-tags">
        {isOnline ? <Tag tone="cyan">在线</Tag> : <Tag tone="blue">本地</Tag>}
        {item.kind === "local" && !item.folderEnabled && <Tag tone="amber">不参与轮转</Tag>}
        {categoryLabel && <Tag tone="green">{categoryLabel}</Tag>}
        {isCurrent && <Tag tone="green">当前壁纸</Tag>}
        {isSkipped && <Tag tone="amber">已跳过</Tag>}
        {isFavorite && <Tag tone="red">已喜欢</Tag>}
      </div>
      <div className="image-actions" onClick={(event) => event.stopPropagation()}>
        <button className="action-button is-small is-primary" type="button" title={multiSelected ? "多选状态下不能设为壁纸" : undefined} disabled={busy !== null || multiSelected} onClick={() => void run(`set-${item.path}`, setAsWallpaper)}>设为壁纸</button>
        <button className="icon-button" type="button" aria-label={`查看原图 ${pathName(item.path)}`} title="查看原图" onClick={() => onOpenViewer(item.path)}><Maximize2 size={14} /></button>
        <button className={isFavorite ? "icon-button favorite-toggle is-favorite" : "icon-button favorite-toggle"} type="button" aria-label={`${isFavorite ? "取消喜欢" : "喜欢"} ${pathName(item.path)}`} title={isFavorite ? "取消喜欢" : "喜欢"} disabled={busy !== null} onClick={() => void run(`favorite-${item.path}`, () => api.toggleFavorite(item.path))}><Heart size={14} fill={isFavorite ? "currentColor" : "none"} /></button>
        <button className="icon-button" type="button" aria-label={`打开 ${pathName(item.path)}`} title="打开所在目录" disabled={busy !== null} onClick={() => void run(`reveal-${item.path}`, reveal)}><FolderOpen size={14} /></button>
        <button className="icon-button is-danger" type="button" aria-label={`删除 ${pathName(item.path)}`} title="删除" disabled={busy !== null} onClick={requestDelete}>{busy === deleteKey ? "删除中..." : <Trash2 size={14} />}</button>
      </div>
    </div>
  </article>;
}

function SettingsView({ state, api, busy, run, updateConfig }: { state: AppState; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; updateConfig: (patch: Partial<AppConfig>) => void }) {
  const [nextShortcut, setNextShortcut] = useState(state.globalNextShortcut ?? "");
  const [skipShortcut, setSkipShortcut] = useState(state.globalSkipShortcut ?? "");
  useEffect(() => setNextShortcut(state.globalNextShortcut ?? ""), [state.globalNextShortcut]);
  useEffect(() => setSkipShortcut(state.globalSkipShortcut ?? ""), [state.globalSkipShortcut]);
  const saveNextShortcut = () => { const value = nextShortcut.trim() || null; if (value !== state.globalNextShortcut) updateConfig({ globalNextShortcut: value }); };
  const saveSkipShortcut = () => { const value = skipShortcut.trim() || null; if (value !== state.globalSkipShortcut) updateConfig({ globalSkipShortcut: value }); };
  /** 间隔以本地草稿形式编辑，失焦或回车才提交，避免每敲一个数字就落盘。 */
  const [intervalDraft, setIntervalDraft] = useState(String(state.intervalMinutes));
  useEffect(() => setIntervalDraft(String(state.intervalMinutes)), [state.intervalMinutes]);
  const parsedInterval = Number.parseInt(intervalDraft.trim(), 10);
  const intervalPreview = clampIntervalMinutes(Number.isFinite(parsedInterval) ? parsedInterval : state.intervalMinutes);
  const intervalClamped = Number.isFinite(parsedInterval) && intervalPreview !== parsedInterval;
  const commitInterval = () => {
    const next = clampIntervalMinutes(Number.isFinite(parsedInterval) ? parsedInterval : state.intervalMinutes);
    setIntervalDraft(String(next));
    if (next !== state.intervalMinutes) updateConfig({ intervalMinutes: next });
  };
  return <div className="prototype-page settings-page">
    <SettingsPanel title="自动切换"><SettingsRow label="切换间隔" description="下一张壁纸的等待时长，手动输入后回车或移出输入框生效"><div className="interval-editor"><input aria-label="切换间隔（分钟）" type="number" inputMode="numeric" min={INTERVAL_MINUTES.min} max={INTERVAL_MINUTES.max} step={1} value={intervalDraft} onChange={(event) => setIntervalDraft(event.target.value)} onBlur={commitInterval} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span className="interval-unit">分钟</span><small className={intervalClamped ? "interval-hint is-clamped" : "interval-hint"}>{intervalClamped ? `将限制为 ${formatInterval(intervalPreview)}` : formatInterval(intervalPreview)}</small></div></SettingsRow><SettingsRow label="切换顺序" description={state.rotationOrder === "random" ? "一轮内不重复" : "按绝对路径稳定循环"}><div className="segmented-control"><button type="button" className={state.rotationOrder === "random" ? "is-selected" : undefined} onClick={() => updateConfig({ rotationOrder: "random" })}>随机</button><button type="button" className={state.rotationOrder === "sequential" ? "is-selected" : undefined} onClick={() => updateConfig({ rotationOrder: "sequential" as RotationOrder })}>顺序</button></div></SettingsRow><SettingsRow label="显示方式" description="壁纸填充屏幕的方式"><select aria-label="设置显示方式" value={state.displayMode} onChange={(event) => updateConfig({ displayMode: event.target.value as WallpaperMode })}>{displayModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></SettingsRow></SettingsPanel>
    <SettingsPanel title="系统集成"><SettingsRow label="开机自动启动" description="仅在系统托盘运行，不显示主窗口"><Toggle label="开机自动启动" checked={state.autoStart} onChange={(autoStart) => updateConfig({ autoStart })} /></SettingsRow><SettingsRow label="跟随系统主题" description="深色 / 浅色主题切换时同步调整"><Toggle label="跟随系统主题" checked={state.followSystemTheme} onChange={(followSystemTheme) => updateConfig({ followSystemTheme })} /></SettingsRow><SettingsRow label="关闭窗口时隐藏到托盘" description="关闭后继续在后台运行"><Toggle label="关闭窗口时隐藏到托盘" checked={state.hideToTrayOnClose} onChange={(hideToTrayOnClose) => updateConfig({ hideToTrayOnClose })} /></SettingsRow></SettingsPanel>
    <TaggingSettings state={state} api={api} busy={busy} run={run} />
    <SettingsPanel title="全局快捷键"><SettingsRow label="下一张壁纸" description="保存时立即尝试注册"><div className="shortcut-editor"><input aria-label="全局下一张快捷键" placeholder="例如 Ctrl+Alt+N" value={nextShortcut} onChange={(event) => setNextShortcut(event.target.value)} onBlur={saveNextShortcut} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><ShortcutStatusTag status={state.shortcutStatus} /></div></SettingsRow><SettingsRow label="跳过此图" description="保存时立即尝试注册"><div className="shortcut-editor"><input aria-label="全局跳过快捷键" placeholder="例如 Ctrl+Alt+S" value={skipShortcut} onChange={(event) => setSkipShortcut(event.target.value)} onBlur={saveSkipShortcut} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><ShortcutStatusTag status={state.skipShortcutStatus} /></div></SettingsRow></SettingsPanel>
    <SettingsPanel title="更新"><SettingsRow label="当前版本" description="手动检查并由用户确认下载"><span className="settings-version">v0.1.5</span></SettingsRow><SettingsRow label="检查更新" description="当前发布未配置签名更新清单"><button className="action-button is-small" type="button" disabled title="需要签名私钥和更新地址">检查更新</button></SettingsRow></SettingsPanel>
  </div>;
}

function ShortcutStatusTag({ status }: { status: ShortcutStatus }) { if (status.state === "active") return <Tag tone="green">已注册</Tag>; if (status.state === "error") return <span className="shortcut-status"><Tag tone="red">注册失败</Tag><small role="alert">{status.message}</small></span>; return <Tag tone="amber">未启用</Tag>; }

function TaggingSettings({ state, api, busy, run }: { state: AppState; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const [status, setStatus] = useState<TaggingStatus | null>(null);
  useEffect(() => {
    let active = true;
    const poll = () => {
      void api.getTaggingStatus().then((next) => { if (active) setStatus(next); }).catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [api]);
  const copy = taggingStatusCopy(status);
  return <SettingsPanel title="智能分类">
    <SettingsRow label="启用智能分类" description="本地推理为图片自动标注十分类，全程无遥测；首次启用需下载约 85MB 模型。">
      <Toggle label="启用智能分类" checked={state.taggingEnabled} disabled={busy !== null} onChange={(enabled) => void run("tagging-toggle", () => api.setTaggingEnabled(enabled))} />
    </SettingsRow>
    <SettingsRow label="模型状态" description={copy.description}>
      <Tag tone={copy.tone}>{copy.label}</Tag>
    </SettingsRow>
  </SettingsPanel>;
}

function taggingStatusCopy(status: TaggingStatus | null): { description: string; label: string; tone: "blue" | "green" | "amber" | "red" } {
  if (!status) return { description: "正在读取模型状态…", label: "检查中", tone: "blue" };
  if (status.downloading) {
    const { received, total } = status.downloading;
    const receivedMb = Math.round(received / 1024 ** 2);
    return {
      description: total
        ? `正在下载模型 ${receivedMb} / ${Math.round(total / 1024 ** 2)} MB（${Math.round((received / total) * 100)}%）`
        : `正在下载模型 ${receivedMb} MB`,
      label: "下载中",
      tone: "amber",
    };
  }
  if (!status.modelReady) return { description: "模型尚未下载，启用后会自动从镜像源下载。", label: "未下载", tone: "amber" };
  return { description: `本地推理就绪，待打标 ${status.pending} 张。`, label: "就绪", tone: "green" };
}

/** 分类筛选谓词：all=全部；untagged=无标签；其余值按类别 key 精确匹配。 */
function matchesCategoryFilter(path: string, tagByPath: Map<string, string>, filter: string) {
  if (filter === "all") return true;
  const category = tagByPath.get(path.toLowerCase());
  return filter === "untagged" ? !category : category === filter;
}

function LabView() {
  return <div className="prototype-page lab-page">
    <section className="lab-intro"><Sparkles size={20} /><div><h2>后置实验性功能</h2><p>以下能力保留原型结构，等待静态壁纸与在线发现通过发布验收后再独立启用。</p></div></section>
    <section className="lab-section"><SectionHeading title="AI 深度图模型" /><div className="model-row"><div><strong>Depth Anything V2 Small</strong><span>模型按需下载、校验并缓存</span></div><Tag tone="amber">尚未启用</Tag><button className="action-button is-small" type="button" disabled>下载</button></div></section>
    <section className="lab-section"><SectionHeading title="2D 转 3D 视差动态桌面" /><div className="lab-parallax"><div className="lab-preview"><img src={previewImage} alt="视差功能预览" /><span>需下载 AI 模型</span></div><div className="lab-controls"><label>深度强度 <output>—</output><input aria-label="深度强度" type="range" disabled /></label><label>运动速度 <output>—</output><input aria-label="运动速度" type="range" disabled /></label><div className="segmented-control"><button type="button" disabled>鼠标跟踪</button><button type="button" disabled>陀螺仪</button><button type="button" disabled>自动摇摆</button></div></div></div></section>
    <section className="lab-section"><SectionHeading title="Windows 11 DWM 美化" /><div className="lab-dwm"><div className="dwm-warning"><CircleAlert size={16} /><div><strong>恢复 Windows 默认外观</strong><span>所有 DWM 修改都会支持完整恢复。</span></div><button className="action-button is-danger" type="button" disabled><RotateCcw size={14} /> 立即恢复默认</button></div><div className="dwm-grid"><SettingsPanel title="任务栏"><SettingsRow label="任务栏透明" description="仅桌面状态下"><Toggle label="任务栏透明" checked={false} disabled onChange={() => {}} /></SettingsRow><div className="segmented-control"><button type="button" disabled>关闭</button><button type="button" disabled>Acrylic</button><button type="button" disabled>Mica</button></div></SettingsPanel><SettingsPanel title="主色联动"><SettingsRow label="壁纸主色联动" description="切换壁纸时同步 Windows 强调色"><Toggle label="壁纸主色联动" checked={false} disabled onChange={() => {}} /></SettingsRow><button className="action-button is-primary lab-apply" type="button" disabled><Zap size={14} /> 应用 DWM 设置</button></SettingsPanel></div></div></section>
  </div>;
}

function SettingsPanel({ title, children }: { title: string; children: ReactNode }) { return <section className="settings-panel"><h2>{title}</h2><div>{children}</div></section>; }
function SettingsRow({ label, description, children }: { label: string; description: string; children: ReactNode }) { return <div className="settings-row"><div><strong>{label}</strong><span>{description}</span></div>{children}</div>; }
function SectionHeading({ title, action }: { title: ReactNode; action?: ReactNode }) { return <div className="section-heading"><h2>{title}</h2>{action}</div>; }
function Metric({ label, value, sub }: { label: string; value: string; sub: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>; }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><Archive size={20} /><span>{text}</span></div>; }
function Tag({ children, tone = "blue", title }: { children: ReactNode; tone?: "blue" | "cyan" | "green" | "amber" | "red"; title?: string }) { return <span className={`tag tag-${tone}`} title={title}>{children}</span>; }
function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) { return <button className={checked ? "toggle is-on" : "toggle"} type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>; }
function LoadingScreen() { return <div className="loading-screen"><LoaderCircle className="spin" size={22} /> 正在加载 ZX Wallpaper</div>; }

function OriginalImageViewer({ api, filePath, onClose, fileDelete }: { api: DesktopRuntime; filePath: string; onClose: () => void; fileDelete?: { fileName: string; onConfirm: () => void } }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getImageAsset(filePath, "original").then((asset) => {
      if (active) setSrc(asset?.src ?? null);
    }).catch(() => {
      if (active) setSrc(null);
    });
    return () => { active = false; };
  }, [api, filePath]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="original-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="original-viewer" role="dialog" aria-modal="true" aria-label={`原图查看 ${pathName(filePath)}`}>
      <header><strong>{pathName(filePath)}</strong><div className="viewer-header-actions">{fileDelete && <button className="action-button is-small is-danger" type="button" onClick={fileDelete.onConfirm}>删除文件</button>}<button className="icon-button" type="button" aria-label="关闭原图查看" title="关闭" onClick={onClose}><X size={17} /></button></div></header>
      <div className="original-viewer-stage">{src ? <img src={src} alt={pathName(filePath)} /> : <LoaderCircle className="spin" size={22} aria-label="原图加载中" />}</div>
    </section>
  </div>;
}

function ConfirmDialog({ options, busy, onConfirm, onCancel }: { options: ConfirmOptions; busy: string | null; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onCancel]);

  return <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={options.title}>
      <h2>{options.title}</h2>
      <p>{options.description}</p>
      <div className="confirm-dialog-actions">
        <button className="action-button" type="button" autoFocus onClick={onCancel}>取消</button>
        <button className="action-button is-danger" type="button" disabled={busy !== null} onClick={onConfirm}>{busy ? "处理中..." : options.confirmLabel}</button>
      </div>
    </section>
  </div>;
}

function createDefaultRuntime(): DesktopRuntime {
  return "__TAURI_INTERNALS__" in window ? tauriRuntime : createBrowserPreviewApi();
}

function createBrowserPreviewApi(): DesktopRuntime {
  const nextPath = "D:\\Pictures\\Wallpapers\\Archive\\blue-hour.jpg";
  const previewItems = [
    "D:\\Pictures\\Wallpapers\\Scenic\\mist-over-the-ridge.jpg",
    nextPath,
    "D:\\Pictures\\Wallpapers\\Scenic\\alpine-lake.jpg",
    "D:\\Pictures\\Wallpapers\\Scenic\\foggy-forest.jpg",
    "D:\\Pictures\\Wallpapers\\Scenic\\snow-peak.jpg",
  ].map((path) => ({ path, previewUrl: previewImage }));
  let state: AppState = {
    folders: [{ id: "demo-scenic", path: "D:\\Pictures\\Wallpapers\\Scenic", enabled: true }, { id: "online-library", path: "D:\\Pictures\\ZX Wallpaper\\Online", enabled: true }],
    intervalMinutes: 30, displayMode: "fill", rotationOrder: "random", autoStart: true, paused: false, followSystemTheme: true, hideToTrayOnClose: true,
    currentPath: "D:\\Pictures\\Wallpapers\\Scenic\\mist-over-the-ridge.jpg", remainingPaths: previewItems.slice(1).map((item) => item.path), skippedPaths: [], favoritePaths: [], wallpaperHistory: [], globalNextShortcut: null, globalSkipShortcut: null, lastSwitchAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    onlineSources: [{ id: "upx8-4k", name: "UPX8 综合壁纸 4K", url: "https://wp.upx8.com/api.php", enabled: true, intervalHours: 24, lastRunAt: null, nextRunAt: null, lastDiscovered: 0, lastDownloaded: 0, lastError: null, categoryStatuses: [] }],
    onlineImages: [], excludedImageUrls: [], onlineSyncLogs: [], onlineDirectory: "D:\\Pictures\\ZX Wallpaper\\Online", onlineStorageLimitGb: 5, onlineMinimumResolution: 1920,
    libraryImages: previewItems.map((item, index) => ({ path: item.path, folderId: "demo-scenic", folderEnabled: true, modifiedAt: new Date(Date.now() - index * 3_600_000).toISOString() })),
    widgetLayout: { docked: "right", x: null, y: null },
    imageTags: [], taggingEnabled: false,
    availableCount: 128, previewUrl: previewImage, previewItems,
    folderStatuses: { "demo-scenic": { kind: "available", availableCount: 110, invalidCount: 0, scannedAt: new Date().toISOString() } },
    onlineStorageBytes: 1.2 * 1024 ** 3, globalShortcutRegistered: false, shortcutStatus: { state: "disabled" }, skipShortcutStatus: { state: "disabled" },
  };
  const listeners = new Set<(next: AppState) => void>();
  const update = (patch: Partial<AppState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); return Promise.resolve(state); };
  const selectPreview = (filePath: string) => {
    const selected = state.previewItems.find((item) => samePath(item.path, filePath));
    if (!selected) return Promise.resolve(state);
    return update({
      currentPath: selected.path,
      remainingPaths: state.previewItems.filter((item) => !samePath(item.path, selected.path)).map((item) => item.path),
      lastSwitchAt: new Date().toISOString(),
      previewItems: [selected, ...state.previewItems.filter((item) => !samePath(item.path, selected.path))],
    });
  };
  return {
    getState: () => Promise.resolve(state), updateConfig: update,
    addFolder: () => update({ folders: [...state.folders, { id: `folder-${Date.now()}`, path: "D:\\Pictures\\Wallpapers\\New folder", enabled: true }] }),
    removeFolder: (id) => update({ folders: state.folders.filter((folder) => folder.id !== id) }),
    updateFolder: (folder) => update({ folders: state.folders.map((item) => item.id === folder.id ? folder : item) }),
    openFolder: () => Promise.resolve(state), rescanFolders: () => Promise.resolve(state), nextWallpaper: () => selectPreview(nextPath), selectWallpaper: selectPreview, getImageAsset: (_path, kind) => Promise.resolve({ src: previewImage, width: kind === "strip" ? 384 : kind === "grid" ? 768 : 1600, height: kind === "strip" ? 216 : kind === "grid" ? 432 : 900, status: "ready" }), prewarmImageAssets: () => Promise.resolve(),
    skipCurrentWallpaper: () => update({ skippedPaths: state.currentPath ? [...state.skippedPaths, state.currentPath] : state.skippedPaths, currentPath: nextPath }),
    toggleFavorite: (path) => update({ favoritePaths: state.favoritePaths.some((item) => samePath(item, path)) ? state.favoritePaths.filter((item) => !samePath(item, path)) : [...state.favoritePaths, path] }),
    restoreSkippedPath: (path) => update({ skippedPaths: state.skippedPaths.filter((item) => item !== path) }), restoreAllSkipped: () => update({ skippedPaths: [] }), deleteSkippedPath: (path) => update({ skippedPaths: state.skippedPaths.filter((item) => item !== path) }), deleteAllSkipped: () => update({ skippedPaths: [] }), togglePaused: () => update({ paused: !state.paused }),
    batchSkipPaths: (paths) => update({ skippedPaths: [...new Set([...state.skippedPaths, ...paths])] }),
    batchRestoreSkipped: (paths) => update({ skippedPaths: state.skippedPaths.filter((item) => !paths.some((path) => samePath(item, path))) }),
    batchFavorite: (paths, favorite) => update({ favoritePaths: favorite ? [...new Set([...state.favoritePaths, ...paths])] : state.favoritePaths.filter((item) => !paths.some((path) => samePath(item, path))) }),
    batchDeletePaths: (paths) => update({ libraryImages: state.libraryImages.filter((item) => !paths.some((path) => samePath(item.path, path))), favoritePaths: state.favoritePaths.filter((item) => !paths.some((path) => samePath(item, path))), skippedPaths: state.skippedPaths.filter((item) => !paths.some((path) => samePath(item, path))) }),
    updateOnlineSource: (source) => update({ onlineSources: state.onlineSources.map((item) => item.id === source.id ? source : item) }), runOnlineSource: () => Promise.resolve(state), runUpx8Category: () => Promise.resolve(state),
    setOnlineImageAsWallpaper: (id) => { const image = state.onlineImages.find((item) => item.id === id); return image ? update({ currentPath: image.localPath, paused: true }) : Promise.resolve(state); }, deleteOnlineImage: (id) => { const image = state.onlineImages.find((item) => item.id === id); return update({ onlineImages: state.onlineImages.filter((item) => item.id !== id), excludedImageUrls: image && !state.excludedImageUrls.includes(image.imageUrl) ? [...state.excludedImageUrls, image.imageUrl] : state.excludedImageUrls, favoritePaths: state.favoritePaths.filter((path) => !samePath(path, image?.localPath ?? "")) }); }, clearExcludedImageUrls: () => update({ excludedImageUrls: [] }), removeExcludedImageUrl: (url) => update({ excludedImageUrls: state.excludedImageUrls.filter((known) => known !== url) }), selectOnlineDirectory: () => update({ onlineDirectory: "D:\\Pictures\\ZX Wallpaper Library" }), revealOnlineImage: () => Promise.resolve(state), revealWallpaper: () => Promise.resolve(),
    getWidgetLayout: () => Promise.resolve(state.widgetLayout), setWidgetLayout: (layout) => update({ widgetLayout: layout }),
    setTaggingEnabled: (enabled) => update({ taggingEnabled: enabled }),
    getTaggingStatus: () => Promise.resolve({ enabled: state.taggingEnabled, modelReady: false, downloading: null, pending: 0 }),
    rescanTags: () => Promise.resolve(state),
    onStateChanged: (listener) => { listeners.add(listener); return Promise.resolve(() => listeners.delete(listener)); },
  };
}

function parentPath(path: string) { const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")); return slash < 0 ? path : path.slice(0, slash); }
function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "folders" in value && "onlineImages" in value && "onlineSyncLogs" in value;
}
function getAutoSwitchProgress(lastSwitchAt: string | null, intervalMinutes: number, now: number) {
  if (!lastSwitchAt || intervalMinutes <= 0) return 0;
  const switchedAt = Date.parse(lastSwitchAt);
  if (!Number.isFinite(switchedAt)) return 0;
  return Math.min(1, Math.max(0, (now - switchedAt) / (intervalMinutes * 60_000)));
}
function operationMessage(key: string, phase: "pending" | "success") {
  const pending = phase === "pending";
  if (key.startsWith("set-")) return pending ? "正在设置壁纸并同步所有显示器..." : "已设为壁纸，所有显示器已同步，自动切换已暂停。";
  if (key.startsWith("delete-image-")) return pending ? "正在删除在线图片..." : "在线图片已移入回收站。";
  if (key.startsWith("delete-local-")) return pending ? "正在删除图片文件..." : "图片文件已移入回收站。";
  if (key === "delete-all-skipped") return pending ? "正在删除已跳过图片..." : "已跳过图片已全部移入回收站。";
  if (key === "delete-skipped-file") return pending ? "正在删除图片文件..." : "图片文件已移入回收站。";
  if (key === "batch-delete") return pending ? "正在批量删除图片..." : "所选图片已移入回收站。";
  if (key === "batch-skip") return pending ? "正在批量跳过图片..." : "所选图片已跳过，不再参与轮转。";
  if (key === "batch-restore") return pending ? "正在恢复图片..." : "所选图片已恢复参与轮转。";
  if (key === "batch-favorite") return pending ? "正在标记喜欢..." : "所选图片已加入喜欢。";
  if (key === "batch-unfavorite") return pending ? "正在取消喜欢..." : "所选图片已取消喜欢。";
  if (key === "clear-excluded") return pending ? "正在清空排除记录..." : "排除记录已清空，已删除的图可再次同步。";
  if (key.startsWith("excluded-remove-")) return pending ? "正在移出排除记录..." : "已移出排除记录，下次同步会重新下载这张图。";
  if (key.startsWith("run-")) return pending ? "正在抓取在线来源，下载原图可能需要一些时间..." : "在线来源抓取已完成，请查看发现和下载数量。";
  if (key === "refresh-gallery" || key === "refresh-online") return pending ? "正在刷新图库..." : "图库已刷新。";
  if (key.startsWith("tagging-")) return pending ? "正在更新智能分类设置..." : "智能分类设置已更新。";
  return pending ? "正在处理..." : "操作已完成。";
}
function operationError(cause: unknown) {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return "操作未完成，请检查相关目录或来源后重试。";
}
function clampIntervalMinutes(minutes: number) { return Math.min(INTERVAL_MINUTES.max, Math.max(INTERVAL_MINUTES.min, Math.round(minutes))); }
/** 手动输入没有预设选项，分钟数统一写成「N 天 N 小时 N 分钟」，避免出现「1440 分钟」。 */
function formatInterval(minutes: number) {
  const total = clampIntervalMinutes(minutes);
  const parts = [Math.floor(total / 1440) ? `${Math.floor(total / 1440)} 天` : "", Math.floor((total % 1440) / 60) ? `${Math.floor((total % 1440) / 60)} 小时` : "", total % 60 ? `${total % 60} 分钟` : ""].filter(Boolean);
  return parts.join(" ") || "1 分钟";
}
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function formatLogTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
