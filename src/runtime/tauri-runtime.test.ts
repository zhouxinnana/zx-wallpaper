import { describe, expect, it, vi } from "vitest";
import type { AppState } from "./types";
import { createTauriRuntime } from "./tauri-runtime";

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
};

describe("Tauri runtime", () => {
  it("reads the full application state through the get_state command", async () => {
    const invoke = vi.fn().mockResolvedValue(state);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.getState()).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith("get_state");
  });

  it("sends image asset warm requests without waiting for image data", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.prewarmImageAssets(["D:\\Wallpapers\\one.jpg", "D:\\Wallpapers\\two.jpg"], "grid")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("prewarm_image_assets", {
      filePaths: ["D:\\Wallpapers\\one.jpg", "D:\\Wallpapers\\two.jpg"],
      kind: "grid",
    });
  });

  it("forwards preview-strip wallpaper selection", async () => {
    const invoke = vi.fn().mockResolvedValue(state);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.selectWallpaper("D:\\Wallpapers\\next.jpg")).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith("select_wallpaper", {
      filePath: "D:\\Wallpapers\\next.jpg",
    });
  });

  it("forwards image asset requests with their display kind", async () => {
    const asset = { src: "http://wallpaper-asset.localhost/example", width: 768, height: 432, status: "ready" as const };
    const invoke = vi.fn().mockResolvedValue(asset);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.getImageAsset("D:\\Wallpapers\\next.jpg", "hero")).resolves.toEqual(asset);
    expect(invoke).toHaveBeenCalledWith("get_image_asset", {
      filePath: "D:\\Wallpapers\\next.jpg",
      kind: "hero",
    });
  });

  it("forwards favorite toggles by image path", async () => {
    const invoke = vi.fn().mockResolvedValue(state);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.toggleFavorite("D:\\Wallpapers\\next.jpg")).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith("toggle_favorite", {
      filePath: "D:\\Wallpapers\\next.jpg",
    });
  });

  it("forwards deleting all skipped images", async () => {
    const invoke = vi.fn().mockResolvedValue(state);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.deleteAllSkipped()).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith("delete_all_skipped");
  });

  it("forwards smart-tagging commands", async () => {
    const invoke = vi.fn().mockResolvedValue(state);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await runtime.setTaggingEnabled(true);
    expect(invoke).toHaveBeenCalledWith("set_tagging_enabled", { enabled: true });

    await runtime.getTaggingStatus();
    expect(invoke).toHaveBeenCalledWith("get_tagging_status");

    await runtime.rescanTags();
    expect(invoke).toHaveBeenCalledWith("rescan_tags");
  });

  it("forwards state events and unregisters the listener", async () => {
    let emit: ((event: { payload: AppState }) => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_name, callback) => {
      emit = callback;
      return unlisten;
    });
    const runtime = createTauriRuntime({ invoke: vi.fn(), listen });
    const listener = vi.fn();

    const stop = await runtime.onStateChanged(listener);
    emit?.({ payload: state });
    stop();

    expect(listen).toHaveBeenCalledWith("app://state-changed", expect.any(Function));
    expect(listener).toHaveBeenCalledWith(state);
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
