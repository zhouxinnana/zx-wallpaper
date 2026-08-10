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

  it("adds a custom online source through the runtime-backed form", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "在线发现" });
    await user.click(screen.getByRole("button", { name: "在线发现" }));
    await user.type(
      screen.getByLabelText("自定义来源地址"),
      "https://wallpapers.example.test/gallery",
    );
    await user.click(screen.getByRole("button", { name: "添加来源" }));

    expect(await screen.findByText("wallpapers.example.test", { selector: "strong" })).toBeTruthy();
  });

  it("updates an online source polling interval", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));
    const interval = screen.getByLabelText("抓取间隔 Wallhaven SFW");
    await user.selectOptions(interval, "6");

    expect((interval as HTMLSelectElement).value).toBe("6");
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
    const prewarmOnlineThumbnails = vi.fn(() => Promise.resolve());
    render(<App runtime={createOnlineGalleryRuntime(50, undefined, prewarmOnlineThumbnails)} />);

    await user.click(await screen.findByRole("button", { name: "在线发现" }));

    await waitFor(() => expect(prewarmOnlineThumbnails).toHaveBeenCalledWith(
      Array.from({ length: 48 }, (_, index) => "image-" + String(index + 1).padStart(2, "0")),
    ));
  });

  it("requests online thumbnails only after their cards enter the viewport", async () => {
    const observers: MockIntersectionObserver[] = [];
    const getOnlineThumbnail = vi.fn(() => Promise.resolve("data:image/jpeg;base64,thumbnail"));
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
      render(<App runtime={createOnlineGalleryRuntime(25, getOnlineThumbnail)} />);
      await user.click(await screen.findByRole("button", { name: "在线发现" }));

      expect(getOnlineThumbnail).not.toHaveBeenCalled();

      const observer = observers[0];
      observer.callback(
        [{ isIntersecting: true, target: observer.elements[0] } as IntersectionObserverEntry],
        observer,
      );

      await waitFor(() => expect(getOnlineThumbnail).toHaveBeenCalledWith("image-01"));
      expect(getOnlineThumbnail).toHaveBeenCalledTimes(1);
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
  getOnlineThumbnail = vi.fn(() => Promise.resolve("data:image/jpeg;base64,thumbnail")),
  prewarmOnlineThumbnails = vi.fn(() => Promise.resolve()),
): DesktopRuntime {
  const state: AppState = {
    folders: [],
    intervalMinutes: 30,
    displayMode: "fill",
    autoStart: false,
    paused: false,
    followSystemTheme: true,
    currentPath: null,
    remainingPaths: [],
    skippedPaths: [],
    globalNextShortcut: null,
    lastSwitchAt: null,
    onlineSources: [
      {
        id: "source-1",
        name: "测试来源",
        kind: "builtin",
        url: "https://example.test/wallpapers",
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
        sourceId: "source-1",
        localPath: `D:\\ZX Wallpaper\\Online\\online-${number}.jpg`,
        sourcePageUrl: "https://example.test/wallpapers",
        imageUrl: `https://example.test/online-${number}.jpg`,
        downloadedAt: "2026-08-10T00:00:00Z",
        width: 3840,
        height: 2160,
        mimeType: "image/jpeg",
      };
    }),
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
    getPreviewThumbnail: vi.fn(() => Promise.resolve(null)),
    skipCurrentWallpaper: unchanged,
    restoreSkippedPath: unchanged,
    restoreAllSkipped: unchanged,
    deleteSkippedPath: unchanged,
    togglePaused: unchanged,
    addOnlineSource: unchanged,
    updateOnlineSource: unchanged,
    removeOnlineSource: unchanged,
    runOnlineSource: unchanged,
    setOnlineImageAsWallpaper: unchanged,
    deleteOnlineImage: unchanged,
    selectOnlineDirectory: unchanged,
    revealOnlineImage: unchanged,
    getOnlineThumbnail,
    prewarmOnlineThumbnails,
    getSkippedThumbnail: vi.fn(() => Promise.resolve(null)),
    onStateChanged: () => Promise.resolve(() => {}),
  };
}
