import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const executablePath = path.resolve(
  process.argv[2] ?? "release/win-unpacked/ZX Wallpaper.exe",
);
const iconPath = path.join(
  path.dirname(executablePath),
  "resources",
  "zx-wallpaper.ico",
);
const sourceIconPath = path.resolve("build/zx-wallpaper.ico");

assert.ok(existsSync(iconPath), `Expected packaged tray icon at ${iconPath}`);
assert.ok(
  existsSync(sourceIconPath),
  `Expected source icon at ${sourceIconPath}`,
);

const sourceIcon = readFileSync(sourceIconPath);
const packagedIcon = readFileSync(iconPath);
assert.equal(
  packagedIcon.subarray(0, 4).toString("hex"),
  "00000100",
  "Packaged tray icon is not an ICO file",
);
assert.equal(
  createHash("sha256").update(packagedIcon).digest("hex"),
  createHash("sha256").update(sourceIcon).digest("hex"),
  "Packaged tray icon differs from the verified application icon",
);

console.log(`Packaged tray icon matches the application icon: ${iconPath}.`);
