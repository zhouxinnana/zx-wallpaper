import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distDirectory = path.resolve("dist");
const assetsDirectory = path.join(distDirectory, "assets");
const bundleName = (await readdir(assetsDirectory)).find(
  (name) => name.startsWith("index-") && name.endsWith(".js"),
);

assert.ok(bundleName, "Expected a built renderer JavaScript bundle.");
const bundle = await readFile(path.join(assetsDirectory, bundleName), "utf8");
assert.match(
  bundle,
  /src:"\.\/zx-wallpaper-logo\.svg"/,
  "Expected the brand logo to use a relative URL in the packaged renderer.",
);

const logoUrl = new URL(
  "./zx-wallpaper-logo.svg",
  pathToFileURL(path.join(distDirectory, "index.html")),
);
assert.ok(
  existsSync(fileURLToPath(logoUrl)),
  `Expected the packaged brand logo at ${logoUrl.href}.`,
);

console.log(`Packaged brand logo resolves to ${logoUrl.href}.`);
