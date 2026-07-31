import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const executablePath = path.resolve(
  process.argv[2] ?? "release-source-verified/win-unpacked/ZX Wallpaper.exe",
);
const development = process.argv.includes("--development");
const requestedSourceId = process.argv
  .find((argument) => argument.startsWith("--source="))
  ?.slice("--source=".length);
const customUrl = process.argv
  .find((argument) => argument.startsWith("--custom-url="))
  ?.slice("--custom-url=".length);
const debugPort = 20_000 + Math.floor(Math.random() * 20_000);
const userDataPath = await mkdtemp(
  path.join(tmpdir(), "zx-wallpaper-builtins-"),
);
const builtInSourceIds = [
  "bing-cn-4k",
  "ltyuanfang-scenery",
  "upx8-4k",
  "wallhaven-clbug-sfw",
  "bing-ioliu",
];
let sourceIds = requestedSourceId ? [requestedSourceId] : builtInSourceIds;

assert.ok(
  !requestedSourceId ||
    sourceIds.every((sourceId) => builtInSourceIds.includes(sourceId)),
  `Unknown built-in source: ${requestedSourceId}`,
);
assert.ok(
  !requestedSourceId || !customUrl,
  "Use either --source or --custom-url, not both.",
);

assert.ok(
  existsSync(executablePath),
  `Expected packaged application: ${executablePath}`,
);
await writeFile(
  path.join(userDataPath, "settings.json"),
  JSON.stringify({
    folders: [],
    intervalMinutes: 30,
    displayMode: "fill",
    autoStart: false,
    paused: true,
    followSystemTheme: true,
    currentPath: null,
    remainingPaths: [],
    skippedPaths: [],
    globalNextShortcut: null,
    lastSwitchAt: null,
    onlineSources: [],
    onlineImages: [],
    onlineDirectory: path.join(userDataPath, "online"),
    onlineStorageLimitGb: 1,
    onlineMinimumResolution: 1920,
  }),
  "utf8",
);

