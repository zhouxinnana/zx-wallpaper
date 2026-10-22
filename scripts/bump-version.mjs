#!/usr/bin/env node
/**
 * 一次性把版本号同步到所有位置。
 *
 * 用法：npm run version:bump 0.3.0
 *
 * 设计要点：
 * - 先全部算出新内容，确认每处命中数量正确，再统一落盘 —— 避免改一半留下不一致状态。
 * - src-tauri/tauri.conf.json 引用 ../package.json，正常不需要改；若哪天又写回硬编码 semver，
 *   这里会一并更新，不会漏。
 * - 不做 git 操作（commit / tag 由人决定），只改文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const next = process.argv[2];
if (!next || !SEMVER.test(next)) {
  console.error("用法：npm run version:bump <semver>，例如 npm run version:bump 0.3.0");
  process.exit(1);
}

/** package.json / package-lock.json 里 name 与 version 相邻，用这个结构定位，不碰依赖版本。 */
const bumpJsonVersion = (text) => {
  const pattern = /("name": "zx-wallpaper",\s*\n\s*"version": ")([^"]+)(")/g;
  const before = [...text.matchAll(pattern)].map((match) => match[2]);
  return { text: text.replace(pattern, (_all, head, _old, tail) => `${head}${next}${tail}`), before };
};

/** Cargo.toml 的 [package] 与 Cargo.lock 的 [[package]] 都是 name 紧接 version。 */
const bumpCargoVersion = (text) => {
  const pattern = /^(name = "zx-wallpaper"\nversion = ")([^"]+)(")/m;
  const match = text.match(pattern);
  return {
    text: text.replace(pattern, (_all, head, _old, tail) => `${head}${next}${tail}`),
    before: match ? [match[2]] : [],
  };
};

/** tauri.conf.json 若写的是硬编码 semver 也要同步；引用路径时跳过。 */
const bumpTauriVersion = (text) => {
  const pattern = /("productName": "ZX Wallpaper",\s*\n\s*"version": ")(\d+\.\d+\.\d+(?:[-+][^"]*)?)(")/;
  const match = text.match(pattern);
  if (!match) return { text, before: [] };
  return {
    text: text.replace(pattern, (_all, head, _old, tail) => `${head}${next}${tail}`),
    before: [match[2]],
  };
};

const plans = [
  { file: "package.json", transform: bumpJsonVersion, expected: 1 },
  { file: "package-lock.json", transform: bumpJsonVersion, expected: 2 },
  { file: "src-tauri/Cargo.toml", transform: bumpCargoVersion, expected: 1 },
  { file: "src-tauri/Cargo.lock", transform: bumpCargoVersion, expected: 1 },
  { file: "src-tauri/tauri.conf.json", transform: bumpTauriVersion, expected: 0 },
];

const staged = [];
for (const plan of plans) {
  const original = read(plan.file);
  const result = plan.transform(original);
  // tauri.conf.json 允许 0 处（引用 ../package.json 时），其余必须精确命中。
  if (plan.expected > 0 && result.before.length !== plan.expected) {
    console.error(
      `${plan.file}: 只命中 ${result.before.length} 处版本号，预期 ${plan.expected} 处 —— 文件结构可能变了，先检查再改脚本`,
    );
    process.exit(1);
  }
  staged.push({ ...plan, original, updated: result.text, before: result.before });
}

const changed = staged.filter((item) => item.original !== item.updated);
if (changed.length === 0) {
  console.log(`版本号已经是 ${next}，没有需要改动的位置。`);
  process.exit(0);
}

for (const item of changed) writeFileSync(resolve(root, item.file), item.updated);

console.log(`版本号 → ${next}`);
for (const item of changed) {
  console.log(`  ${item.file}: ${item.before.join(" / ")} → ${next}`);
}
const tauri = staged.find((item) => item.file === "src-tauri/tauri.conf.json");
if (tauri && tauri.before.length === 0) {
  console.log("  src-tauri/tauri.conf.json: 引用 ../package.json，无需改动");
}
console.log("\n下一步：npm run version:check 校验，然后 commit + 打 tag 推送发版。");
