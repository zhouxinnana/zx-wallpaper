import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  FolderOpen,
  Globe2,
  Heart,
  Image as ImageIcon,
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
  WallpaperFolder,
  WallpaperMode,
} from "./runtime/types";
import { tauriRuntime } from "./runtime/tauri-runtime";

const previewImage =
  "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1600&q=85";

const intervalOptions = [
  { value: 5, label: "5 分钟" },
  { value: 10, label: "10 分钟" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
  { value: 180, label: "3 小时" },
  { value: 1440, label: "每天" },
];

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
const ONLINE_PAGE_SIZE = 24;
export const SUCCESS_STATUS_DURATION_MS = 3_000;
type View = "workbench" | "online" | "favorites" | "lab" | "settings";

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
  { key: "online", label: "在线发现", subtitle: "来源与下载管理", icon: Globe2 },
  { key: "favorites", label: "我的喜欢", subtitle: "保留的壁纸", icon: Heart },
  { key: "lab", label: "实验室", subtitle: "后置实验性功能", icon: WandSparkles },
  { key: "settings", label: "设置", subtitle: "偏好与系统集成", icon: Settings },
];

export default function App({ runtime }: { runtime?: DesktopRuntime }) {
  const [api] = useState(() => runtime ?? createDefaultRuntime());
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>("workbench");
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
    workbench: <WorkbenchView api={api} state={state} busy={busy} run={run} updateConfig={updateConfig} onOpenViewer={openViewer} openConfirm={openConfirm} />,
    online: <OnlineView api={api} state={state} busy={busy} run={run} updateConfig={updateConfig} onOpenViewer={openViewer} openConfirm={openConfirm} />,
    favorites: <FavoritesView api={api} state={state} busy={busy} run={run} onOpenViewer={openViewer} />,
    lab: <LabView />,
    settings: <SettingsView state={state} updateConfig={updateConfig} />,
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
}: {
  api: DesktopRuntime;
  state: AppState;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => void;
  onOpenViewer: (filePath: string) => void;
  openConfirm: (options: ConfirmOptions) => void;
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
            <FolderRow key={folder.id} folder={folder} status={state.folderStatuses[folder.id]} busy={busy} api={api} run={run} />
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

function FolderRow({ folder, status, busy, api, run }: { folder: WallpaperFolder; status: AppState["folderStatuses"][string] | undefined; busy: string | null; api: DesktopRuntime; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const label = status?.kind === "unavailable" ? "不可访问" : status?.kind === "empty" ? "无图片" : status?.invalidCount ? `${status.invalidCount} 无效` : "正常";
  const tone = status?.kind === "unavailable" ? "red" : status?.kind === "empty" || status?.invalidCount ? "amber" : "green";
  return <div className="folder-row">
    <Toggle label={`启用 ${folder.path}`} checked={folder.enabled} onChange={(enabled) => void run(`folder-${folder.id}`, () => api.updateFolder({ ...folder, enabled }))} />
    <strong>{pathName(folder.path)}</strong>
    <span className="folder-path">{folder.path}</span>
    <span className="folder-count">{status?.kind === "available" ? status.availableCount : "—"}</span>
    <Tag tone={tone}>{label}</Tag>
    <div className="row-actions">
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
  const keyword = favoriteFilter.trim().toLowerCase();
  const favoritePaths = keyword
    ? state.favoritePaths.filter((path) => pathName(path).toLowerCase().includes(keyword))
    : state.favoritePaths;
  return <div className="prototype-page favorites-page">
    <section className="content-section favorite-section">
      <SectionHeading title={<>喜欢的壁纸 {state.favoritePaths.length > 0 && <b>({state.favoritePaths.length})</b>}</>} action={state.favoritePaths.length > 0 ? <input className="section-filter-input" type="search" aria-label="筛选喜欢的壁纸" placeholder="按文件名筛选" value={favoriteFilter} onChange={(event) => setFavoriteFilter(event.target.value)} /> : undefined} />
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

function OnlineView({ api, state, busy, run, updateConfig, onOpenViewer, openConfirm }: { api: DesktopRuntime; state: AppState; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; updateConfig: (patch: Partial<AppConfig>) => void; onOpenViewer: (filePath: string) => void; openConfirm: (options: ConfirmOptions) => void }) {
  const [sourceFilter, setSourceFilter] = useState("all");
  const [galleryFilter, setGalleryFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(ONLINE_PAGE_SIZE);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prewarmedImagePaths = useRef(new Set<string>());
  const galleryKeyword = galleryFilter.trim().toLowerCase();
  const images = (sourceFilter === "all" ? state.onlineImages : state.onlineImages.filter((image) => image.sourceId === sourceFilter))
    .filter((image) => !galleryKeyword || image.localPath.toLowerCase().includes(galleryKeyword));
  const visibleImages = images.slice(0, visibleCount);
  const selectedLog = state.onlineSyncLogs.find((log) => log.id === selectedLogId) ?? null;
  useEffect(() => {
    setSelectedLogId((current) => current && state.onlineSyncLogs.some((log) => log.id === current) ? current : null);
  }, [state.onlineSyncLogs]);
  useEffect(() => {
    const loadMore = loadMoreRef.current;
    if (!loadMore || visibleCount >= images.length) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisibleCount((count) => Math.min(count + ONLINE_PAGE_SIZE, images.length));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((count) => Math.min(count + ONLINE_PAGE_SIZE, images.length));
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(loadMore);
    return () => observer.disconnect();
  }, [images.length, visibleCount]);
  useEffect(() => {
    const filePaths = images
      .slice(0, visibleCount + ONLINE_PAGE_SIZE)
      .map((image) => image.localPath)
      .filter((filePath) => !prewarmedImagePaths.current.has(filePath));
    if (filePaths.length === 0) return;
    filePaths.forEach((filePath) => prewarmedImagePaths.current.add(filePath));
    void api.prewarmImageAssets(filePaths, "grid").catch(() => {
      filePaths.forEach((filePath) => prewarmedImagePaths.current.delete(filePath));
    });
  }, [api, images, visibleCount]);
  return <div className="prototype-page online-page">
    <div className="online-layout">
      <div className="online-primary">
        <section className="content-section storage-section">
          <SectionHeading title="存储概览" />
          <div className="storage-overview">
            <Metric label="已占用" value={`${(state.onlineStorageBytes / 1024 ** 3).toFixed(1)} GB`} sub={`/ ${state.onlineStorageLimitGb} GB 上限`} />
            <Metric label="已下载" value={String(state.onlineImages.length)} sub="张原图" />
            <Metric label="请求分辨率" value={`${state.onlineMinimumResolution}p`} sub="UPX8 参数" />
          </div>
        </section>
        <section className="content-section">
          <SectionHeading title="抓取来源" />
          <div className="source-list">
            {state.onlineSources.map((source) => <SourceRow key={source.id} source={source} api={api} busy={busy} run={run} />)}
          </div>
        </section>
        <section className="content-section gallery-section">
          <SectionHeading title="已下载图片" action={<div className="gallery-controls"><input className="section-filter-input" type="search" aria-label="筛选已下载图片" placeholder="按文件名筛选" value={galleryFilter} onChange={(event) => { setGalleryFilter(event.target.value); setVisibleCount(ONLINE_PAGE_SIZE); }} /><button className="action-button is-small" type="button" aria-label="刷新已下载图片" disabled={busy !== null} onClick={() => void run("refresh-online", () => api.rescanFolders())}><RefreshCw size={14} /> 刷新</button><label className="inline-select">来源<select aria-label="在线图片来源" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setVisibleCount(ONLINE_PAGE_SIZE); }}><option value="all">全部来源</option>{state.onlineSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label></div>} />
          {images.length === 0 ? <EmptyState text={state.onlineImages.length === 0 ? "尚未下载在线图片" : "没有匹配的图片"} /> : <div className="online-gallery">{visibleImages.map((image) => <OnlineImageCard key={image.id} image={image} isFavorite={state.favoritePaths.some((path) => samePath(path, image.localPath))} api={api} busy={busy} run={run} onOpenViewer={onOpenViewer} openConfirm={openConfirm} />)}{visibleCount < images.length && <div ref={loadMoreRef} className="online-gallery-load-more" role="status" aria-label="加载更多在线图片"><LoaderCircle className="spin" size={14} /></div>}</div>}
        </section>
      </div>
      <aside className="online-settings">
        <div className="side-setting"><span>受管在线目录</span><strong title={state.onlineDirectory ?? ""}>{state.onlineDirectory ?? "尚未设置"}</strong><button className="action-button is-small" type="button" onClick={() => void run("select-directory", () => api.selectOnlineDirectory())}><FolderOpen size={14} /> 选择目录</button></div>
        <div className="side-setting"><label>容量上限<select aria-label="在线目录容量上限" value={state.onlineStorageLimitGb} onChange={(event) => updateConfig({ onlineStorageLimitGb: Number(event.target.value) as AppConfig["onlineStorageLimitGb"] })}>{[1, 5, 10, 20].map((size) => <option key={size} value={size}>{size} GB</option>)}</select></label></div>
        <div className="side-setting"><label>请求分辨率<select aria-label="在线图片请求分辨率" value={state.onlineMinimumResolution} onChange={(event) => updateConfig({ onlineMinimumResolution: Number(event.target.value) as AppConfig["onlineMinimumResolution"] })}>{[1920, 2560, 3840].map((size) => <option key={size} value={size}>{size}p</option>)}</select></label></div>
        <p>在线来源默认关闭，只有启用或手动抓取后才会联网。</p>
        <section className="sync-log-panel" aria-labelledby="sync-log-title">
          <div className="side-panel-heading"><span id="sync-log-title">同步记录</span><small>{state.onlineSyncLogs.length}</small></div>
          {state.onlineSyncLogs.length === 0 ? <div className="sync-log-empty">暂无同步记录</div> : <>
            <div className="sync-log-list">
              {state.onlineSyncLogs.map((log) => <SyncLogListItem key={log.id} log={log} selected={log.id === selectedLog?.id} onSelect={() => setSelectedLogId(log.id)} />)}
            </div>
            {selectedLog && <SyncLogDetail log={selectedLog} />}
          </>}
        </section>
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

function OnlineImageCard({ image, isFavorite, api, busy, run, onOpenViewer, openConfirm }: { image: OnlineImage; isFavorite: boolean; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; onOpenViewer: (filePath: string) => void; openConfirm: (options: ConfirmOptions) => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
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
    void api.getImageAsset(image.localPath, "grid")
      .then((asset) => { if (!cancelled && asset) setThumbnail(asset.src); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, image.id, isVisible]);
  return <article ref={cardRef} className="online-image-card">
    {thumbnail ? <img src={thumbnail} alt={pathName(image.localPath)} loading="lazy" decoding="async" /> : <div className="online-image-placeholder" role="img" aria-label={`${pathName(image.localPath)} 缩略图加载中`} />}
    <div><strong title={pathName(image.localPath)}>{pathName(image.localPath)}</strong><span>{image.width}×{image.height} · {formatDate(image.downloadedAt)}</span><div className="image-actions"><button className="action-button is-small is-primary" type="button" disabled={busy !== null} onClick={() => void run(`set-${image.id}`, () => api.setOnlineImageAsWallpaper(image.id))}>{busy === `set-${image.id}` ? "设置中..." : "设为壁纸"}</button><button className="icon-button" type="button" aria-label={`查看原图 ${pathName(image.localPath)}`} title="查看原图" onClick={() => onOpenViewer(image.localPath)}><Maximize2 size={14} /></button><button className={isFavorite ? "icon-button favorite-toggle is-favorite" : "icon-button favorite-toggle"} type="button" aria-label={`${isFavorite ? "取消喜欢" : "喜欢"} ${pathName(image.localPath)}`} title={isFavorite ? "取消喜欢" : "喜欢"} disabled={busy !== null} onClick={() => void run(`favorite-${image.id}`, () => api.toggleFavorite(image.localPath))}><Heart size={14} fill={isFavorite ? "currentColor" : "none"} /></button><button className="icon-button" type="button" aria-label={`打开 ${pathName(image.localPath)}`} title="打开所在目录" disabled={busy !== null} onClick={() => void run(`reveal-${image.id}`, () => api.revealOnlineImage(image.id))}><FolderOpen size={14} /></button><button className="icon-button is-danger" type="button" aria-label={`删除 ${pathName(image.localPath)}`} title="删除" disabled={busy !== null} onClick={() => openConfirm({ title: "删除在线图片", description: `将从磁盘删除 ${pathName(image.localPath)} 并移入系统回收站，同时移除其喜欢记录。回收站中的文件仍可手动还原。`, confirmLabel: "删除", busyKey: `delete-image-${image.id}`, action: () => api.deleteOnlineImage(image.id) })}>{busy === `delete-image-${image.id}` ? "删除中..." : <Trash2 size={14} />}</button></div></div>
  </article>;
}

function SettingsView({ state, updateConfig }: { state: AppState; updateConfig: (patch: Partial<AppConfig>) => void }) {
  const [nextShortcut, setNextShortcut] = useState(state.globalNextShortcut ?? "");
  const [skipShortcut, setSkipShortcut] = useState(state.globalSkipShortcut ?? "");
  useEffect(() => setNextShortcut(state.globalNextShortcut ?? ""), [state.globalNextShortcut]);
  useEffect(() => setSkipShortcut(state.globalSkipShortcut ?? ""), [state.globalSkipShortcut]);
  const saveNextShortcut = () => { const value = nextShortcut.trim() || null; if (value !== state.globalNextShortcut) updateConfig({ globalNextShortcut: value }); };
  const saveSkipShortcut = () => { const value = skipShortcut.trim() || null; if (value !== state.globalSkipShortcut) updateConfig({ globalSkipShortcut: value }); };
  return <div className="prototype-page settings-page">
    <SettingsPanel title="自动切换"><SettingsRow label="切换间隔" description="下一张壁纸的等待时长"><select aria-label="切换间隔" value={state.intervalMinutes} onChange={(event) => updateConfig({ intervalMinutes: Number(event.target.value) })}>{intervalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></SettingsRow><SettingsRow label="切换顺序" description={state.rotationOrder === "random" ? "一轮内不重复" : "按绝对路径稳定循环"}><div className="segmented-control"><button type="button" className={state.rotationOrder === "random" ? "is-selected" : undefined} onClick={() => updateConfig({ rotationOrder: "random" })}>随机</button><button type="button" className={state.rotationOrder === "sequential" ? "is-selected" : undefined} onClick={() => updateConfig({ rotationOrder: "sequential" as RotationOrder })}>顺序</button></div></SettingsRow><SettingsRow label="显示方式" description="壁纸填充屏幕的方式"><select aria-label="设置显示方式" value={state.displayMode} onChange={(event) => updateConfig({ displayMode: event.target.value as WallpaperMode })}>{displayModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></SettingsRow></SettingsPanel>
    <SettingsPanel title="系统集成"><SettingsRow label="开机自动启动" description="仅在系统托盘运行，不显示主窗口"><Toggle label="开机自动启动" checked={state.autoStart} onChange={(autoStart) => updateConfig({ autoStart })} /></SettingsRow><SettingsRow label="跟随系统主题" description="深色 / 浅色主题切换时同步调整"><Toggle label="跟随系统主题" checked={state.followSystemTheme} onChange={(followSystemTheme) => updateConfig({ followSystemTheme })} /></SettingsRow><SettingsRow label="关闭窗口时隐藏到托盘" description="关闭后继续在后台运行"><Toggle label="关闭窗口时隐藏到托盘" checked={state.hideToTrayOnClose} onChange={(hideToTrayOnClose) => updateConfig({ hideToTrayOnClose })} /></SettingsRow></SettingsPanel>
    <SettingsPanel title="全局快捷键"><SettingsRow label="下一张壁纸" description="保存时立即尝试注册"><div className="shortcut-editor"><input aria-label="全局下一张快捷键" placeholder="例如 Ctrl+Alt+N" value={nextShortcut} onChange={(event) => setNextShortcut(event.target.value)} onBlur={saveNextShortcut} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><ShortcutStatusTag status={state.shortcutStatus} /></div></SettingsRow><SettingsRow label="跳过此图" description="保存时立即尝试注册"><div className="shortcut-editor"><input aria-label="全局跳过快捷键" placeholder="例如 Ctrl+Alt+S" value={skipShortcut} onChange={(event) => setSkipShortcut(event.target.value)} onBlur={saveSkipShortcut} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><ShortcutStatusTag status={state.skipShortcutStatus} /></div></SettingsRow></SettingsPanel>
    <SettingsPanel title="更新"><SettingsRow label="当前版本" description="手动检查并由用户确认下载"><span className="settings-version">v0.1.5</span></SettingsRow><SettingsRow label="检查更新" description="当前发布未配置签名更新清单"><button className="action-button is-small" type="button" disabled title="需要签名私钥和更新地址">检查更新</button></SettingsRow></SettingsPanel>
  </div>;
}

function ShortcutStatusTag({ status }: { status: ShortcutStatus }) { if (status.state === "active") return <Tag tone="green">已注册</Tag>; if (status.state === "error") return <span className="shortcut-status"><Tag tone="red">注册失败</Tag><small role="alert">{status.message}</small></span>; return <Tag tone="amber">未启用</Tag>; }

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
    onlineImages: [], onlineSyncLogs: [], onlineDirectory: "D:\\Pictures\\ZX Wallpaper\\Online", onlineStorageLimitGb: 5, onlineMinimumResolution: 1920,
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
    updateOnlineSource: (source) => update({ onlineSources: state.onlineSources.map((item) => item.id === source.id ? source : item) }), runOnlineSource: () => Promise.resolve(state), runUpx8Category: () => Promise.resolve(state),
    setOnlineImageAsWallpaper: (id) => { const image = state.onlineImages.find((item) => item.id === id); return image ? update({ currentPath: image.localPath, paused: true }) : Promise.resolve(state); }, deleteOnlineImage: (id) => update({ onlineImages: state.onlineImages.filter((image) => image.id !== id), favoritePaths: state.favoritePaths.filter((path) => !samePath(path, state.onlineImages.find((image) => image.id === id)?.localPath ?? "")) }), selectOnlineDirectory: () => update({ onlineDirectory: "D:\\Pictures\\ZX Wallpaper Library" }), revealOnlineImage: () => Promise.resolve(state), revealWallpaper: () => Promise.resolve(), onStateChanged: (listener) => { listeners.add(listener); return Promise.resolve(() => listeners.delete(listener)); },
  };
}

function pathName(path: string) { return path.split(/[/\\]/).pop() ?? path; }
function parentPath(path: string) { const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")); return slash < 0 ? path : path.slice(0, slash); }
function samePath(left: string, right: string) { return left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase(); }
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
  if (key === "delete-all-skipped") return pending ? "正在删除已跳过图片..." : "已跳过图片已全部移入回收站。";
  if (key === "delete-skipped-file") return pending ? "正在删除图片文件..." : "图片文件已移入回收站。";
  if (key.startsWith("run-")) return pending ? "正在抓取在线来源，下载原图可能需要一些时间..." : "在线来源抓取已完成，请查看发现和下载数量。";
  if (key === "refresh-online") return pending ? "正在刷新已下载图片..." : "已刷新图片列表。";
  return pending ? "正在处理..." : "操作已完成。";
}
function operationError(cause: unknown) {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return "操作未完成，请检查相关目录或来源后重试。";
}
function formatInterval(minutes: number) { return intervalOptions.find((option) => option.value === minutes)?.label ?? `${minutes} 分钟`; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function formatLogTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
