# 类型安全

> 本项目的类型安全模式。

---

## 概览

TypeScript strict 模式（`tsc --noEmit` 是构建门禁：`npm run build` = typecheck + vite build）。**没有运行时校验库**（无 Zod）——IPC 边界靠手工镜像的接口保持类型一致。

---

## 类型组织

- **唯一来源**：`src/runtime/types.ts` 定义所有共享类型：`AppState`（extends `AppConfig`）、`DesktopRuntime`（IPC 契约）、以及全部领域形状（`WallpaperFolder`、`OnlineSource`、`OnlineSyncLog`、`ShortcutStatus`、……）。
- `DesktopRuntime` 与 `src-tauri/src/lib.rs` 的 Rust 命令列表 1:1 镜像。加命令时两侧必须同步改（见 `directory-structure.md`）。
- `App.tsx` 内部的类型留在文件内（`View`、`ConfirmOptions`、选项常量元素类型）。

---

## 实际模式（有代码出处）

- **字符串字面量联合**表达封闭集合：`WallpaperMode = "fill" | "fit" | ...`、`RotationOrder = "random" | "sequential"`（`types.ts:1-9`）。
- **带 state 标签的可辨识联合**：`ShortcutStatus = { state: "disabled" } | { state: "active"; shortcut } | { state: "error"; shortcut; message }`（`types.ts:11-14`）；`FolderStatus.kind`、`OnlineSyncLog.status` 同款。
- **配置档位的数字字面量联合**：`onlineStorageLimitGb: 1 | 5 | 10 | 20`、`onlineMinimumResolution: 1920 | 2560 | 3840`。
- **边界处运行时类型守卫**：`isAppState(value: unknown): value is AppState`（`App.tsx:841`）对每个从 `run()` 返回的快照做守卫，通过后才 `setState`。
- **表单输入处定点 cast**：select 处理器把 `event.target.value` / `Number(...)` cast 成字段的联合类型，如 `Number(event.target.value) as AppConfig["onlineStorageLimitGb"]`（`App.tsx:608`）。这是唯一被接受的 cast 场景——仅限表单 `<select>` 值。
- **可空性显式声明**：可能不存在的路径/URL 用 `string | null`（`currentPath`、`previewUrl`、`lastRunAt`）。

---

## 禁止项

- `any` —— 禁止引入；用 `unknown` + 类型守卫（参考 `isAppState`）。
- 不新增校验库——项目刻意保持没有。
- 不允许上表之外的 cast。
- 不放宽配置档位联合（如把 `onlineStorageLimitGb` 改成 `number`）——档位是 `CONTEXT.md` 里的产品决策。
