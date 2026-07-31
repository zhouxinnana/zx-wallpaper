import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  Clock3,
  Download,
  ExternalLink,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  Keyboard,
  LayoutDashboard,
  LoaderCircle,
  MonitorCog,
  MonitorUp,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AppConfig,
  AppState,
  OnlineImage,
  OnlineSource,
  WallpaperFolder,
  WallpaperMode,
} from "../electron/shared";

const intervalOptions = [
  { value: 15, label: "每 15 分钟" },
  { value: 30, label: "每 30 分钟" },
  { value: 60, label: "每小时" },
  { value: 180, label: "每 3 小时" },
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
const galleryPageSize = 48;
const demoPreviewUrl =
  "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1600&q=85";
type View = "workbench" | "online";
type DesktopApi = NonNullable<Window["zxWallpaper"]>;

const browserPreviewApi = createBrowserPreviewApi();
const appApi: DesktopApi = window.zxWallpaper ?? browserPreviewApi;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<View>("workbench");

  useEffect(() => {
    let active = true;
    void appApi.getState().then((next) => {
      if (active) setState(next);
    });
    const unsubscribe = appApi.onStateChanged(setState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }, []);

  const updateConfig = useCallback(
    (patch: Partial<AppConfig>) => {
      void run("config", () => appApi.updateConfig(patch));
    },
    [run],
  );

  useEffect(() => {
    if (!state) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      document.documentElement.dataset.theme =
        state.followSystemTheme && !query.matches ? "light" : "dark";
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [state?.followSystemTheme]);

  if (!state) return <LoadingScreen />;

  const running = !state.paused;
  const onlineUsage = `${(state.onlineStorageBytes / 1024 ** 3).toFixed(2)} / ${state.onlineStorageLimitGb} GB`;

  return (
    <div className="app-shell">
      <Sidebar
        activeView={view}
        running={running}
        onlineCount={state.onlineImages.length}
        onNavigate={setView}
      />
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="topbar-kicker">
              {view === "workbench"
                ? "DESKTOP ATMOSPHERE"
                : "ONLINE WALLPAPER ARCHIVE"}
            </p>
            <h1>{view === "workbench" ? "壁纸工作台" : "在线发现"}</h1>
            <p className="topbar-description">
              {view === "workbench"
                ? "让桌面保持新鲜，也保持安静。"
                : "管理来源，浏览并清理已下载壁纸。"}
            </p>
          </div>
          {view === "workbench" ? (
            <div
              className={
                running
                  ? "runtime-status"
                  : "runtime-status runtime-status--paused"
              }
            >
              <span
                className={
                  running ? "status-dot" : "status-dot status-dot--paused"
                }
              />
              {running ? "自动切换中" : "已暂停"}
            </div>
          ) : (
            <div className="archive-count">
              <ImageIcon size={15} />
              已下载 {state.onlineImages.length}
            </div>
          )}
        </header>
        {view === "workbench" ? (
          <WorkbenchView
            state={state}
            busy={busy}
            updateConfig={updateConfig}
            run={run}
          />
        ) : (
          <OnlineDiscoveryView
            state={state}
            busy={busy}
            updateConfig={updateConfig}
            run={run}
            onlineUsage={onlineUsage}
          />
        )}
      </main>
    </div>
  );
}

function Sidebar({
  activeView,
  running,
  onlineCount,
  onNavigate,
}: {
  activeView: View;
  running: boolean;
  onlineCount: number;
  onNavigate: (view: View) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="ZX Wallpaper">
        <span className="brand-mark">
          <img src="./zx-wallpaper-logo.svg" alt="" />
        </span>
        <span className="brand-name">ZX Wallpaper</span>
      </div>
      <nav className="navigation" aria-label="主导航">
        <button
          className={
            activeView === "workbench"
              ? "nav-item nav-item--active"
              : "nav-item"
          }
          type="button"
          aria-current={activeView === "workbench" ? "page" : undefined}
          onClick={() => onNavigate("workbench")}
        >
          <LayoutDashboard size={17} />
          <span>工作台</span>
          {activeView === "workbench" && (
            <span className="nav-pulse" aria-hidden="true" />
          )}
        </button>
        <button
          className={
            activeView === "online" ? "nav-item nav-item--active" : "nav-item"
          }
          type="button"
          aria-current={activeView === "online" ? "page" : undefined}
          onClick={() => onNavigate("online")}
        >
          <Globe2 size={17} />
          <span>在线发现</span>
          <span className="nav-count">{onlineCount}</span>
        </button>
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-status">
          <span
            className={running ? "status-dot" : "status-dot status-dot--paused"}
          />
          <span>{running ? "后台运行中" : "自动切换已暂停"}</span>
        </div>
        <span className="sidebar-version">LOCAL / 0.2</span>
      </div>
    </aside>
  );
}

function WorkbenchView({
  state,
  busy,
  updateConfig,
  run,
}: {
  state: AppState;
  busy: string | null;
  updateConfig: (patch: Partial<AppConfig>) => void;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
}) {
  const currentFileName = pathName(state.currentPath ?? "") || "尚未选择壁纸";
  const localFolders = state.folders.filter(
    (folder) => folder.id !== "online-library",
  );
  const [shortcutInput, setShortcutInput] = useState(
    state.globalNextShortcut ?? "",
  );
  useEffect(() => {
    setShortcutInput(state.globalNextShortcut ?? "");
  }, [state.globalNextShortcut]);
  const saveShortcut = () => {
    const globalNextShortcut = shortcutInput.trim() || null;
    if (globalNextShortcut !== state.globalNextShortcut)
      updateConfig({ globalNextShortcut });
  };
  return (
    <div className="view-content">
      <section className="workbench" aria-label="壁纸工作台">
        <CurrentWallpaper
          state={state}
          fileName={currentFileName}
          busy={busy}
          onNext={() => void run("next", () => appApi.nextWallpaper())}
          onSkip={() => void run("skip", () => appApi.skipCurrentWallpaper())}
          onToggle={() => void run("pause", () => appApi.togglePaused())}
        />
        <div className="settings-rail">
          <section className="settings-panel settings-panel--timing">
            <SectionHeading
              icon={<Clock3 size={16} />}
              title="自动切换"
              index="01"
            />
            <div className="field-grid">
              <SelectField
                label="切换间隔"
                value={String(state.intervalMinutes)}
                onChange={(value) =>
                  updateConfig({ intervalMinutes: Number(value) })
                }
                options={intervalOptions.map((option) => ({
                  value: String(option.value),
                  label: option.label,
                }))}
              />
              <SelectField
                label="显示方式"
                value={state.displayMode}
                onChange={(value) =>
                  updateConfig({ displayMode: value as WallpaperMode })
                }
                options={displayModes}
              />
            </div>
          </section>
          <section className="settings-panel settings-panel--preferences">
            <SectionHeading
              icon={<MonitorCog size={16} />}
              title="偏好设置"
              index="02"
            />
            <ToggleRow
              icon={<Play size={15} />}
              label="开机启动"
              description="登录 Windows 后自动运行"
              checked={state.autoStart}
              onChange={(autoStart) => updateConfig({ autoStart })}
            />
            <ToggleRow
              icon={<Moon size={15} />}
              label="跟随系统主题"
              description="自动使用 Windows 深浅色模式"
              checked={state.followSystemTheme}
              onChange={(followSystemTheme) =>
                updateConfig({ followSystemTheme })
              }
            />
            <label className="shortcut-field">
              <span>
                <Keyboard size={14} /> 全局下一张快捷键
              </span>
              <input
                aria-label="全局下一张快捷键"
                placeholder="例如 Ctrl+Alt+N"
                value={shortcutInput}
                onChange={(event) => setShortcutInput(event.target.value)}
                onBlur={saveShortcut}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <small>
                {state.globalShortcutRegistered || !state.globalNextShortcut
                  ? "默认关闭，保存后立即生效"
                  : "该组合键无法注册，请更换"}
              </small>
            </label>
          </section>
        </div>
      </section>
      <section className="library-section" aria-label="壁纸目录">
        <div className="section-header">
          <div>
            <p className="section-kicker">SOURCE LIBRARY</p>
            <h2>壁纸目录</h2>
            <p className="section-description">
              已发现 {state.availableCount} 张可用图片，目录变动会自动刷新。
            </p>
          </div>
          <div className="section-actions">
            <button
              className="icon-button"
              title="重新扫描目录"
              aria-label="重新扫描目录"
              onClick={() => void run("rescan", () => appApi.rescanFolders())}
            >
              <RefreshCw size={16} />
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void run("folder", () => appApi.addFolder())}
            >
              <Plus size={16} />
              添加目录
            </button>
          </div>
        </div>
        <div className="folder-list">
          {localFolders.length === 0 ? (
            <EmptyFolders />
          ) : (
            localFolders.map((folder, index) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                index={index}
                status={state.folderStatuses[folder.id]}
                onToggle={(enabled) =>
                  void run(`folder-${folder.id}`, () =>
                    appApi.updateFolder({ ...folder, enabled }),
                  )
                }
                onOpen={() =>
                  void run(`open-folder-${folder.id}`, () =>
                    appApi.openFolder(folder.id),
                  )
                }
                onRemove={() =>
                  void run(`remove-${folder.id}`, () =>
                    appApi.removeFolder(folder.id),
                  )
                }
              />
            ))
          )}
        </div>
      </section>
      <SkippedLibrary state={state} run={run} />
    </div>
  );
}

