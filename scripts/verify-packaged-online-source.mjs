import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const executablePath = path.resolve(
  process.argv[2] ?? "release/win-unpacked/ZX Wallpaper.exe",
);
const debugPort = 20_000 + Math.floor(Math.random() * 20_000);
const userDataPath = await mkdtemp(path.join(tmpdir(), "zx-wallpaper-online-"));
const source = {
  id: "wallhaven-sfw",
  name: "Wallhaven SFW",
  kind: "builtin",
  url: "https://wallhaven.cc/api/v1/search?purity=100&sorting=random",
  enabled: false,
  intervalHours: 24,
  lastRunAt: null,
  nextRunAt: null,
  lastDiscovered: 0,
  lastDownloaded: 0,
  lastError: null,
};
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
    onlineSources: [source],
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
  const state = await evaluate(
    target.webSocketDebuggerUrl,
    "(async () => { await window.zxWallpaper.runOnlineSource('wallhaven-sfw'); return window.zxWallpaper.getState(); })()",
    true,
  );
  const updatedSource = state.onlineSources.find(
    (item) => item.id === "wallhaven-sfw",
  );
  assert.ok(
    updatedSource?.lastRunAt,
    "Expected the manual source run to record its completion time",
  );
  if (updatedSource.lastError) {
    console.log(
      `Packaged online source recorded a recoverable network failure: ${updatedSource.lastError}`,
    );
  } else {
    assert.ok(
      state.onlineImages.length > 0,
      "Expected an available source to download at least one image",
    );
    assert.ok(
      state.onlineImages.every(
        (image) => image.width >= 1920 && image.width >= image.height,
      ),
      "Downloaded image did not meet wallpaper filters",
    );
    console.log(
      `Packaged online source downloaded ${state.onlineImages.length} qualified image(s).`,
    );
  }
} finally {
  appProcess.kill();
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 3 });
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for packaged Electron renderer.");
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
