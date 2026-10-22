import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import FloatingWidget from "./FloatingWidget";
import type { AppState, DesktopRuntime } from "../runtime/types";

afterEach(cleanup);

// 拖拽路径会调用 setPointerCapture，测试环境补一个空实现。
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}

describe("floating widget pause and skip actions", () => {
  it("shows the pause action while auto switching is running and calls togglePaused", async () => {
    const user = userEvent.setup();
    const runtime = createWidgetRuntime(createWidgetState());
    const togglePaused = vi.fn(() => runtime.getState());
    runtime.togglePaused = togglePaused;
    render(<FloatingWidget runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "暂停切换" }));

    expect(togglePaused).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "恢复切换" })).toBeNull();
  });

  it("shows the resume action while paused and calls togglePaused", async () => {
    const user = userEvent.setup();
    const runtime = createWidgetRuntime(createWidgetState({ paused: true }));
    const togglePaused = vi.fn(() => runtime.getState());
    runtime.togglePaused = togglePaused;
    render(<FloatingWidget runtime={runtime} />);

    expect(await screen.findByText("自动切换已暂停")).toBeTruthy();
    const resumeButton = screen.getByRole("button", { name: "恢复切换" });
    await user.click(resumeButton);

    expect(togglePaused).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "暂停切换" })).toBeNull();
  });

  it("skips the current wallpaper immediately without a confirmation step", async () => {
    const user = userEvent.setup();
    const runtime = createWidgetRuntime(
      createWidgetState({
        currentPath: "D:\\Wallpapers\\current.jpg",
        wallpaperHistory: ["D:\\Wallpapers\\current.jpg"],
      }),
    );
    const skipCurrentWallpaper = vi.fn(() => runtime.getState());
    runtime.skipCurrentWallpaper = skipCurrentWallpaper;
    render(<FloatingWidget runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "跳过当前壁纸" }));

    expect(skipCurrentWallpaper).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the skip failure message inline without a system dialog", async () => {
    const user = userEvent.setup();
    const runtime = createWidgetRuntime(
      createWidgetState({
        currentPath: "D:\\Wallpapers\\current.jpg",
        wallpaperHistory: ["D:\\Wallpapers\\current.jpg"],
      }),
    );
    runtime.skipCurrentWallpaper = vi.fn(() =>
      Promise.reject(new Error("跳过失败：文件不可访问")),
    );
    render(<FloatingWidget runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "跳过当前壁纸" }));

    expect(await screen.findByText("跳过失败：文件不可访问")).toBeTruthy();
  });

  it("disables skip without a current wallpaper while pause stays available", async () => {
    const user = userEvent.setup();
    const runtime = createWidgetRuntime(createWidgetState({ currentPath: null }));
    const skipCurrentWallpaper = vi.fn(() => runtime.getState());
    runtime.skipCurrentWallpaper = skipCurrentWallpaper;
    render(<FloatingWidget runtime={runtime} />);

    const skipButton = await screen.findByRole("button", { name: "跳过当前壁纸" });
    expect(skipButton.hasAttribute("disabled")).toBe(true);

    await user.click(skipButton);
    expect(skipCurrentWallpaper).not.toHaveBeenCalled();

    const pauseButton = screen.getByRole("button", { name: "暂停切换" });
    expect(pauseButton.hasAttribute("disabled")).toBe(false);
  });

  it("persists the drop position through set_widget_layout after a free drag", () => {
    Object.defineProperty(window.screen, "width", { configurable: true, value: 1024 });
    const state = createWidgetState();
    const runtime = createWidgetRuntime(state);
    const setWidgetLayout = vi.fn(() => Promise.resolve(state));
    runtime.setWidgetLayout = setWidgetLayout;
    render(<FloatingWidget runtime={runtime} />);

    const strip = screen.getByRole("button", { name: /壁纸速控浮窗：按住拖动/ });
    fireEvent.pointerDown(strip, { pointerId: 1, button: 0, screenX: 120, screenY: 120 });
    fireEvent.pointerMove(strip, { pointerId: 1, screenX: 180, screenY: 140 });
    fireEvent.pointerUp(strip, { pointerId: 1, screenX: 180, screenY: 140 });

    // 光标偏移被换算成窗口左上角的全局逻辑坐标。
    expect(setWidgetLayout).toHaveBeenCalledWith({ docked: null, x: 60, y: 20 });
  });
});

function createWidgetState(overrides: Partial<AppState> = {}): AppState {
  return {
    folders: [],
    intervalMinutes: 30,
    displayMode: "fill",
    rotationOrder: "random",
    autoStart: false,
    paused: false,
    followSystemTheme: true,
    hideToTrayOnClose: true,
    currentPath: null,
    remainingPaths: [],
    skippedPaths: [],
    favoritePaths: [],
    wallpaperHistory: [],
    globalNextShortcut: null,
    globalSkipShortcut: null,
    lastSwitchAt: null,
    onlineSources: [],
    onlineImages: [],
    excludedImageUrls: [],
    onlineSyncLogs: [],
    onlineDirectory: null,
    onlineStorageLimitGb: 5,
    onlineMinimumResolution: 1920,
    widgetLayout: { docked: "right", x: null, y: null },
    imageTags: [],
    taggingEnabled: false,
    availableCount: 0,
    previewUrl: null,
    previewItems: [],
    folderStatuses: {},
    libraryImages: [],
    onlineStorageBytes: 0,
    globalShortcutRegistered: false,
    shortcutStatus: { state: "disabled" },
    skipShortcutStatus: { state: "disabled" },
    ...overrides,
  };
}

function createWidgetRuntime(state: AppState): DesktopRuntime {
  const unchanged = () => Promise.resolve(state);
  return {
    getState: unchanged,
    updateConfig: unchanged,
    addFolder: unchanged,
    removeFolder: unchanged,
    updateFolder: unchanged,
    openFolder: unchanged,
    rescanFolders: unchanged,
    nextWallpaper: unchanged,
    selectWallpaper: unchanged,
    getImageAsset: vi.fn(() => Promise.resolve(null)),
    prewarmImageAssets: vi.fn(() => Promise.resolve()),
    skipCurrentWallpaper: unchanged,
    toggleFavorite: unchanged,
    restoreSkippedPath: unchanged,
    restoreAllSkipped: unchanged,
    deleteSkippedPath: unchanged,
    deleteAllSkipped: unchanged,
    togglePaused: unchanged,
    batchSkipPaths: unchanged,
    batchRestoreSkipped: unchanged,
    batchFavorite: unchanged,
    batchDeletePaths: unchanged,
    updateOnlineSource: unchanged,
    runOnlineSource: unchanged,
    runUpx8Category: unchanged,
    setOnlineImageAsWallpaper: unchanged,
    deleteOnlineImage: unchanged,
    clearExcludedImageUrls: unchanged,
    removeExcludedImageUrl: unchanged,
    selectOnlineDirectory: unchanged,
    revealOnlineImage: unchanged,
    revealWallpaper: () => Promise.resolve(),
    getWidgetLayout: () => Promise.resolve({ docked: "right", x: null, y: null }),
    setWidgetLayout: unchanged,
    setTaggingEnabled: unchanged,
    getTaggingStatus: () => Promise.resolve({ enabled: false, modelReady: false, downloading: null, pending: 0 }),
    rescanTags: unchanged,
    onStateChanged: () => Promise.resolve(() => {}),
  };
}