function OnlineDiscoveryView({
  state,
  busy,
  updateConfig,
  run,
  onlineUsage,
}: {
  state: AppState;
  busy: string | null;
  updateConfig: (patch: Partial<AppConfig>) => void;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
  onlineUsage: string;
}) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [visibleImageCount, setVisibleImageCount] = useState(galleryPageSize);
  const filteredImages = useMemo(
    () =>
      state.onlineImages
        .filter(
          (image) => sourceFilter === "all" || image.sourceId === sourceFilter,
        )
        .sort((a, b) =>
          sortOrder === "newest"
            ? Date.parse(b.downloadedAt) - Date.parse(a.downloadedAt)
            : Date.parse(a.downloadedAt) - Date.parse(b.downloadedAt),
        ),
    [state.onlineImages, sourceFilter, sortOrder],
  );
  useEffect(() => {
    setVisibleImageCount(galleryPageSize);
  }, [sourceFilter, sortOrder]);
  const visibleImages = filteredImages.slice(0, visibleImageCount);
  const addSource = () => {
    const url = sourceUrl.trim();
    if (!url) return;
    void run("source-add", () => appApi.addOnlineSource(url));
    setSourceUrl("");
  };
  const deleteImage = async (image: OnlineImage) => {
    const current = state.currentPath === image.localPath;
    const message = current
      ? "删除当前桌面壁纸后，系统会立即切换到下一张。"
      : `删除 ${pathName(image.localPath)}？`;
    if (!window.confirm(message)) return;
    await run(`image-${image.id}`, () => appApi.deleteOnlineImage(image.id));
  };
  const getThumbnail = useCallback(
    (imageId: string) => appApi.getOnlineThumbnail(imageId),
    [],
  );
  const setImageAsWallpaper = (imageId: string) =>
    run(`image-wallpaper-${imageId}`, () =>
      appApi.setOnlineImageAsWallpaper(imageId),
    );

  return (
    <div className="online-view">
      <section className="online-command-bar" aria-label="在线壁纸设置">
        <div className="online-storage-summary">
          <span className="section-kicker">MANAGED STORAGE</span>
          <strong>{onlineUsage} GB</strong>
          <span>达到上限后需要手动清理。</span>
        </div>
        <div className="online-directory-control">
          <span
            className="online-directory-path"
            title={state.onlineDirectory ?? undefined}
          >
            {state.onlineDirectory ?? "正在准备保存位置"}
          </span>
          <button
            className="icon-button"
            type="button"
            title="更改在线壁纸文件夹"
            aria-label="更改在线壁纸文件夹"
            onClick={() =>
              void run("online-directory", () => appApi.selectOnlineDirectory())
            }
            disabled={busy === "online-directory"}
          >
            <FolderOpen size={16} />
          </button>
        </div>
        <div className="online-settings">
          <SelectField
            label="最低分辨率"
            value={String(state.onlineMinimumResolution)}
            onChange={(value) =>
              updateConfig({
                onlineMinimumResolution: Number(value) as 1920 | 2560 | 3840,
              })
            }
            options={[1920, 2560, 3840].map((value) => ({
              value: String(value),
              label: `${value}px`,
            }))}
          />
          <SelectField
            label="目录上限"
            value={String(state.onlineStorageLimitGb)}
            onChange={(value) =>
              updateConfig({
                onlineStorageLimitGb: Number(value) as 1 | 5 | 10 | 20,
              })
            }
            options={[1, 5, 10, 20].map((value) => ({
              value: String(value),
              label: `${value} GB`,
            }))}
          />
        </div>
      </section>
      <section className="online-section" aria-label="在线来源">
        <div className="section-header">
          <div>
            <p className="section-kicker">SOURCES</p>
            <h2>来源</h2>
            <p className="section-description">
              每个来源独立保存抓取状态和间隔。
            </p>
          </div>
        </div>
        <div className="source-add">
          <input
            aria-label="自定义抓取来源"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://example.com/gallery"
          />
          <button
            className="button button--secondary"
            onClick={addSource}
            disabled={busy === "source-add"}
          >
            <Plus size={15} />
            添加来源
          </button>
        </div>
        <div className="source-list">
          {state.onlineSources.map((source) => (
            <OnlineSourceRow
              key={source.id}
              source={source}
              busy={busy}
              onUpdate={(next) =>
                void run(`source-${source.id}`, () =>
                  appApi.updateOnlineSource(next),
                )
              }
              onRun={() =>
                void run(`source-run-${source.id}`, () =>
                  appApi.runOnlineSource(source.id),
                )
              }
              onRemove={() =>
                void run(`source-remove-${source.id}`, () =>
                  appApi.removeOnlineSource(source.id),
                )
              }
            />
          ))}
        </div>
      </section>
      <section className="online-gallery-section" aria-label="已下载图片">
        <div className="section-header gallery-heading">
          <div>
            <p className="section-kicker">CONTACT SHEET</p>
            <h2>
              已下载图片 <span>{filteredImages.length}</span>
            </h2>
            <p className="section-description">
              按下载时间浏览，逐张清理不需要的壁纸。
            </p>
          </div>
          <div className="gallery-controls">
            <SelectField
              label="来源"
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: "all", label: "全部来源" },
                ...state.onlineSources.map((source) => ({
                  value: source.id,
                  label: source.name,
                })),
              ]}
            />
            <SelectField
              label="排序"
              value={sortOrder}
              onChange={(value) => setSortOrder(value as "newest" | "oldest")}
              options={[
                { value: "newest", label: "最新下载" },
                { value: "oldest", label: "最早下载" },
              ]}
            />
          </div>
        </div>
        <OnlineImageGrid
          images={visibleImages}
          sources={state.onlineSources}
          currentPath={state.currentPath}
          getThumbnail={getThumbnail}
          onReveal={(id) =>
            void run(`image-reveal-${id}`, () => appApi.revealOnlineImage(id))
          }
          onSetWallpaper={(id) => void setImageAsWallpaper(id)}
          settingImageId={
            busy?.startsWith("image-wallpaper-")
              ? busy.slice("image-wallpaper-".length)
              : null
          }
          onDelete={deleteImage}
        />
        {visibleImages.length < filteredImages.length && (
          <button
            className="button button--secondary gallery-load-more"
            type="button"
            onClick={() =>
              setVisibleImageCount((count) => count + galleryPageSize)
            }
          >
            加载更多
          </button>
        )}
      </section>
    </div>
  );
}

