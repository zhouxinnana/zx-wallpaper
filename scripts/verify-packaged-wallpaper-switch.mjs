import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const executablePath = path.resolve(
  process.argv[2] ?? "release/win-unpacked/ZX Wallpaper.exe",
);
const development = process.argv.includes("--development");
const previewOnly = process.argv.includes("--preview-only");
const wallpaperPath = "C:\\Windows\\Web\\Wallpaper\\Windows\\img0.jpg";
const wallpaperDirectory = path.dirname(wallpaperPath);
const debugPort = 20_000 + Math.floor(Math.random() * 20_000);
const userDataPath = await mkdtemp(path.join(tmpdir(), "zx-wallpaper-switch-"));

await writeFile(
  path.join(userDataPath, "settings.json"),
  JSON.stringify({
    folders: [
      { id: "system-wallpapers", path: wallpaperDirectory, enabled: true },
    ],
    intervalMinutes: 30,
    displayMode: "fill",
    autoStart: false,
    paused: false,
    followSystemTheme: true,
    currentPath: previewOnly ? wallpaperPath : null,
    remainingPaths: previewOnly ? [] : [wallpaperPath],
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
  { stdio: "ignore", windowsHide: true },
);

try {
  const target = await waitForPageTarget(debugPort);
  await waitForRendererBridge(target.webSocketDebuggerUrl);
  const state = await evaluate(
    target.webSocketDebuggerUrl,
    previewOnly
      ? "window.zxWallpaper.getState()"
      : "(async () => { await window.zxWallpaper.nextWallpaper(); return window.zxWallpaper.getState(); })()",
    true,
  );
  assert.equal(
    state.currentPath?.toLowerCase(),
    wallpaperPath.toLowerCase(),
    `Expected currentPath to be ${wallpaperPath}, received ${state.currentPath}`,
  );
  assert.match(
    state.previewUrl ?? "",
    /^zx-wallpaper-preview:\/\//,
    "Expected the current wallpaper to use the preview protocol.",
  );
  const preview = await evaluate(
    target.webSocketDebuggerUrl,
    `(async () => {
      const response = await fetch(${JSON.stringify(state.previewUrl)});
      return {
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        byteLength: (await response.arrayBuffer()).byteLength,
      };
    })()`,
    true,
  );
  assert.equal(
    preview.ok,
    true,
    "Expected preview protocol response to succeed.",
  );
  assert.equal(preview.contentType, "image/jpeg");
  assert.ok(preview.byteLength > 0, "Expected preview JPEG bytes.");
  const mutation = await evaluate(
    target.webSocketDebuggerUrl,
    `(async () => {
      const result = await window.zxWallpaper.togglePaused();
      return {
        resultType: typeof result,
        paused: (await window.zxWallpaper.getState()).paused,
      };
    })()`,
    true,
  );
  assert.equal(mutation.resultType, "undefined");
  assert.equal(mutation.paused, true);
  console.log(
    previewOnly
      ? "Preview protocol verification completed."
      : "Packaged wallpaper switch completed.",
  );
} finally {
  appProcess.kill();
  await rm(userDataPath, { recursive: true, force: true, maxRetries: 3 });
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 10_000;
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  let targetUrls = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      targetUrls = targets.map((target) => `${target.type}: ${target.url}`);
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          (!devServerUrl || target.url.startsWith(devServerUrl)),
      );
      if (page) {
        return page;
      }
    } catch {
      // Electron has not opened its debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for the packaged Electron renderer. Targets: ${targetUrls.join(", ")}`,
  );
}

async function waitForRendererBridge(debuggerUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(
        debuggerUrl,
        'typeof window.zxWallpaper === "object"',
      );
      if (ready) return;
    } catch {
      // Renderer navigation can briefly invalidate the DevTools target.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the Electron preload bridge.");
}

function evaluate(debuggerUrl, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise, returnByValue: true },
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
      } else if (message.result.exceptionDetails) {
        reject(
          new Error(
            message.result.exceptionDetails.exception?.description ??
              message.result.exceptionDetails.text,
          ),
        );
      } else {
        resolve(message.result.result.value);
      }
      socket.close();
    });
    socket.addEventListener("error", reject);
  });
}
