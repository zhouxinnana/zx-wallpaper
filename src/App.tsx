import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  CircleAlert,
  CloudDownload,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  Keyboard,
  LayoutDashboard,
  LoaderCircle,
  Monitor,
  MonitorCog,
  MoreHorizontal,
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
  Zap,
} from "lucide-react";
import type {
  AppConfig,
  AppState,
  DesktopRuntime,
  OnlineImage,
  OnlineSource,
  PreviewItem,
  WallpaperFolder,
  WallpaperMode,
} from "./runtime/types";
import { tauriRuntime } from "./runtime/tauri-runtime";

const previewImage =
  "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1600&q=85";

const intervalOptions = [
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
const ONLINE_PAGE_SIZE = 24;
let onlineThumbnailQueue: Promise<void> = Promise.resolve();
type View = "workbench" | "online" | "lab" | "settings";

function queueOnlineThumbnail(
  api: DesktopRuntime,
  imageId: string,
  isCancelled: () => boolean,
): Promise<string | null> {
  const request = onlineThumbnailQueue.then(() =>
    isCancelled() ? null : api.getOnlineThumbnail(imageId),
  );
  onlineThumbnailQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

const navigation: Array<{
  key: View;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
}> = [
  { key: "workbench", label: "工作台", subtitle: "本地壁纸与切换", icon: LayoutDashboard },
  { key: "online", label: "在线发现", subtitle: "来源与下载管理", icon: Globe2 },
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
  const busyRef = useRef(false);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    void api.onStateChanged((next) => {
      if (active) setState(next);
    }).then((stop) => {
      if (!active) {
        stop();
        return;
      }
      unsubscribe = stop;
      void api.getState().then(
        (next) => {
          if (active) setState(next);
        },
        () => {
          if (active) setError("无法读取应用状态，请重试。");
        },
      );
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
    busyRef.current = true;
    setBusy(key);
    setError(null);
    setStatus(operationMessage(key, "pending"));
    try {
      await action();
      setStatus(operationMessage(key, "success"));
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

  if (!state) return <LoadingScreen />;

  const activeNavigation = navigation.find((item) => item.key === view)!;
  const content = {
    workbench: <WorkbenchView api={api} state={state} busy={busy} run={run} updateConfig={updateConfig} />,
    online: <OnlineView api={api} state={state} busy={busy} run={run} updateConfig={updateConfig} />,
    lab: <LabView />,
    settings: <SettingsView state={state} updateConfig={updateConfig} />,
  }[view];

  return (
    <div className="zx-app-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <span className="zx-mark" aria-hidden="true">ZX</span>
          <span>ZX Wallpaper</span>
          <span className="titlebar-version">v1.0.0</span>
        </div>
        <div className="window-actions" aria-label="窗口控制">
          <button type="button" aria-label="最小化窗口" disabled>−</button>
          <button type="button" aria-label="最大化窗口" disabled>□</button>
          <button type="button" aria-label="关闭窗口" disabled>×</button>
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
            <small>ZX Wallpaper · v1.0.0</small>
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
    </div>
  );
}

function WorkbenchView({
  api,
  state,
  busy,
  run,
  updateConfig,
}: {
  api: DesktopRuntime;
  state: AppState;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => void;
}) {
  const folders = state.folders.filter((folder) => folder.id !== "online-library");
  const currentName = pathName(state.currentPath ?? "") || "尚未选择壁纸";
  const currentPath = state.currentPath ?? "";
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
        <img className="hero-image hero-image-current" key={currentPath || currentPreviewUrl} src={currentPreviewUrl} alt="当前壁纸预览" />
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
          <div className="hero-tags"><Tag tone="cyan">所有显示器同步</Tag></div>
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
      <section className="content-section">
        <SectionHeading title="壁纸目录" action={<button className="action-button is-primary is-small" type="button" disabled={busy === "folder"} onClick={() => void run("folder", () => api.addFolder())}><Plus size={14} /> 添加目录</button>} />
        <div className="folder-table">
          {folders.length === 0 ? <EmptyState text="尚未添加壁纸目录" /> : folders.map((folder) => (
            <FolderRow key={folder.id} folder={folder} status={state.folderStatuses[folder.id]} busy={busy} api={api} run={run} />
          ))}
        </div>
      </section>
      <section className="content-section skipped-section">
        <SectionHeading title={<>已跳过图片 {state.skippedPaths.length > 0 && <b>({state.skippedPaths.length})</b>}</>} action={state.skippedPaths.length ? <button className="action-button is-small" type="button" onClick={() => void run("restore-all", () => api.restoreAllSkipped())}>全部恢复</button> : undefined} />
        {state.skippedPaths.length === 0 ? <EmptyState text="暂无跳过的图片" /> : <div className="skipped-grid">
          {state.skippedPaths.map((path) => <SkippedCard key={path} path={path} previewUrl={state.previewUrl ?? previewImage} api={api} run={run} />)}
        </div>}
      </section>
    </div>
  );
}

function PreviewThumbnail({ item, api }: { item: PreviewItem; api: DesktopRuntime }) {
  const [thumbnail, setThumbnail] = useState(item.previewUrl);

  useEffect(() => {
    let active = true;
    if (item.previewUrl) {
      setThumbnail(item.previewUrl);
      return () => { active = false; };
    }
    void api.getPreviewThumbnail(item.path).then((url) => {
      if (active && url) setThumbnail(url);
    });
    return () => { active = false; };
  }, [api, item.path, item.previewUrl]);

  return <img src={thumbnail ?? previewImage} alt="" />;
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

function SkippedCard({ path, previewUrl, api, run }: { path: string; previewUrl: string; api: DesktopRuntime; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const [thumbnail, setThumbnail] = useState(previewUrl);
  useEffect(() => { void api.getSkippedThumbnail(path).then((url) => { if (url) setThumbnail(url); }); }, [api, path]);
  return <article className="skipped-card">
    <img src={thumbnail} alt="" />
    <strong title={pathName(path)}>{pathName(path)}</strong>
    <div><button className="action-button is-small" type="button" onClick={() => void run(`restore-${path}`, () => api.restoreSkippedPath(path))}>恢复</button><button className="action-button is-small is-danger" type="button" onClick={() => void run(`delete-${path}`, () => api.deleteSkippedPath(path))}>删除</button></div>
  </article>;
}

function OnlineView({ api, state, busy, run, updateConfig }: { api: DesktopRuntime; state: AppState; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void>; updateConfig: (patch: Partial<AppConfig>) => void }) {
  const [url, setUrl] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(ONLINE_PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prewarmedThumbnailIds = useRef(new Set<string>());
  const images = sourceFilter === "all" ? state.onlineImages : state.onlineImages.filter((image) => image.sourceId === sourceFilter);
  const visibleImages = images.slice(0, visibleCount);
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
    const imageIds = images
      .slice(0, visibleCount + ONLINE_PAGE_SIZE)
      .map((image) => image.id)
      .filter((imageId) => !prewarmedThumbnailIds.current.has(imageId));
    if (imageIds.length === 0) return;
    imageIds.forEach((imageId) => prewarmedThumbnailIds.current.add(imageId));
    void api.prewarmOnlineThumbnails(imageIds).catch(() => {
      imageIds.forEach((imageId) => prewarmedThumbnailIds.current.delete(imageId));
    });
  }, [api, images, visibleCount]);
  const addSource = () => {
    const nextUrl = url.trim();
    if (!nextUrl) return;
    void run("add-source", async () => { await api.addOnlineSource(nextUrl); setUrl(""); });
  };
  return <div className="prototype-page online-page">
    <div className="online-layout">
      <div className="online-primary">
        <section className="content-section storage-section">
          <SectionHeading title="存储概览" />
          <div className="storage-overview">
            <Metric label="已占用" value={`${(state.onlineStorageBytes / 1024 ** 3).toFixed(1)} GB`} sub={`/ ${state.onlineStorageLimitGb} GB 上限`} />
            <Metric label="已下载" value={String(state.onlineImages.length)} sub="张原图" />
            <Metric label="最低分辨率" value={`${state.onlineMinimumResolution}p`} sub="横向图片" />
          </div>
        </section>
        <section className="content-section">
          <SectionHeading title="抓取来源" />
          <div className="source-list">
            {state.onlineSources.map((source) => <SourceRow key={source.id} source={source} api={api} busy={busy} run={run} />)}
          </div>
          <div className="add-source-form">
            <label htmlFor="custom-source">添加自定义 HTTPS 单页来源</label>
            <div><input id="custom-source" aria-label="自定义来源地址" value={url} placeholder="https://example.com/wallpapers" onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addSource(); }} /><button className="action-button is-primary" type="button" disabled={!url.trim() || busy === "add-source"} onClick={addSource}><Plus size={14} /> 添加来源</button></div>
          </div>
        </section>
        <section className="content-section gallery-section">
          <SectionHeading title="已下载图片" action={<div className="gallery-controls"><button className="action-button is-small" type="button" aria-label="刷新已下载图片" disabled={busy !== null} onClick={() => void run("refresh-online", () => api.rescanFolders())}><RefreshCw size={14} /> 刷新</button><label className="inline-select">来源<select aria-label="在线图片来源" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setVisibleCount(ONLINE_PAGE_SIZE); }}><option value="all">全部来源</option>{state.onlineSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label></div>} />
          {images.length === 0 ? <EmptyState text="尚未下载在线图片" /> : <div className="online-gallery">{visibleImages.map((image) => <OnlineImageCard key={image.id} image={image} api={api} busy={busy} run={run} />)}{visibleCount < images.length && <div ref={loadMoreRef} className="online-gallery-load-more" role="status" aria-label="加载更多在线图片"><LoaderCircle className="spin" size={14} /></div>}</div>}
        </section>
      </div>
      <aside className="online-settings">
        <div className="side-setting"><span>受管在线目录</span><strong title={state.onlineDirectory ?? ""}>{state.onlineDirectory ?? "尚未设置"}</strong><button className="action-button is-small" type="button" onClick={() => void run("select-directory", () => api.selectOnlineDirectory())}><FolderOpen size={14} /> 选择目录</button></div>
        <div className="side-setting"><label>容量上限<select aria-label="在线目录容量上限" value={state.onlineStorageLimitGb} onChange={(event) => updateConfig({ onlineStorageLimitGb: Number(event.target.value) as AppConfig["onlineStorageLimitGb"] })}>{[1, 5, 10, 20].map((size) => <option key={size} value={size}>{size} GB</option>)}</select></label></div>
        <div className="side-setting"><label>最低分辨率<select aria-label="在线图片最低分辨率" value={state.onlineMinimumResolution} onChange={(event) => updateConfig({ onlineMinimumResolution: Number(event.target.value) as AppConfig["onlineMinimumResolution"] })}>{[1920, 2560, 3840].map((size) => <option key={size} value={size}>{size}p</option>)}</select></label></div>
        <p>在线来源默认关闭，只有启用或手动抓取后才会联网。</p>
      </aside>
    </div>
  </div>;
}

function SourceRow({ source, api, busy, run }: { source: OnlineSource; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const nextSource = (patch: Partial<OnlineSource>) => ({ ...source, ...patch });
  return <article className="source-row">
    <Toggle label={`启用 ${source.name}`} checked={source.enabled} onChange={(enabled) => void run(`source-${source.id}`, () => api.updateOnlineSource(nextSource({ enabled })))} />
    <div className="source-copy"><strong>{source.name}</strong><span>{source.url}</span>{source.lastError && <small className="source-error">{source.lastError}</small>}{source.categoryStatuses && <div className="category-statuses">{source.categoryStatuses.map((category) => <Tag key={category.key} tone={category.lastError ? "red" : "blue"}>{category.label} {category.downloaded}</Tag>)}</div>}</div>
    <div className="source-stats"><span>{source.lastDiscovered} 发现</span><span>{source.lastDownloaded} 下载</span><label className="inline-select">间隔<select aria-label={`抓取间隔 ${source.name}`} value={source.intervalHours} onChange={(event) => void run(`source-${source.id}`, () => api.updateOnlineSource(nextSource({ intervalHours: Number(event.target.value) as OnlineSource["intervalHours"] })))}>{onlineIntervals.map((hours) => <option key={hours} value={hours}>{hours} 小时</option>)}</select></label><small>{source.nextRunAt ? `下次 ${formatTime(source.nextRunAt)}` : "未计划"}</small></div>
    <div className="row-actions"><button type="button" aria-label={`立即抓取 ${source.name}`} disabled={busy !== null} onClick={() => void run(`run-${source.id}`, () => api.runOnlineSource(source.id))}><CloudDownload size={14} /></button>{source.kind === "custom" && <button type="button" aria-label={`删除 ${source.name}`} className="danger" disabled={busy !== null} onClick={() => void run(`remove-source-${source.id}`, () => api.removeOnlineSource(source.id))}><Trash2 size={14} /></button>}</div>
  </article>;
}

function OnlineImageCard({ image, api, busy, run }: { image: OnlineImage; api: DesktopRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
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
    void queueOnlineThumbnail(api, image.id, () => cancelled)
      .then((url) => { if (!cancelled && url) setThumbnail(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, image.id, isVisible]);
  return <article ref={cardRef} className="online-image-card">
    {thumbnail ? <img src={thumbnail} alt={pathName(image.localPath)} /> : <div className="online-image-placeholder" role="img" aria-label={`${pathName(image.localPath)} 缩略图加载中`} />}
    <div><strong title={pathName(image.localPath)}>{pathName(image.localPath)}</strong><span>{image.width}×{image.height} · {formatDate(image.downloadedAt)}</span><div className="image-actions"><button className="action-button is-small is-primary" type="button" disabled={busy !== null} onClick={() => void run(`set-${image.id}`, () => api.setOnlineImageAsWallpaper(image.id))}>{busy === `set-${image.id}` ? "设置中..." : "设为壁纸"}</button><button className="action-button is-small" type="button" aria-label={`打开 ${pathName(image.localPath)}`} disabled={busy !== null} onClick={() => void run(`reveal-${image.id}`, () => api.revealOnlineImage(image.id))}><FolderOpen size={14} /></button><button className="action-button is-small is-danger" type="button" aria-label={`删除 ${pathName(image.localPath)}`} disabled={busy !== null} onClick={() => void run(`delete-image-${image.id}`, () => api.deleteOnlineImage(image.id))}>{busy === `delete-image-${image.id}` ? "删除中..." : <Trash2 size={14} />}</button></div></div>
  </article>;
}

function SettingsView({ state, updateConfig }: { state: AppState; updateConfig: (patch: Partial<AppConfig>) => void }) {
  const [shortcut, setShortcut] = useState(state.globalNextShortcut ?? "");
  useEffect(() => setShortcut(state.globalNextShortcut ?? ""), [state.globalNextShortcut]);
  const saveShortcut = () => { const value = shortcut.trim() || null; if (value !== state.globalNextShortcut) updateConfig({ globalNextShortcut: value }); };
  return <div className="prototype-page settings-page">
    <SettingsPanel title="自动切换"><SettingsRow label="切换间隔" description="下一张壁纸的等待时长"><select aria-label="切换间隔" value={state.intervalMinutes} onChange={(event) => updateConfig({ intervalMinutes: Number(event.target.value) })}>{intervalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></SettingsRow><SettingsRow label="切换顺序" description="随机不重复循环，一轮每张只出现一次"><div className="segmented-control"><button type="button" className="is-selected">随机</button><button type="button" disabled title="顺序切换不属于当前 MVP">顺序</button></div></SettingsRow><SettingsRow label="显示方式" description="壁纸填充屏幕的方式"><select aria-label="设置显示方式" value={state.displayMode} onChange={(event) => updateConfig({ displayMode: event.target.value as WallpaperMode })}>{displayModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></SettingsRow></SettingsPanel>
    <SettingsPanel title="系统集成"><SettingsRow label="开机自动启动" description="仅在系统托盘运行，不显示主窗口"><Toggle label="开机自动启动" checked={state.autoStart} onChange={(autoStart) => updateConfig({ autoStart })} /></SettingsRow><SettingsRow label="跟随系统主题" description="深色 / 浅色主题切换时同步调整"><Toggle label="跟随系统主题" checked={state.followSystemTheme} onChange={(followSystemTheme) => updateConfig({ followSystemTheme })} /></SettingsRow><SettingsRow label="切换时系统通知" description="后续桌面能力"><Toggle label="切换时系统通知" checked={false} disabled onChange={() => {}} /></SettingsRow></SettingsPanel>
    <SettingsPanel title="全局快捷键"><SettingsRow label="下一张壁纸" description="全局热键，应用在后台时也有效"><div className="shortcut-editor"><input aria-label="全局下一张快捷键" placeholder="例如 Ctrl+Alt+N" value={shortcut} onChange={(event) => setShortcut(event.target.value)} onBlur={saveShortcut} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><Tag tone={state.globalShortcutRegistered ? "green" : "amber"}>{state.globalShortcutRegistered ? "已注册" : "未注册"}</Tag></div></SettingsRow></SettingsPanel>
    <SettingsPanel title="系统托盘菜单预览"><div className="tray-preview"><span><Monitor size={14} /> 显示主窗口</span><span><SkipForward size={14} /> 切换下一张</span><span><Pause size={14} /> 暂停自动切换</span><hr /><span className="danger"><Trash2 size={14} /> 退出 ZX Wallpaper</span></div></SettingsPanel>
    <div className="about-row"><div><strong>ZX Wallpaper</strong><span>v1.0.0 · 本地优先壁纸管理工具</span></div><button className="action-button is-small" type="button" disabled title="更新服务不属于当前 MVP">检查更新</button></div>
  </div>;
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
function Tag({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "cyan" | "green" | "amber" | "red" }) { return <span className={`tag tag-${tone}`}>{children}</span>; }
function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) { return <button className={checked ? "toggle is-on" : "toggle"} type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>; }
function LoadingScreen() { return <div className="loading-screen"><LoaderCircle className="spin" size={22} /> 正在加载 ZX Wallpaper</div>; }

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
    intervalMinutes: 30, displayMode: "fill", autoStart: true, paused: false, followSystemTheme: true,
    currentPath: "D:\\Pictures\\Wallpapers\\Scenic\\mist-over-the-ridge.jpg", remainingPaths: previewItems.slice(1).map((item) => item.path), skippedPaths: [], globalNextShortcut: null, lastSwitchAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    onlineSources: [{ id: "wallhaven-sfw", name: "Wallhaven SFW", kind: "builtin", url: "https://wallhaven.cc/api/v1/search?purity=100", enabled: true, intervalHours: 24, lastRunAt: null, nextRunAt: null, lastDiscovered: 0, lastDownloaded: 0, lastError: null }],
    onlineImages: [], onlineDirectory: "D:\\Pictures\\ZX Wallpaper\\Online", onlineStorageLimitGb: 5, onlineMinimumResolution: 1920,
    availableCount: 128, previewUrl: previewImage, previewItems,
    folderStatuses: { "demo-scenic": { kind: "available", availableCount: 110, invalidCount: 0, scannedAt: new Date().toISOString() } },
    onlineStorageBytes: 1.2 * 1024 ** 3, globalShortcutRegistered: false,
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
    openFolder: () => Promise.resolve(state), rescanFolders: () => Promise.resolve(state), nextWallpaper: () => selectPreview(nextPath), selectWallpaper: selectPreview, getPreviewThumbnail: () => Promise.resolve(previewImage),
    skipCurrentWallpaper: () => update({ skippedPaths: state.currentPath ? [...state.skippedPaths, state.currentPath] : state.skippedPaths, currentPath: nextPath }),
    restoreSkippedPath: (path) => update({ skippedPaths: state.skippedPaths.filter((item) => item !== path) }), restoreAllSkipped: () => update({ skippedPaths: [] }), deleteSkippedPath: (path) => update({ skippedPaths: state.skippedPaths.filter((item) => item !== path) }), togglePaused: () => update({ paused: !state.paused }),
    addOnlineSource: (url) => update({ onlineSources: [...state.onlineSources, { id: `source-${Date.now()}`, name: new URL(url).hostname, kind: "custom", url, enabled: true, intervalHours: 24, lastRunAt: null, nextRunAt: null, lastDiscovered: 0, lastDownloaded: 0, lastError: null }] }),
    updateOnlineSource: (source) => update({ onlineSources: state.onlineSources.map((item) => item.id === source.id ? source : item) }), removeOnlineSource: (id) => update({ onlineSources: state.onlineSources.filter((source) => source.id !== id) }), runOnlineSource: () => Promise.resolve(state),
    setOnlineImageAsWallpaper: (id) => { const image = state.onlineImages.find((item) => item.id === id); return image ? update({ currentPath: image.localPath, paused: true }) : Promise.resolve(state); }, deleteOnlineImage: (id) => update({ onlineImages: state.onlineImages.filter((image) => image.id !== id) }), selectOnlineDirectory: () => update({ onlineDirectory: "D:\\Pictures\\ZX Wallpaper Library" }), revealOnlineImage: () => Promise.resolve(state), getOnlineThumbnail: () => Promise.resolve(previewImage), prewarmOnlineThumbnails: () => Promise.resolve(), getSkippedThumbnail: () => Promise.resolve(previewImage), onStateChanged: (listener) => { listeners.add(listener); return Promise.resolve(() => listeners.delete(listener)); },
  };
}

function pathName(path: string) { return path.split(/[/\\]/).pop() ?? path; }
function parentPath(path: string) { const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")); return slash < 0 ? path : path.slice(0, slash); }
function samePath(left: string, right: string) { return left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase(); }
function getAutoSwitchProgress(lastSwitchAt: string | null, intervalMinutes: number, now: number) {
  if (!lastSwitchAt || intervalMinutes <= 0) return 0;
  const switchedAt = Date.parse(lastSwitchAt);
  if (!Number.isFinite(switchedAt)) return 0;
  return Math.min(1, Math.max(0, (now - switchedAt) / (intervalMinutes * 60_000)));
}
function operationMessage(key: string, phase: "pending" | "success") {
  const pending = phase === "pending";
  if (key.startsWith("set-")) return pending ? "正在设置壁纸并同步所有显示器..." : "已设为壁纸，所有显示器已同步，自动切换已暂停。";
  if (key.startsWith("delete-image-")) return pending ? "正在删除在线图片..." : "在线图片已删除。";
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
