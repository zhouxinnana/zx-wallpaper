import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AppConfig, AppState, DesktopRuntime, ImageTag, OnlineSource, TaggingStatus } from "./runtime/types";

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

  it("filters the skipped list by file name", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      skippedPaths: ["D:\\Wallpapers\\sunset.jpg", "D:\\Wallpapers\\forest.jpg"],
    });
    render(<App runtime={runtime} />);

    expect(await screen.findByText("sunset.jpg")).toBeTruthy();
    const filter = screen.getByLabelText("筛选已跳过图片");
    await user.type(filter, "sun");

    expect(screen.getByText("sunset.jpg")).toBeTruthy();
    expect(screen.queryByText("forest.jpg")).toBeNull();
    await user.clear(filter);
    await user.type(filter, "nomatch");
    expect(screen.getByText("没有匹配的图片")).toBeTruthy();
  });

  it("lists recent wallpapers and rolls back from the history strip", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      currentPath: "D:\\Wallpapers\\current.jpg",
      wallpaperHistory: ["D:\\Wallpapers\\current.jpg", "D:\\Wallpapers\\old-01.jpg", "D:\\Wallpapers\\old-02.jpg"],
    });
    const selectWallpaper = vi.fn(() => runtime.getState());
    runtime.selectWallpaper = selectWallpaper;
    render(<App runtime={runtime} />);

    expect(await screen.findByText("最近壁纸")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到 current.jpg" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "回到 old-01.jpg" }));

    expect(selectWallpaper).toHaveBeenCalledWith("D:\\Wallpapers\\old-01.jpg");
  });

  it("deletes all skipped images only after confirmation", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      skippedPaths: ["D:\\Wallpapers\\skipped-01.jpg", "D:\\Wallpapers\\skipped-02.jpg"],
    });
    const deleteAllSkipped = vi.fn(() => runtime.getState());
    runtime.deleteAllSkipped = deleteAllSkipped;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "全部删除" }));
    expect(deleteAllSkipped).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog", { name: "删除全部已跳过图片" });
    expect(dialog.textContent).toContain("2 张图片");

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(deleteAllSkipped).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "全部删除" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "全部删除" }));

    expect(deleteAllSkipped).toHaveBeenCalledOnce();
    expect((await screen.findByRole("status")).textContent).toContain("已跳过图片已全部移入回收站");
  });

  it("offers file deletion inside the viewer for skipped images", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      skippedPaths: ["D:\\Wallpapers\\skipped-01.jpg"],
      currentPath: "D:\\Wallpapers\\current.jpg",
    });
    const deleteSkippedPath = vi.fn(() => runtime.getState());
    runtime.deleteSkippedPath = deleteSkippedPath;
    render(<App runtime={runtime} />);

    expect(screen.queryByRole("button", { name: "删除 skipped-01.jpg" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "查看原图 skipped-01.jpg" }));
    await user.click(await screen.findByRole("button", { name: "删除文件" }));

    const dialog = screen.getByRole("alertdialog", { name: "删除图片文件" });
    expect(dialog.textContent).toContain("移入系统回收站");
    await user.click(within(dialog).getByRole("button", { name: "删除文件" }));

    expect(deleteSkippedPath).toHaveBeenCalledWith("D:\\Wallpapers\\skipped-01.jpg");
    expect(await screen.findByRole("status").then((status) => status.textContent)).toContain("已移入回收站");
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

    await screen.findByRole("button", { name: "图库" });
    await user.click(screen.getByRole("button", { name: "图库" }));

    expect(await screen.findByText("UPX8 综合壁纸 4K", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText("添加自定义 HTTPS 单页来源")).toBeNull();
  });

  it("updates an online source polling interval", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    const interval = screen.getByLabelText("抓取间隔 UPX8 综合壁纸 4K");
    await user.selectOptions(interval, "6");

    expect((interval as HTMLSelectElement).value).toBe("6");
  });

  it("syncs every upx8 category by default", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(0)} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    const checkboxes = screen.getAllByLabelText(/^定时同步 /) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(10);
    expect(checkboxes.every((checkbox) => checkbox.checked)).toBe(true);
    expect(screen.queryByRole("button", { name: "定时同步全部纳入" })).toBeNull();
  });

  it("persists the categories excluded from the interval sync", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const updateOnlineSource = vi.fn(async (source: OnlineSource) => {
      const current = await runtime.getState();
      return { ...current, onlineSources: current.onlineSources.map((item) => (item.id === source.id ? source : item)) };
    });
    runtime.updateOnlineSource = updateOnlineSource;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click(screen.getByLabelText("定时同步 运动"));

    const updated = updateOnlineSource.mock.calls[0][0];
    expect(updated.syncCategories).toHaveLength(9);
    expect(updated.syncCategories).not.toContain("sport");
    expect(await screen.findByText("定时同步 9/10 类")).toBeTruthy();
  });

  it("keeps the last synced category selected", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      onlineSources: [{
        id: "upx8-4k",
        name: "UPX8 综合壁纸 4K",
        url: "https://wp.upx8.com/api.php",
        enabled: true,
        intervalHours: 24,
        syncCategories: ["sport"],
        lastRunAt: null,
        nextRunAt: null,
        lastDiscovered: 0,
        lastDownloaded: 0,
        lastError: null,
      }],
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    const checkbox = screen.getByLabelText("定时同步 运动") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(/至少保留 1 个分类/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "定时同步全部纳入" })).toBeTruthy();
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

  it("persists the requested skip shortcut from settings", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const updateConfig = vi.fn(() => runtime.getState());
    runtime.updateConfig = updateConfig;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.type(screen.getByLabelText("全局跳过快捷键"), "Ctrl+Alt+S");
    await user.tab();

    expect(updateConfig).toHaveBeenCalledWith({ globalSkipShortcut: "Ctrl+Alt+S" });
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

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click(screen.getByRole("button", { name: "同步分类 风景" }));

    expect(runUpx8Category).toHaveBeenCalledWith("nature");
  });

  it("applies the completed online-sync state returned by the command", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const initialState = await runtime.getState();
    const completedState: AppState = {
      ...initialState,
      onlineImages: [
        {
          id: "image-01",
          sourceId: "upx8-4k",
          localPath: "D:\\ZX Wallpaper\\Online\\online-01.jpg",
          sourcePageUrl: "https://example.test/wallpapers",
          imageUrl: "https://example.test/online-01.jpg",
          downloadedAt: "2026-08-10T00:00:00Z",
          width: 3840,
          height: 2160,
          mimeType: "image/jpeg",
        },
      ],
      onlineSources: initialState.onlineSources.map((source) => ({
        ...source,
        lastDownloaded: 1,
      })),
      onlineSyncLogs: [
        {
          id: "sync-nature",
          sourceId: "upx8-4k",
          categoryKey: "nature",
          categoryLabel: "风景",
          requestUrl: "https://wp.upx8.com/api.php?category=nature",
          format: "json",
          resolution: "1920x1080",
          count: 10,
          startedAt: "2026-08-10T00:00:00Z",
          finishedAt: "2026-08-10T00:00:01Z",
          durationMs: 1000,
          status: "success",
          responseStatus: 200,
          discovered: 1,
          downloaded: 1,
          skipped: 0,
          responseImageUrls: ["https://example.test/online-01.jpg"],
          errors: [],
          downloadFailures: [],
        },
      ],
    };
    const runUpx8Category = vi.fn(() => Promise.resolve(completedState));
    runtime.runUpx8Category = runUpx8Category;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    expect(screen.getByText("图库还没有图片，先添加壁纸目录或同步在线来源")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "同步分类 风景" }));

    expect(await screen.findByRole("button", { name: "查看原图 online-01.jpg" })).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
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

    await user.click(await screen.findByRole("button", { name: "图库" }));

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

    await user.click(await screen.findByRole("button", { name: "图库" }));
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

    await user.click(await screen.findByRole("button", { name: "图库" }));
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

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click(screen.getByRole("button", { name: "刷新图库" }));

    expect(rescanFolders).toHaveBeenCalledOnce();
    expect((await screen.findByRole("status")).textContent).toContain("图库已刷新");
  });

  it("moves to the next page instead of extending the list infinitely", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(60)} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.queryByText("online-60.jpg")).toBeNull();
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("online-60.jpg")).toBeTruthy();
    expect(screen.queryByText("online-01.jpg")).toBeNull();
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();
  });

  it("prewarms the visible online images and the next batch", async () => {
    const user = userEvent.setup();
    const prewarmImageAssets = vi.fn(() => Promise.resolve());
    render(<App runtime={createOnlineGalleryRuntime(50, undefined, prewarmImageAssets)} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    await waitFor(() => expect(prewarmImageAssets).toHaveBeenCalledWith(
      Array.from({ length: 50 }, (_, index) => `D:\\ZX Wallpaper\\Online\\online-${String(index + 1).padStart(2, "0")}.jpg`),
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
      await user.click(await screen.findByRole("button", { name: "图库" }));
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

describe("smart tagging", () => {
  it("shows the tagging section as disabled and forwards enable requests", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const setTaggingEnabled = vi.fn(() => runtime.getState());
    runtime.setTaggingEnabled = setTaggingEnabled;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(screen.getByText("智能分类")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "启用智能分类" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);

    expect(setTaggingEnabled).toHaveBeenCalledWith(true);
  });

  it("accepts a manually typed automatic switching interval and clamps it to the supported range", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0);
    const updateConfig = vi.fn(async (patch: Partial<AppConfig>) => ({ ...(await runtime.getState()), ...patch }));
    runtime.updateConfig = updateConfig;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));

    const input = screen.getByLabelText("切换间隔（分钟）") as HTMLInputElement;
    expect(input.value).toBe("30");

    await user.clear(input);
    await user.type(input, "90");
    expect(screen.getByText("1 小时 30 分钟")).toBeTruthy();
    await user.tab();

    expect(updateConfig).toHaveBeenCalledWith({ intervalMinutes: 90 });

    updateConfig.mockClear();
    await user.clear(input);
    await user.type(input, "0");
    await user.tab();

    expect(updateConfig).toHaveBeenCalledWith({ intervalMinutes: 1 });
    await waitFor(() => expect(input.value).toBe("1"));
  });

  it("shows model download progress while the tagging model is downloading", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0, undefined, undefined, {
      status: { enabled: true, modelReady: false, downloading: { received: 44_000_000, total: 88_648_877 }, pending: 0 },
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByText("下载中")).toBeTruthy();
    expect(screen.getByText(/正在下载模型 42 \/ 85 MB（50%）/)).toBeTruthy();
  });

  it("shows a ready tagging model with the pending count", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0, undefined, undefined, {
      status: { enabled: true, modelReady: true, downloading: null, pending: 3 },
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByText("就绪")).toBeTruthy();
    expect(screen.getByText(/待打标 3 张/)).toBeTruthy();
  });

  it("shows the model as not downloaded when tagging has never run", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0, undefined, undefined, {
      status: { enabled: false, modelReady: false, downloading: null, pending: 0 },
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByText("未下载")).toBeTruthy();
  });

  it("filters the online gallery by image category", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(2, undefined, undefined, {
      taggingEnabled: true,
      imageTags: [
        { path: "D:\\ZX Wallpaper\\Online\\online-01.jpg", category: "nature", confidence: 0.9, taggedAt: "2026-10-20T00:00:00Z" },
      ],
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.getByText("online-02.jpg")).toBeTruthy();

    const filter = screen.getByLabelText("按分类筛选图库图片");
    await user.selectOptions(filter, "nature");
    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.queryByText("online-02.jpg")).toBeNull();

    await user.selectOptions(filter, "untagged");
    expect(screen.queryByText("online-01.jpg")).toBeNull();
    expect(screen.getByText("online-02.jpg")).toBeTruthy();

    await user.selectOptions(filter, "all");
    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.getByText("online-02.jpg")).toBeTruthy();
  });

  it("filters the favorites list by image category", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(2, undefined, undefined, {
      taggingEnabled: true,
      imageTags: [
        { path: "D:\\ZX Wallpaper\\Online\\online-01.jpg", category: "game", confidence: 0.8, taggedAt: "2026-10-20T00:00:00Z" },
      ],
    });
    const getState = runtime.getState;
    runtime.getState = async () => ({
      ...(await getState()),
      favoritePaths: ["D:\\ZX Wallpaper\\Online\\online-01.jpg", "D:\\ZX Wallpaper\\Online\\online-02.jpg"],
    });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "我的喜欢" }));
    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.getByText("online-02.jpg")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("按分类筛选喜欢的壁纸"), "game");
    expect(screen.getByText("online-01.jpg")).toBeTruthy();
    expect(screen.queryByText("online-02.jpg")).toBeNull();
  });

  it("hides the category filters when tagging is disabled", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(1, undefined, undefined, { taggingEnabled: false });
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    expect(screen.queryByLabelText("按分类筛选图库图片")).toBeNull();
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
  tagging: { imageTags?: ImageTag[]; taggingEnabled?: boolean; status?: TaggingStatus } = {},
  stateOverrides: Partial<AppState> = {},
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
    wallpaperHistory: [],
    globalNextShortcut: null,
    globalSkipShortcut: null,
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
    excludedImageUrls: [],
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
    widgetLayout: { docked: "right", x: null, y: null },
    imageTags: tagging?.imageTags ?? [],
    taggingEnabled: tagging?.taggingEnabled ?? false,
    availableCount: 0,
    previewUrl: null,
    previewItems: [
      { path: "D:\\Wallpapers\\current.jpg", previewUrl: "data:image/jpeg;base64,current" },
      { path: "D:\\Wallpapers\\next.jpg", previewUrl: "data:image/jpeg;base64,next" },
    ],
    folderStatuses: {},
    libraryImages: [],
    onlineStorageBytes: 0,
    globalShortcutRegistered: false,
    shortcutStatus: { state: "disabled" },
    skipShortcutStatus: { state: "disabled" },
    ...stateOverrides,
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
    getWidgetLayout: () => Promise.resolve(state.widgetLayout),
    setWidgetLayout: unchanged,
    setTaggingEnabled: (enabled: boolean) => Promise.resolve({ ...state, taggingEnabled: enabled }),
    getTaggingStatus: () => Promise.resolve(tagging.status ?? { enabled: state.taggingEnabled, modelReady: false, downloading: null, pending: 0 }),
    rescanTags: unchanged,
    onStateChanged: () => Promise.resolve(() => {}),
  };
}

