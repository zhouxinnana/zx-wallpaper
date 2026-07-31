import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("electron/main.ts", "utf8");

assert.match(
  source,
  /app\.setLoginItemSettings\(\{\s*openAtLogin: this\.store\.value\.autoStart,\s*args: \["--background"\],\s*\}\);/s,
  "Expected Windows login startup to pass the background flag.",
);
assert.match(
  source,
  /if \(!process\.argv\.includes\("--background"\)\) showWindow\(\);/,
  "Expected a normal packaged launch to show the window.",
);
assert.doesNotMatch(
  source,
  /if \(!app\.isPackaged \|\| store\.value\.folders\.length <= 1\) showWindow\(\);/,
  "A packaged launch must not be hidden because of its folder count.",
);

console.log("Normal startup opens the window; login startup runs in the background.");