const appProcess = spawn(
  executablePath,
  [
    ...(development ? [path.resolve(".")] : []),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataPath}`,
  ],
  {
    env: { ...process.env, ZX_WALLPAPER_TEST_MODE: "1" },
    stdio: "ignore",
    windowsHide: true,
  },
);
try {
  const target = await waitForPageTarget(debugPort);
  await waitForRendererBridge(target.webSocketDebuggerUrl);
  await waitForOnlineNavigation(target.webSocketDebuggerUrl);
  assert.equal(
    await evaluate(
      target.webSocketDebuggerUrl,
      "(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('在线发现')); if (!button) return false; button.click(); return true; })()",
    ),
    true,
    "Online discovery navigation is unavailable.",
  );
  await waitForSourceRows(target.webSocketDebuggerUrl, builtInSourceIds.length);
  if (customUrl) {
    const sourceId = await evaluate(
      target.webSocketDebuggerUrl,
      `(async () => {
        await window.zxWallpaper.addOnlineSource(${JSON.stringify(customUrl)});
        return (await window.zxWallpaper.getState()).onlineSources.find((source) => source.url === ${JSON.stringify(customUrl)})?.id;
      })()`,
      true,
    );
    assert.ok(sourceId, "Custom source was not added.");
    sourceIds = [sourceId];
    await waitForSourceRows(
      target.webSocketDebuggerUrl,
      builtInSourceIds.length + 1,
    );
  }
  assert.equal(
    await evaluate(
      target.webSocketDebuggerUrl,
      "Boolean(document.querySelector('button[aria-label=\"更改在线壁纸文件夹\"]'))",
    ),
    true,
    "Online discovery did not render the managed-folder control",
  );
  let downloadedImageCount = 0;
  let selectedOnlineImage;
  for (const sourceId of sourceIds) {
    const state = await evaluate(
      target.webSocketDebuggerUrl,
      `(async () => { await window.zxWallpaper.runOnlineSource('${sourceId}'); return window.zxWallpaper.getState(); })()`,
      true,
    );
    const source = state.onlineSources.find((item) => item.id === sourceId);
    assert.ok(source?.lastRunAt, `${sourceId} did not record a run`);
    if (sourceId === "upx8-4k") {
      assert.equal(
        source.categoryStatuses?.length,
        10,
        "UPX8 did not record every documented category.",
      );
      assert.deepEqual(
        source.categoryStatuses.map((status) => status.key).sort(),
        [
          "abstract",
          "animal",
          "anime",
          "car",
          "city",
          "game",
          "girl",
          "nature",
          "space",
          "sport",
        ],
      );
      assert.ok(
        source.categoryStatuses.some((status) => status.discovered > 1),
        "UPX8 count=10 did not return multiple candidates for any category.",
      );
      console.log(
        `UPX8 分类：${source.categoryStatuses
          .map(
            (status) =>
              `${status.label}=${status.lastError ? "失败" : `发${status.discovered}/下${status.downloaded}`}`,
          )
          .join("，")}`,
      );
      await waitForCategoryStatuses(target.webSocketDebuggerUrl, 10);
      assert.match(
        await evaluate(
          target.webSocketDebuggerUrl,
          "document.querySelector('.source-category-details summary')?.textContent ?? ''",
        ),
        /分类请求\s*10\s*个/,
      );
    }
    if (sourceId !== "upx8-4k")
      assert.equal(
        source.lastError,
        null,
        `${sourceId} failed: ${source.lastError}`,
      );
    assert.ok(
      source.lastDownloaded >= 1,
      `${sourceId} did not download an image`,
    );
    const image = state.onlineImages.find((item) => item.sourceId === sourceId);
    assert.ok(image, `${sourceId} did not persist image metadata`);
    assert.ok(
      image.width >= 1920 && image.width >= image.height,
      `${sourceId} downloaded an ineligible image`,
    );
    await access(image.localPath);
    selectedOnlineImage ??= image;
    downloadedImageCount = state.onlineImages.length;
    console.log(`${source.name}: ${image.width}x${image.height}`);
  }
  const revealButtonCount = await evaluate(
    target.webSocketDebuggerUrl,
    "document.querySelectorAll('button[title=\"在文件夹中显示\"]').length",
  );
  assert.equal(
    revealButtonCount,
    downloadedImageCount,
    "Downloaded online images did not render reveal-in-folder controls",
  );
  assert.ok(selectedOnlineImage, "No downloaded online image is available.");
  const setWallpaperButtonCount = await evaluate(
    target.webSocketDebuggerUrl,
    "document.querySelectorAll('button[title=\"设为壁纸\"]').length",
  );
  assert.equal(
    setWallpaperButtonCount,
    downloadedImageCount,
    "Downloaded online images did not render set-as-wallpaper controls",
  );
  const stateAfterManualSet = await evaluate(
    target.webSocketDebuggerUrl,
    `(async () => {
      await window.zxWallpaper.setOnlineImageAsWallpaper(${JSON.stringify(selectedOnlineImage.id)});
      return window.zxWallpaper.getState();
    })()`,
    true,
  );
  assert.equal(
    stateAfterManualSet.currentPath,
    selectedOnlineImage.localPath,
    "Manual set did not make the online image the current wallpaper.",
  );
  assert.equal(
    stateAfterManualSet.paused,
    true,
    "Manual set did not pause automatic wallpaper switching.",
  );
} finally {
  appProcess.kill();
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 3 });
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 15_000;
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  while (Date.now() < deadline) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          (!devServerUrl || target.url.startsWith(devServerUrl)),
      );
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Electron renderer.");
}

async function waitForSourceRows(debuggerUrl, expectedCount) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      (await evaluate(
        debuggerUrl,
        "document.querySelectorAll('.source-row').length",
      )) === expectedCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const actualCount = await evaluate(
    debuggerUrl,
    "document.querySelectorAll('.source-row').length",
  );
  assert.equal(
    actualCount,
    expectedCount,
    "Online discovery did not render every built-in source",
  );
}

async function waitForRendererBridge(debuggerUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(debuggerUrl, 'typeof window.zxWallpaper === "object"'))
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the Electron preload bridge.");
}

async function waitForOnlineNavigation(debuggerUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      await evaluate(
        debuggerUrl,
        "[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('在线发现'))",
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the Online discovery navigation.");
}

async function waitForCategoryStatuses(debuggerUrl, expectedCount) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      (await evaluate(
        debuggerUrl,
        "document.querySelectorAll('.source-category-status').length",
      )) === expectedCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("UPX8 category details did not render.");
}

function evaluate(debuggerUrl, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise, returnByValue: true },
        }),
      ),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      if (message.error || message.result.exceptionDetails)
        reject(
          new Error(
            message.error?.message ?? message.result.exceptionDetails.text,
          ),
        );
      else resolve(message.result.result.value);
      socket.close();
    });
    socket.addEventListener("error", reject);
  });
}
