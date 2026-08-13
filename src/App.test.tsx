import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AppState, DesktopRuntime } from "./runtime/types";

afterEach(cleanup);

describe("ZX Wallpaper application shell", () => {
  it("navigates through the four prototype views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "工作台" });
    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByRole("heading", { name: "设置" })).toBeTruthy();
    expect(screen.getByText("自动切换")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "实验室" }));
    expect(screen.getByRole("heading", { name: "后置实验性功能" })).toBeTruthy();
  });

  it("renders the initial state without waiting for the state-event subscription", async () => {
    const runtime = createOnlineGalleryRuntime(0);
    runtime.onStateChanged = () => new Promise<() => void>(() => {});
    render(<App runtime={runtime} />);

    expect(await screen.findByRole("button", { name: "工作台" })).toBeTruthy();
  });

  it("updates the rendered runtime state when automatic switching is paused", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "暂停切换" });
    await user.click(screen.getByRole("button", { name: "暂停切换" }));

    expect((await screen.findAllByText("已暂停")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "恢复切换" })).toBeTruthy();
  });

  it("selects a wallpaper from the preview strip", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const selectWallpaper = vi.fn(() => runtime.getState());
    runtime.selectWallpaper = selectWallpaper;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "切换到 next.jpg" }));

    expect(selectWallpaper).toHaveBeenCalledWith("D:\\Wallpapers\\next.jpg");
  });

  it("toggles the current wallpaper as liked", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      currentPath: "D:\\Wallpapers\\current.jpg",
    });
    const toggleFavorite = vi.fn(() => runtime.getState());
    runtime.toggleFavorite = toggleFavorite;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "喜欢 current.jpg" }));

    expect(toggleFavorite).toHaveBeenCalledWith("D:\\Wallpapers\\current.jpg");
  });

  it("upgrades the current preview from a grid asset to a hero asset", async () => {
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      currentPath: "D:\\Wallpapers\\current.jpg",
    });
    runtime.getImageAsset = vi.fn((filePath, kind) => Promise.resolve({
      src: `http://wallpaper-asset.localhost/${kind}-${filePath.split(/[/\\\\]/).pop()}`,
      width: kind === "hero" ? 1600 : 768,
      height: kind === "hero" ? 900 : 432,
      status: "ready" as const,
    }));
    render(<App runtime={runtime} />);

    await waitFor(() => {
      expect((screen.getByAltText("当前壁纸预览") as HTMLImageElement).src).toContain(
        "hero-current.jpg",
      );
    });
    expect(runtime.getImageAsset).toHaveBeenCalledWith("D:\\Wallpapers\\current.jpg", "grid");
    expect(runtime.getImageAsset).toHaveBeenCalledWith("D:\\Wallpapers\\current.jpg", "hero");
  });

  it("requests an original asset only after opening the image viewer", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({ ...(await getState()), currentPath: "D:\\Wallpapers\\current.jpg" });
    const getImageAsset = vi.fn(() => Promise.resolve({ src: "http://wallpaper-asset.localhost/image", width: 768, height: 432, status: "ready" as const }));
    runtime.getImageAsset = getImageAsset;
    render(<App runtime={runtime} />);

    await screen.findByRole("button", { name: "查看原图 current.jpg" });
    expect(getImageAsset).not.toHaveBeenCalledWith("D:\\Wallpapers\\current.jpg", "original");
    await user.click(screen.getByRole("button", { name: "查看原图 current.jpg" }));

    await waitFor(() => expect(getImageAsset).toHaveBeenCalledWith("D:\\Wallpapers\\current.jpg", "original"));
  });

  it("shows UPX8 as the only online wallpaper source", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "在线发现" });
    await user.click(screen.getByRole("button", { name: "在线发现" }));

    expect(await screen.findByText("UPX8 综合壁纸 4K", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText("添加自定义 HTTPS 单页来源")).toBeNull();
  });

  it("updates an online source polling interval", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));
    const interval = screen.getByLabelText("抓取间隔 UPX8 综合壁纸 4K");
    await user.selectOptions(interval, "6");

    expect((interval as HTMLSelectElement).value).toBe("6");
  });

  it("persists the requested rotation order from settings", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const updateConfig = vi.fn(() => runtime.getState());
    runtime.updateConfig = updateConfig;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "顺序" }));

    expect(updateConfig).toHaveBeenCalledWith({ rotationOrder: "sequential" });
  });

  it("shows the concrete global shortcut registration error", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      shortcutStatus: { state: "error", shortcut: "Ctrl+Alt+N", message: "该快捷键已被其他应用占用。" },
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(screen.getByText("该快捷键已被其他应用占用。")).toBeTruthy();
  });

  it("syncs an individual UPX8 category", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const runUpx8Category = vi.fn(() => runtime.getState());
    runtime.runUpx8Category = runUpx8Category;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));
    await user.click(screen.getByRole("button", { name: "同步分类 风景" }));

    expect(runUpx8Category).toHaveBeenCalledWith("nature");
  });

  it("shows the request parameters and returned URLs for an online sync", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      onlineSyncLogs: [{
        id: "sync-nature",
        sourceId: "upx8-4k",
        categoryKey: "nature",
        categoryLabel: "风景",
        requestUrl: "https://wp.upx8.com/api.php?format=json&category=nature&resolution=1920x1080&count=10",
        format: "json",
        resolution: "1920x1080",
        count: 10,
        startedAt: "2026-08-11T02:40:00Z",
        finishedAt: "2026-08-11T02:40:01Z",
        durationMs: 1000,
        status: "success",
        responseStatus: 200,
        discovered: 1,
        downloaded: 1,
        skipped: 0,
        responseImageUrls: ["https://cdn.example.test/nature.jpg"],
        errors: ["响应 Content-Type 不是图片类型。"],
        downloadFailures: [{
          imageUrl: "https://cdn.example.test/not-an-image.jpg",
          resolvedUrl: "https://cdn.example.test/not-an-image.jpg",
          responseStatus: 200,
          contentType: "text/html",
          reason: "响应 Content-Type 不是图片类型。",
        }],
      }],
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));

    expect(screen.queryByText("HTTP 200")).toBeNull();
    await user.click(screen.getByRole("button", { name: "查看风景同步详情" }));
    expect(screen.getByText("HTTP 200")).toBeTruthy();
    expect(screen.getByText("category=nature")).toBeTruthy();
    expect(screen.getByText("https://cdn.example.test/not-an-image.jpg")).toBeTruthy();
    expect(screen.getByText("HTTP 200 · Content-Type text/html")).toBeTruthy();
    await user.click(screen.getByText("返回 URL (1)"));
    expect(screen.getByText("https://cdn.example.test/nature.jpg")).toBeTruthy();
  });

  it("reports wallpaper progress and prevents a concurrent online-image action", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(1);
    let finishWallpaperChange: (() => void) | undefined;
    const setOnlineImageAsWallpaper = vi.fn(() => new Promise<AppState>((resolve) => {
      finishWallpaperChange = () => void runtime.getState().then(resolve);
    }));
    const deleteOnlineImage = vi.fn(() => runtime.getState());
    runtime.setOnlineImageAsWallpaper = setOnlineImageAsWallpaper;
    runtime.deleteOnlineImage = deleteOnlineImage;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));
    await user.click(screen.getByRole("button", { name: "设为壁纸" }));

    expect((await screen.findByRole("status")).textContent).toContain("正在设置壁纸并同步所有显示器");
    expect(screen.getByRole("button", { name: "删除 online-01.jpg" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: "删除 online-01.jpg" }));
    expect(deleteOnlineImage).not.toHaveBeenCalled();

    finishWallpaperChange?.();
    expect((await screen.findByRole("status")).textContent).toContain("已设为壁纸，所有显示器已同步");
  });

  it("toggles an online wallpaper as liked", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(1);
    const toggleFavorite = vi.fn(() => runtime.getState());
    runtime.toggleFavorite = toggleFavorite;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));
    await user.click(screen.getByRole("button", { name: "喜欢 online-01.jpg" }));

    expect(toggleFavorite).toHaveBeenCalledWith("D:\\ZX Wallpaper\\Online\\online-01.jpg");
  });

  it("lists liked online wallpapers in the favorites view", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(1);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      favoritePaths: ["D:\\ZX Wallpaper\\Online\\online-01.jpg"],
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "我的喜欢" }));

    expect(screen.getByRole("heading", { name: "我的喜欢" })).toBeTruthy();
    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消喜欢 online-01.jpg" })).toBeTruthy();
  });

  it("dismisses a successful operation status after the feedback window", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(0)} />);

    await user.click(await screen.findByRole("button", { name: "暂停切换" }));
    expect((await screen.findByRole("status")).textContent).toContain("操作已完成");

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 4_000 });
  });

  it("manually refreshes the downloaded online-image list", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(1);
    const rescanFolders = vi.fn(() => runtime.getState());
    runtime.rescanFolders = rescanFolders;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));
    await user.click(screen.getByRole("button", { name: "刷新已下载图片" }));

    expect(rescanFolders).toHaveBeenCalledOnce();
    expect((await screen.findByRole("status")).textContent).toContain("已刷新图片列表");
  });

  it("loads the next online image batch when the gallery end enters the viewport", async () => {
    const observers: MockIntersectionObserver[] = [];
    vi.stubGlobal("IntersectionObserver", class MockIntersectionObserver {
      readonly elements: Element[] = [];
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(element: Element) { this.elements.push(element); }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    });

    try {
      const user = userEvent.setup();
      render(<App runtime={createOnlineGalleryRuntime(25)} />);

      await user.click(await screen.findByRole("button", { name: "在线发现" }));

      expect(screen.getByText("online-01.jpg")).toBeTruthy();
      expect(screen.queryByText("online-25.jpg")).toBeNull();

      const loadMore = screen.getByLabelText("加载更多在线图片");
      const observer = observers.find((candidate) => candidate.elements.includes(loadMore));
      expect(observer).toBeTruthy();
      observer?.callback(
        [{ isIntersecting: true, target: loadMore } as unknown as IntersectionObserverEntry],
        observer,
      );

      expect(await screen.findByText("online-25.jpg")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prewarms the visible online images and the next batch", async () => {
    const user = userEvent.setup();
    const prewarmImageAssets = vi.fn(() => Promise.resolve());
    render(<App runtime={createOnlineGalleryRuntime(50, undefined, prewarmImageAssets)} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));

    await waitFor(() => expect(prewarmImageAssets).toHaveBeenCalledWith(
      Array.from({ length: 48 }, (_, index) => `D:\\ZX Wallpaper\\Online\\online-${String(index + 1).padStart(2, "0")}.jpg`),
      "grid",
    ));
  });

  it("requests online grid assets only after their cards enter the viewport", async () => {
    const observers: MockIntersectionObserver[] = [];
    const getImageAsset = vi.fn(() => Promise.resolve({ src: "http://wallpaper-asset.localhost/thumbnail", width: 768, height: 432, status: "ready" as const }));
    vi.stubGlobal("IntersectionObserver", class MockIntersectionObserver {
      readonly elements: Element[] = [];
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(element: Element) { this.elements.push(element); }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    });

    try {
      const user = userEvent.setup();
      render(<App runtime={createOnlineGalleryRuntime(25, getImageAsset)} />);
      await user.click(await screen.findByRole("button", { name: "在线发现" }));
      getImageAsset.mockClear();

      expect(getImageAsset).not.toHaveBeenCalled();

      const observer = observers[0];
      observer.callback(
        [{ isIntersecting: true, target: observer.elements[0] } as IntersectionObserverEntry],
        observer,
      );

      await waitFor(() => expect(getImageAsset).toHaveBeenCalledWith("D:\\ZX Wallpaper\\Online\\online-01.jpg", "grid"));
      expect(getImageAsset).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

class MockIntersectionObserver {
  readonly elements: Element[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(element: Element) { this.elements.push(element); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
}

function createOnlineGalleryRuntime(
  imageCount: number,
  getImageAsset = vi.fn(() => Promise.resolve({ src: "http://wallpaper-asset.localhost/thumbnail", width: 768, height: 432, status: "ready" as const })),
  prewarmImageAssets = vi.fn(() => Promise.resolve()),
): DesktopRuntime {
  const state: AppState = {
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
    globalNextShortcut: null,
    lastSwitchAt: null,
    onlineSources: [
      {
        id: "upx8-4k",
        name: "UPX8 综合壁纸 4K",
        url: "https://wp.upx8.com/api.php",
        enabled: true,
        intervalHours: 24,
        lastRunAt: null,
        nextRunAt: null,
        lastDiscovered: imageCount,
        lastDownloaded: imageCount,
        lastError: null,
      },
    ],
    onlineImages: Array.from({ length: imageCount }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        id: `image-${number}`,
        sourceId: "upx8-4k",
        localPath: `D:\\ZX Wallpaper\\Online\\online-${number}.jpg`,
        sourcePageUrl: "https://example.test/wallpapers",
        imageUrl: `https://example.test/online-${number}.jpg`,
        downloadedAt: "2026-08-10T00:00:00Z",
        width: 3840,
        height: 2160,
        mimeType: "image/jpeg",
      };
    }),
    onlineSyncLogs: [],
    onlineDirectory: "D:\\ZX Wallpaper\\Online",
    onlineStorageLimitGb: 5,
    onlineMinimumResolution: 1920,
    availableCount: 0,
    previewUrl: null,
    previewItems: [
      { path: "D:\\Wallpapers\\current.jpg", previewUrl: "data:image/jpeg;base64,current" },
      { path: "D:\\Wallpapers\\next.jpg", previewUrl: "data:image/jpeg;base64,next" },
    ],
    folderStatuses: {},
    onlineStorageBytes: 0,
    globalShortcutRegistered: false,
    shortcutStatus: { state: "disabled" },
  };
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
    getImageAsset,
    prewarmImageAssets,
    skipCurrentWallpaper: unchanged,
    toggleFavorite: unchanged,
    restoreSkippedPath: unchanged,
    restoreAllSkipped: unchanged,
    deleteSkippedPath: unchanged,
    togglePaused: unchanged,
    updateOnlineSource: unchanged,
    runOnlineSource: unchanged,
    runUpx8Category: unchanged,
    setOnlineImageAsWallpaper: unchanged,
    deleteOnlineImage: unchanged,
    selectOnlineDirectory: unchanged,
    revealOnlineImage: unchanged,
    revealWallpaper: () => Promise.resolve(),
    onStateChanged: () => Promise.resolve(() => {}),
  };
}