function CurrentWallpaper({
  state,
  fileName,
  busy,
  onNext,
  onSkip,
  onToggle,
}: {
  state: AppState;
  fileName: string;
  busy: string | null;
  onNext: () => void;
  onSkip: () => void;
  onToggle: () => void;
}) {
  return (
    <section className="current-wallpaper">
      <div className="section-header section-header--preview">
        <div>
          <p className="section-kicker section-kicker--accent">
            <Sparkles size={13} /> CURRENT FRAME
          </p>
          <h2>{fileName}</h2>
        </div>
        <span className="frame-index">SYNC / ALL DISPLAYS</span>
      </div>
      <div
        className={
          state.previewUrl
            ? "preview-frame"
            : "preview-frame preview-frame--empty"
        }
      >
        {state.previewUrl ? (
          <img src={state.previewUrl} alt="当前壁纸预览" />
        ) : (
          <div className="preview-empty-state">
            <ImageIcon size={31} />
            <strong>没有可用壁纸</strong>
            <span>重新扫描目录或恢复跳过图片。</span>
          </div>
        )}
        <span
          className="preview-corner preview-corner--top"
          aria-hidden="true"
        />
        <span
          className="preview-corner preview-corner--bottom"
          aria-hidden="true"
        />
      </div>
      <div className="preview-footer">
        <div className="current-path" title={state.currentPath ?? undefined}>
          <Archive size={15} />
          <span>{state.currentPath ?? "尚未设置当前壁纸"}</span>
        </div>
        <div className="preview-actions">
          <button
            className="button button--secondary"
            onClick={onSkip}
            disabled={!state.currentPath || busy === "skip"}
          >
            <SkipForward size={15} />
            跳过
          </button>
          <button
            className="button button--secondary"
            onClick={onToggle}
            disabled={busy === "pause"}
          >
            {state.paused ? <Play size={15} /> : <Pause size={15} />}
            {state.paused ? "恢复切换" : "暂停切换"}
          </button>
          <button
            className="button button--primary"
            onClick={onNext}
            disabled={
              state.paused || state.availableCount === 0 || busy === "next"
            }
          >
            <Sparkles size={15} />
            下一张
          </button>
        </div>
      </div>
    </section>
  );
}
function SectionHeading({
  icon,
  title,
  index,
}: {
  icon: ReactNode;
  title: string;
  index: string;
}) {
  return (
    <h2 className="section-title">
      <span className="section-title-icon">{icon}</span>
      <span>{title}</span>
      <small>{index}</small>
    </h2>
  );
}
function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <div className="select-wrap">
        <select
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </div>
    </label>
  );
}
function ToggleRow({
  icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <span className="row-icon">{icon}</span>
      <div className="row-copy">
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <button
        className={checked ? "switch switch--on" : "switch"}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
function FolderRow({
  folder,
  index,
  status,
  onToggle,
  onOpen,
  onRemove,
}: {
  folder: WallpaperFolder;
  index: number;
  status: AppState["folderStatuses"][string] | undefined;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const label = !folder.enabled
    ? "已停用"
    : status?.kind === "unavailable"
      ? "路径不可访问"
      : status?.kind === "empty"
        ? "无可用图片"
        : `${status?.availableCount ?? 0} 张可用`;
  return (
    <div
      className={
        folder.enabled ? "folder-row" : "folder-row folder-row--disabled"
      }
    >
      <span className="folder-index">{String(index + 1).padStart(2, "0")}</span>
      <span className="folder-icon">
        <FolderOpen size={18} />
      </span>
      <div className="folder-copy">
        <strong>{folder.path.split(/[/\\]/).pop()}</strong>
        <span title={folder.path}>{folder.path}</span>
      </div>
      <span className="folder-state">
        {status?.invalidCount ? `含 ${status.invalidCount} 张无效` : label}
      </span>
      <button
        className="icon-button"
        title="在资源管理器中打开"
        aria-label={`在资源管理器中打开 ${folder.path}`}
        onClick={onOpen}
      >
        <FolderOpen size={16} />
      </button>
      <button
        className={folder.enabled ? "switch switch--on" : "switch"}
        type="button"
        role="switch"
        aria-checked={folder.enabled}
        aria-label={`启用 ${folder.path}`}
        onClick={() => onToggle(!folder.enabled)}
      >
        <span />
      </button>
      <button
        className="icon-button icon-button--danger"
        title="移除目录"
        aria-label={`移除目录 ${folder.path}`}
        onClick={onRemove}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
function OnlineSourceRow({
  source,
  busy,
  onUpdate,
  onRun,
  onRemove,
}: {
  source: OnlineSource;
  busy: string | null;
  onUpdate: (source: OnlineSource) => void;
  onRun: () => void;
  onRemove: () => void;
}) {
  const running = busy === `source-run-${source.id}`;
  const nextRun = source.nextRunAt
    ? new Date(source.nextRunAt).toLocaleString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        month: "numeric",
        day: "numeric",
      })
    : "等待安排";
  const categoryStatuses = source.categoryStatuses ?? [];
  const failedCategoryCount = categoryStatuses.filter(
    (status) => status.lastError,
  ).length;
  const categoryDiscovered = categoryStatuses.reduce(
    (total, status) => total + status.discovered,
    0,
  );
  const categoryDownloaded = categoryStatuses.reduce(
    (total, status) => total + status.downloaded,
    0,
  );
  return (
    <div className="source-row">
      <span className="folder-icon">
        <Globe2 size={18} />
      </span>
      <div className="folder-copy">
        <strong>{source.name}</strong>
        <span title={source.url}>{source.url}</span>
        <small>
          {source.lastRunAt
            ? `上次发现 ${source.lastDiscovered}，下载 ${source.lastDownloaded}`
            : "等待首次抓取"}
          {source.lastError ? ` · 异常：${source.lastError}` : ""} · 下次{" "}
          {nextRun}
        </small>
        {categoryStatuses.length > 0 && (
          <details className="source-category-details">
            <summary>
              分类请求 {categoryStatuses.length} 个 · 发现 {categoryDiscovered}{" "}
              · 下载 {categoryDownloaded}
              {failedCategoryCount ? ` · 异常 ${failedCategoryCount}` : ""}
            </summary>
            <div className="source-category-statuses">
              {categoryStatuses.map((status) => (
                <span
                  className={
                    status.lastError
                      ? "source-category-status source-category-status--error"
                      : "source-category-status"
                  }
                  key={status.key}
                  title={
                    status.lastError ??
                    `${status.label}：发现 ${status.discovered}，下载 ${status.downloaded}`
                  }
                >
                  {status.label}{" "}
                  {status.lastError
                    ? "失败"
                    : `发${status.discovered} 下${status.downloaded}`}
                </span>
              ))}
            </div>
          </details>
        )}
      </div>
      <SelectField
        label="抓取间隔"
        value={String(source.intervalHours)}
        onChange={(value) =>
          onUpdate({
            ...source,
            intervalHours: Number(value) as OnlineSource["intervalHours"],
          })
        }
        options={onlineIntervals.map((value) => ({
          value: String(value),
          label: `${value} 小时`,
        }))}
      />
      <button
        className={source.enabled ? "switch switch--on" : "switch"}
        aria-label={`启用 ${source.name}`}
        onClick={() => onUpdate({ ...source, enabled: !source.enabled })}
      >
        <span />
      </button>
      <button
        className="icon-button"
        title="立即抓取"
        aria-label={`立即抓取 ${source.name}`}
        onClick={onRun}
        disabled={running}
      >
        {running ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Download size={16} />
        )}
      </button>
      {source.kind === "custom" && (
        <button
          className="icon-button icon-button--danger"
          title="删除来源"
          aria-label={`删除来源 ${source.name}`}
          onClick={onRemove}
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
}

function OnlineImageGrid({
  images,
  sources,
  currentPath,
  getThumbnail,
  onReveal,
  onSetWallpaper,
  settingImageId,
  onDelete,
}: {
  images: OnlineImage[];
  sources: OnlineSource[];
  currentPath: string | null;
  getThumbnail: (id: string) => Promise<string | null>;
  onReveal: (id: string) => void;
  onSetWallpaper: (id: string) => void;
  settingImageId: string | null;
  onDelete: (image: OnlineImage) => Promise<void>;
}) {
  if (!images.length)
    return <p className="empty-copy">还没有符合筛选条件的在线壁纸。</p>;
  return (
    <div className="online-image-grid">
      {images.map((image) => (
        <OnlineImageCard
          key={image.id}
          image={image}
          source={sources.find((source) => source.id === image.sourceId)}
          current={currentPath === image.localPath}
          getThumbnail={getThumbnail}
          onReveal={onReveal}
          onSetWallpaper={onSetWallpaper}
          setting={settingImageId === image.id}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
function LazyThumbnail({
  thumbnailKey,
  filePath,
  getThumbnail,
  badge,
}: {
  thumbnailKey: string;
  filePath: string;
  getThumbnail: (key: string) => Promise<string | null>;
  badge?: ReactNode;
}) {
  const thumbnailRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    const element = thumbnailRef.current;
    if (!element || shouldLoad) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "360px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shouldLoad]);
  useEffect(() => {
    if (!shouldLoad) return;
    let active = true;
    setThumbnail(undefined);
    void getThumbnail(thumbnailKey)
      .then((value) => {
        if (active) setThumbnail(value);
      })
      .catch(() => {
        if (active) setThumbnail(null);
      });
    return () => {
      active = false;
    };
  }, [getThumbnail, shouldLoad, thumbnailKey]);
  return (
    <div className="online-thumbnail" ref={thumbnailRef}>
      {!shouldLoad ? null : thumbnail === undefined ? (
        <LoaderCircle className="spin" size={20} />
      ) : thumbnail ? (
        <img src={thumbnail} alt={pathName(filePath)} />
      ) : (
        <span className="thumbnail-unavailable">
          <ImageIcon size={22} />
          文件不可读取
        </span>
      )}
      {badge}
    </div>
  );
}
function OnlineImageCard({
  image,
  source,
  current,
  getThumbnail,
  onReveal,
  onSetWallpaper,
  setting,
  onDelete,
}: {
  image: OnlineImage;
  source: OnlineSource | undefined;
  current: boolean;
  getThumbnail: (id: string) => Promise<string | null>;
  onReveal: (id: string) => void;
  onSetWallpaper: (id: string) => void;
  setting: boolean;
  onDelete: (image: OnlineImage) => Promise<void>;
}) {
  return (
    <article
      className={
        current
          ? "online-image-card online-image-card--current"
          : "online-image-card"
      }
    >
      <LazyThumbnail
        thumbnailKey={image.id}
        filePath={image.localPath}
        getThumbnail={getThumbnail}
        badge={
          current ? (
            <span className="current-image-badge">当前桌面</span>
          ) : undefined
        }
      />
      <div className="online-image-card-copy">
        <strong title={pathName(image.localPath)}>
          {pathName(image.localPath)}
        </strong>
        <span>
          {source?.name ?? "已删除来源"} · {image.width}×{image.height}
        </span>
        <small>{new Date(image.downloadedAt).toLocaleString("zh-CN")}</small>
      </div>
      <div className="online-image-actions">
        <a
          className="icon-button"
          href={image.sourcePageUrl}
          target="_blank"
          rel="noreferrer"
          title="打开来源页"
          aria-label={`打开来源页 ${pathName(image.localPath)}`}
        >
          <ExternalLink size={15} />
        </a>
        <button
          className="icon-button"
          title="在文件夹中显示"
          aria-label={`在文件夹中显示 ${pathName(image.localPath)}`}
          onClick={() => onReveal(image.id)}
        >
          <FolderOpen size={15} />
        </button>
        <button
          className="icon-button"
          title="设为壁纸"
          aria-label={`设为壁纸 ${pathName(image.localPath)}`}
          onClick={() => onSetWallpaper(image.id)}
          disabled={setting}
        >
          <MonitorUp size={15} />
        </button>
        <button
          className="icon-button icon-button--danger"
          title="删除图片"
          aria-label={`删除图片 ${pathName(image.localPath)}`}
          onClick={() => void onDelete(image)}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}
function SkippedLibrary({
  state,
  run,
}: {
  state: AppState;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
}) {
  const getThumbnail = useCallback(
    (filePath: string) => appApi.getSkippedThumbnail(filePath),
    [],
  );
  const [visibleImageCount, setVisibleImageCount] = useState(galleryPageSize);
  const visiblePaths = state.skippedPaths.slice(0, visibleImageCount);
  const deleteImage = async (filePath: string) => {
    if (!window.confirm(`删除 ${pathName(filePath)}？`)) return;
    await run(`delete-skipped-${filePath}`, () =>
      appApi.deleteSkippedPath(filePath),
    );
  };
  return (
    <section className="library-section" aria-label="已跳过图片">
      <div className="section-header">
        <div>
          <p className="section-kicker">SKIPPED IMAGES</p>
          <h2>已跳过图片</h2>
          <p className="section-description">
            跳过状态会跨重启保留；可恢复使用或直接删除文件。
          </p>
        </div>
        {state.skippedPaths.length > 0 && (
          <button
            className="button button--secondary"
            onClick={() =>
              void run("restore-all", () => appApi.restoreAllSkipped())
            }
          >
            <RotateCcw size={15} />
            全部恢复
          </button>
        )}
      </div>
      {state.skippedPaths.length ? (
        <div className="skipped-image-grid">
          {visiblePaths.map((filePath) => (
            <SkippedImageCard
              key={filePath}
              filePath={filePath}
              getThumbnail={getThumbnail}
              onRestore={() =>
                void run(`restore-${filePath}`, () =>
                  appApi.restoreSkippedPath(filePath),
                )
              }
              onDelete={() => void deleteImage(filePath)}
            />
          ))}
        </div>
      ) : (
        <p className="empty-copy">还没有跳过的图片。</p>
      )}
      {visiblePaths.length < state.skippedPaths.length && (
        <button
          className="button button--secondary gallery-load-more"
          type="button"
          onClick={() =>
            setVisibleImageCount((count) => count + galleryPageSize)
          }
        >
          加载更多
        </button>
      )}
    </section>
  );
}
function SkippedImageCard({
  filePath,
  getThumbnail,
  onRestore,
  onDelete,
}: {
  filePath: string;
  getThumbnail: (filePath: string) => Promise<string | null>;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="online-image-card skipped-image-card">
      <LazyThumbnail
        thumbnailKey={filePath}
        filePath={filePath}
        getThumbnail={getThumbnail}
      />
      <div className="online-image-card-copy">
        <strong title={pathName(filePath)}>{pathName(filePath)}</strong>
        <span title={filePath}>{parentPath(filePath)}</span>
        <small>已跳过</small>
      </div>
      <div className="online-image-actions">
        <button
          className="icon-button"
          title="恢复图片"
          aria-label={`恢复图片 ${filePath}`}
          onClick={onRestore}
        >
          <RotateCcw size={15} />
        </button>
        <button
          className="icon-button icon-button--danger"
          title="删除图片"
          aria-label={`删除图片 ${filePath}`}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}
function EmptyFolders() {
  return (
    <div className="empty-folders">
      <span className="empty-folder-icon">
        <FolderOpen size={21} />
      </span>
      <div>
        <strong>还没有壁纸目录</strong>
        <span>添加一个包含图片的本地文件夹后，即可开始自动切换。</span>
      </div>
    </div>
  );
}
function LoadingScreen() {
  return (
    <div className="loading-screen">
      <LoaderCircle className="spin" size={22} />
      <span>正在加载 ZX Wallpaper</span>
    </div>
  );
}
function pathName(filePath: string) {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}
function parentPath(filePath: string) {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash < 0 ? filePath : filePath.slice(0, slash);
}

function createBrowserPreviewApi(): DesktopApi {
  const onlineSource: OnlineSource = {
    id: "wallhaven-sfw",
    name: "Wallhaven SFW",
    kind: "builtin",
    url: "https://wallhaven.cc/api/v1/search?purity=100",
    enabled: true,
    intervalHours: 24,
    lastRunAt: null,
    nextRunAt: null,
    lastDiscovered: 0,
    lastDownloaded: 0,
    lastError: null,
  };
  let state: AppState = {
    folders: [
      {
        id: "demo-scenic",
        path: "D:\\Pictures\\Wallpapers\\Scenic",
        enabled: true,
      },
      {
        id: "online-library",
        path: "D:\\Pictures\\ZX Wallpaper\\Online",
        enabled: true,
      },
    ],
    intervalMinutes: 30,
    displayMode: "fill",
    autoStart: true,
    paused: false,
    followSystemTheme: true,
    currentPath: "D:\\Pictures\\Wallpapers\\Scenic\\mist-over-the-ridge.jpg",
    remainingPaths: [],
    skippedPaths: [],
    globalNextShortcut: null,
    lastSwitchAt: null,
    onlineSources: [onlineSource],
    onlineImages: [],
    onlineDirectory: "D:\\Pictures\\ZX Wallpaper\\Online",
    onlineStorageLimitGb: 5,
    onlineMinimumResolution: 1920,
    availableCount: 128,
    previewUrl: demoPreviewUrl,
    folderStatuses: {
      "demo-scenic": {
        kind: "available",
        availableCount: 110,
        invalidCount: 0,
        scannedAt: new Date().toISOString(),
      },
      "online-library": {
        kind: "available",
        availableCount: 18,
        invalidCount: 0,
        scannedAt: new Date().toISOString(),
      },
    },
    onlineStorageBytes: 1.2 * 1024 ** 3,
    globalShortcutRegistered: false,
  };
  const listeners = new Set<(next: AppState) => void>();
  const emit = () => listeners.forEach((listener) => listener(state));
  const update = (patch: Partial<AppConfig>) => {
    state = { ...state, ...patch };
    emit();
    return Promise.resolve();
  };
  return {
    getState: () => Promise.resolve(state),
    updateConfig: update,
    addFolder: () =>
      update({
        folders: [
          ...state.folders,
          {
            id: `demo-${Date.now()}`,
            path: "D:\\Pictures\\Wallpapers\\New folder",
            enabled: true,
          },
        ],
      }),
    removeFolder: (id) =>
      update({ folders: state.folders.filter((folder) => folder.id !== id) }),
    updateFolder: (folder) =>
      update({
        folders: state.folders.map((item) =>
          item.id === folder.id ? folder : item,
        ),
      }),
    openFolder: () => Promise.resolve(),
    rescanFolders: () => Promise.resolve(),
    nextWallpaper: () =>
      update({
        currentPath: "D:\\Pictures\\Wallpapers\\Archive\\blue-hour.jpg",
      }),
    skipCurrentWallpaper: () =>
      update({
        skippedPaths: state.currentPath
          ? [...state.skippedPaths, state.currentPath]
          : [],
        currentPath: "D:\\Pictures\\Wallpapers\\Archive\\blue-hour.jpg",
      }),
    restoreSkippedPath: (filePath) =>
      update({
        skippedPaths: state.skippedPaths.filter((item) => item !== filePath),
      }),
    restoreAllSkipped: () => update({ skippedPaths: [] }),
    deleteSkippedPath: (filePath) =>
      update({
        skippedPaths: state.skippedPaths.filter((item) => item !== filePath),
      }),
    togglePaused: () => update({ paused: !state.paused }),
    addOnlineSource: (url) =>
      update({
        onlineSources: [
          ...state.onlineSources,
          {
            id: `source-${Date.now()}`,
            name: new URL(url).hostname,
            kind: "custom",
            url,
            enabled: true,
            intervalHours: 24,
            lastRunAt: null,
            nextRunAt: null,
            lastDiscovered: 0,
            lastDownloaded: 0,
            lastError: null,
          },
        ],
      }),
    updateOnlineSource: (source) =>
      update({
        onlineSources: state.onlineSources.map((item) =>
          item.id === source.id
            ? {
                ...source,
                nextRunAt: source.enabled
                  ? new Date(
                      Date.now() + source.intervalHours * 3_600_000,
                    ).toISOString()
                  : null,
              }
            : item,
        ),
      }),
    removeOnlineSource: (id) =>
      update({
        onlineSources: state.onlineSources.filter((source) => source.id !== id),
      }),
    runOnlineSource: () => Promise.resolve(),
    setOnlineImageAsWallpaper: (id) => {
      const image = state.onlineImages.find((item) => item.id === id);
      return image
        ? update({
            currentPath: image.localPath,
            paused: true,
            lastSwitchAt: new Date().toISOString(),
            remainingPaths: state.remainingPaths.filter(
              (item) => item !== image.localPath,
            ),
          })
        : Promise.resolve();
    },
    deleteOnlineImage: (id) =>
      update({
        onlineImages: state.onlineImages.filter((image) => image.id !== id),
      }),
    selectOnlineDirectory: () =>
      update({
        onlineDirectory: "D:\\Pictures\\ZX Wallpaper Library",
        folders: state.folders.map((folder) =>
          folder.id === "online-library"
            ? { ...folder, path: "D:\\Pictures\\ZX Wallpaper Library" }
            : folder,
        ),
      }),
    revealOnlineImage: () => Promise.resolve(),
    getOnlineThumbnail: () => Promise.resolve(demoPreviewUrl),
    getSkippedThumbnail: () => Promise.resolve(demoPreviewUrl),
    onStateChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
