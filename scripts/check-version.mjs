#!/usr/bin/env node
/**
 * 校验仓库里所有版本号位置与 package.json 一致。
 *
 * 存在的意义：版本号分散在 Node 与 Rust 两套生态（共 5 处），
 * 手改漏一处不会立刻报错，只会在发版时才炸。CI 上先跑这个，快且准。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const problems = [];
const pkg = readJson("package.json");
const expected = pkg.version;

if (!expected || !SEMVER.test(expected)) {
  console.error(`package.json 的 version 不是合法 semver: ${expected}`);
  process.exit(1);
}

const check = (label, actual) => {
  if (actual !== expected) problems.push(`${label}: ${actual ?? "(缺失)"} != ${expected}`);
};

const lock = readJson("package-lock.json");
check("package-lock.json root", lock.version);
check('package-lock.json packages[""]', lock.packages?.[""]?.version);

// tauri.conf.json 允许是 semver，也允许是指向 package.json 的路径（见 Tauri v2 配置文档）。
const tauri = readJson("src-tauri/tauri.conf.json");
const declared = tauri.version;
if (typeof declared === "string" && SEMVER.test(declared)) {
  check("src-tauri/tauri.conf.json", declared);
} else if (typeof declared === "string" && declared.trim() !== "") {
  const target = resolve(root, "src-tauri", declared);
  try {
    check(`src-tauri/tauri.conf.json -> ${declared}`, JSON.parse(readFileSync(target, "utf8")).version);
  } catch (error) {
    problems.push(`src-tauri/tauri.conf.json 指向的 ${declared} 读不到: ${error.message}`);
  }
} else {
  // 省略时会回退到 Cargo.toml，等于又多了一处真源，这里明确禁止。
  problems.push("src-tauri/tauri.conf.json 缺少 version（应写 semver 或 ../package.json）");
}

// 用 \r?\n：GitHub Actions 的 Windows runner checkout 出 CRLF，只写 \n 会在这里漏匹配。
const cargoTomlVersion = read("src-tauri/Cargo.toml").match(/^name = "zx-wallpaper"\r?\nversion = "([^"]+)"/m)?.[1];
check("src-tauri/Cargo.toml", cargoTomlVersion);

const cargoLockVersion = read("src-tauri/Cargo.lock").match(/^name = "zx-wallpaper"\r?\nversion = "([^"]+)"/m)?.[1];
check("src-tauri/Cargo.lock", cargoLockVersion);

if (problems.length > 0) {
  console.error(`版本号不一致（真源 package.json = ${expected}）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("修复：npm run version:bump " + expected);
  process.exit(1);
}

console.log(`版本号一致：${expected}（package.json / package-lock ×2 / tauri.conf / Cargo.toml / Cargo.lock）`);