describe("ZX Wallpaper unified gallery", () => {
  const localImage = (folderId: string, name: string, folderEnabled = true, modifiedAt: string | null = null) => ({ path: `D:\\Wallpapers\\${name}`, folderId, folderEnabled, modifiedAt });
  const onlinePath = (name: string) => `D:\\ZX Wallpaper\\Online\\${name}`;

  it("lists local folders as gallery sources and marks disabled ones", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      folders: [
        { id: "folder-a", path: "D:\\Wallpapers\\Scenic", enabled: true },
        { id: "folder-b", path: "D:\\Wallpapers\\Archive", enabled: false },
      ],
      libraryImages: [localImage("folder-a", "ridge.jpg"), localImage("folder-b", "old.jpg", false)],
    })} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    const scenicTab = await screen.findByRole("tab", { name: /Scenic/ });
    expect(scenicTab.textContent).toContain("1");
    const archiveTab = screen.getByRole("tab", { name: /Archive/ });
    expect(archiveTab.textContent).toContain("已停用");
    expect(screen.getByText(/按文件名排列/)).toBeTruthy();
  });

  it("shows a disabled-folder image with a no-rotation badge and blocks setting it while multiple are selected", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      folders: [{ id: "folder-b", path: "D:\\Wallpapers\\Archive", enabled: false }],
      libraryImages: [localImage("folder-b", "old.jpg", false), localImage("folder-b", "older.jpg", false)],
    })} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    expect((await screen.findAllByText("不参与轮转")).length).toBe(2);

    await user.click(screen.getByRole("checkbox", { name: "选择 old.jpg" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 older.jpg" }));
    const wallpaperButtons = screen.getAllByRole("button", { name: "设为壁纸" });
    expect(wallpaperButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("sends the selected paths to the batch skip command", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(2);
    const batchSkipPaths = vi.fn(() => runtime.getState());
    runtime.batchSkipPaths = batchSkipPaths;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click(await screen.findByRole("checkbox", { name: "选择 online-01.jpg" }));
    await user.click(screen.getByRole("button", { name: "跳过" }));

    expect(batchSkipPaths).toHaveBeenCalledWith([onlinePath("online-01.jpg")]);
  });

  it("confirms before running the batch delete command and reports the count", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(3);
    const batchDeletePaths = vi.fn(() => runtime.getState());
    runtime.batchDeletePaths = batchDeletePaths;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click(await screen.findByRole("checkbox", { name: "选择 online-01.jpg" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 online-02.jpg" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(batchDeletePaths).not.toHaveBeenCalled();
    expect((await screen.findByText("删除 2 张图片")).textContent).toBe("删除 2 张图片");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("移入系统回收站");
    await user.click(within(dialog).getByRole("button", { name: "删除" }));

    expect(batchDeletePaths).toHaveBeenCalledWith([onlinePath("online-01.jpg"), onlinePath("online-02.jpg")]);
    // 删除后选择态必须清空，否则批量栏会显示「已选 N 张」但实际一张都不存在。
    expect(await screen.findByText("已选 0 张")).toBeTruthy();
  });

  it("shows the excluded download list and clears it after confirmation", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      excludedImageUrls: ["https://example.test/a.jpg", "https://example.test/b.jpg"],
    });
    const clearExcludedImageUrls = vi.fn(() => runtime.getState());
    runtime.clearExcludedImageUrls = clearExcludedImageUrls;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    expect(await screen.findByText("已排除下载 (2)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "清空排除记录" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 个已删除图片的源地址");
    await user.click(within(dialog).getByRole("button", { name: "清空" }));

    expect(clearExcludedImageUrls).toHaveBeenCalled();
  });

  it("lists the excluded urls and removes a single entry", async () => {
    const user = userEvent.setup();
    const runtime = createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      excludedImageUrls: ["https://example.test/a.jpg", "https://example.test/b.jpg"],
    });
    const removeExcludedImageUrl = vi.fn(() => runtime.getState());
    runtime.removeExcludedImageUrl = removeExcludedImageUrl;
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click(await screen.findByText(/查看已排除的 2 个地址/));
    expect(await screen.findByText("https://example.test/a.jpg")).toBeTruthy();
    expect(screen.getByText("https://example.test/b.jpg")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "移出排除 https://example.test/a.jpg" }));
    expect(removeExcludedImageUrl).toHaveBeenCalledWith("https://example.test/a.jpg");
  });

  it("sorts the gallery by name or by file time", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      folders: [{ id: "folder-a", path: "D:\\Wallpapers\\Scenic", enabled: true }],
      // 名称序与时间序刻意相反：a 最旧、c 最新。
      libraryImages: [
        localImage("folder-a", "a-old.jpg", true, "2026-01-01T00:00:00Z"),
        localImage("folder-a", "b-middle.jpg", true, "2026-06-01T00:00:00Z"),
        localImage("folder-a", "c-new.jpg", true, "2026-10-01T00:00:00Z"),
      ],
    })} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    const grid = (await screen.findByText("a-old.jpg")).closest(".online-gallery") as HTMLElement;
    const cardNames = () => Array.from(grid.querySelectorAll<HTMLElement>("[data-gallery-path]"))
      .map((card) => card.getAttribute("data-gallery-path")?.split("\\").pop() ?? "");

    expect(cardNames()).toEqual(["a-old.jpg", "b-middle.jpg", "c-new.jpg"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "图库排序方式" }), "time");
    expect(cardNames()).toEqual(["c-new.jpg", "b-middle.jpg", "a-old.jpg"]);
    expect(screen.getByText(/按更新时间排列/)).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "图库排序方式" }), "name");
    expect(cardNames()).toEqual(["a-old.jpg", "b-middle.jpg", "c-new.jpg"]);
  });

  it("only renders the current page of a thousand local images", async () => {
    const user = userEvent.setup();
    const libraryImages = Array.from({ length: 1000 }, (_, index) => localImage("folder-a", `bulk-${String(index + 1).padStart(4, "0")}.jpg`));
    render(<App runtime={createOnlineGalleryRuntime(0, undefined, undefined, undefined, {
      folders: [{ id: "folder-a", path: "D:\\Wallpapers\\Scenic", enabled: true }],
      libraryImages,
    })} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));

    const heading = (await screen.findByRole("heading", { level: 2 })).textContent;
    expect(heading).toContain("图库");
    expect(heading).toContain("(1000)");
    expect(screen.getByText(/第 1 \/ 21 页/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "选择 bulk-0048.jpg" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "选择 bulk-0049.jpg" })).toBeNull();
  });

  it("selects a gallery image by clicking the card itself", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(2)} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    await user.click((await screen.findByText("online-01.jpg")).closest("article")!);

    expect(screen.getByText("已选 1 张")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "选择 online-01.jpg" }) as HTMLInputElement).checked).toBe(true);
  });

  it("keeps a normal card click working after a marquee drag", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(4)} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    const grid = (await screen.findByText("online-01.jpg")).closest(".online-gallery") as HTMLElement;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-gallery-path]"));
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    cards.forEach((card, index) => {
      const left = 10 + index * 100;
      card.getBoundingClientRect = () => ({ left, top: 10, right: left + 90, bottom: 130, width: 90, height: 120, x: left, y: 10, toJSON: () => ({}) }) as DOMRect;
    });

    fireEvent.mouseDown(cards[0], { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseMove(window, { clientX: 120, clientY: 60 });
    fireEvent.mouseUp(cards[0], { button: 0, clientX: 120, clientY: 60 });
    await waitFor(() => expect(screen.getByText("已选 2 张")).toBeTruthy());

    // 框选结束后的一次普通点击必须照常切换选中，不能被拖拽的余波吞掉。
    fireEvent.click(cards[3], { clientX: 320, clientY: 20 });
    await waitFor(() => expect(screen.getByText("已选 3 张")).toBeTruthy());
    expect((screen.getByRole("checkbox", { name: "选择 online-04.jpg" }) as HTMLInputElement).checked).toBe(true);
  });

  it("selects every image inside a dragged marquee rectangle", async () => {
    const user = userEvent.setup();
    render(<App runtime={createOnlineGalleryRuntime(6)} />);

    await user.click(await screen.findByRole("button", { name: "图库" }));
    const grid = (await screen.findByText("online-01.jpg")).closest(".online-gallery") as HTMLElement;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-gallery-path]"));
    expect(cards.length).toBe(6);

    // jsdom 没有真实布局，手动给出网格与卡片的矩形，框选才能算出相交集合。
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    cards.forEach((card, index) => {
      const left = 10 + index * 100;
      card.getBoundingClientRect = () => ({ left, top: 10, right: left + 90, bottom: 130, width: 90, height: 120, x: left, y: 10, toJSON: () => ({}) }) as DOMRect;
    });

    fireEvent.mouseDown(grid, { button: 0, clientX: 2, clientY: 2 });
    fireEvent.mouseMove(window, { clientX: 104, clientY: 18 });
    fireEvent.mouseMove(window, { clientX: 304, clientY: 126 });
    fireEvent.mouseUp(window, { button: 0, clientX: 304, clientY: 126 });

    await waitFor(() => expect(screen.getByText("已选 3 张")).toBeTruthy());
    expect((screen.getByRole("checkbox", { name: "选择 online-01.jpg" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择 online-03.jpg" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择 online-04.jpg" }) as HTMLInputElement).checked).toBe(false);
  });
});