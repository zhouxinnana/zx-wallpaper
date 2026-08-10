import { describe, expect, it, vi } from "vitest";
import type { AppState } from "./types";
import { createTauriRuntime } from "./tauri-runtime";

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
  onlineSources: [],
  onlineImages: [],
  onlineDirectory: null,
  onlineStorageLimitGb: 5,
  onlineMinimumResolution: 1920,
  availableCount: 0,
  previewUrl: null,
  previewItems: [],
  folderStatuses: {},
  onlineStorageBytes: 0,
  globalShortcutRegistered: false,
};

describe("Tauri runtime", () => {
  it("reads the full application state through the get_state command", async () => {
    const invoke = vi.fn().mockResolvedValue(state);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.getState()).resolves.toEqual(state);
    expect(invoke).toHaveBeenCalledWith("get_state");
  });

  it("sends thumbnail warm requests without waiting for image data", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.prewarmOnlineThumbnails(["image-01", "image-02"])).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("prewarm_online_thumbnails", {
      imageIds: ["image-01", "image-02"],
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

  it("forwards preview thumbnail requests", async () => {
    const invoke = vi.fn().mockResolvedValue("data:image/jpeg;base64,thumbnail");
    const runtime = createTauriRuntime({ invoke, listen: vi.fn() });

    await expect(runtime.getPreviewThumbnail("D:\\Wallpapers\\next.jpg")).resolves.toBe(
      "data:image/jpeg;base64,thumbnail",
    );
    expect(invoke).toHaveBeenCalledWith("get_preview_thumbnail", {
      filePath: "D:\\Wallpapers\\next.jpg",
    });
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
