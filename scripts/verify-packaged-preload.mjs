import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const executablePath = path.resolve(
  process.argv[2] ?? "release/win-unpacked/ZX Wallpaper.exe",
);
const debugPort = 20_000 + Math.floor(Math.random() * 20_000);
const userDataPath = await mkdtemp(
  path.join(tmpdir(), "zx-wallpaper-preload-"),
);
await writeFile(
  path.join(userDataPath, "settings.json"),
  JSON.stringify({
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
    onlineDirectory: path.join(userDataPath, "online"),
    onlineStorageLimitGb: 1,
    onlineMinimumResolution: 1920,
  }),
  "utf8",
);
const appProcess = spawn(
  executablePath,
  [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataPath}`],
  { stdio: "ignore", windowsHide: true },
);

try {
  const target = await waitForPageTarget(debugPort);
  const result = await evaluate(
    target.webSocketDebuggerUrl,
    `[
    'addFolder', 'rescanFolders', 'skipCurrentWallpaper', 'restoreAllSkipped',
    'addOnlineSource', 'runOnlineSource', 'deleteOnlineImage',
    'selectOnlineDirectory', 'revealOnlineImage'
  ].map((key) => [key, typeof window.zxWallpaper?.[key]])`,
  );
  for (const [key, type] of result) {
    assert.equal(
      type,
      "function",
      `Expected packaged preload bridge method ${key}, received ${type}`,
    );
  }
  console.log(
    "Packaged preload bridge exposes wallpaper and online discovery controls.",
  );
} finally {
  appProcess.kill();
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 3 });
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) {
        return page;
      }
    } catch {
      // Electron has not opened its debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the packaged Electron renderer.");
}

function evaluate(debuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result.result.value);
      }
      socket.close();
    });
    socket.addEventListener("error", reject);
  });
}
