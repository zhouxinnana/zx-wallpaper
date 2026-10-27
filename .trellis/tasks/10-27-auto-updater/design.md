# 设计：自动更新

## 决策

### D1 前端走 `src/runtime/` 封装，不新增 IPC 命令

`plugin-updater` 的 JS API 本身就是 Tauri API。项目规范要求「Tauri API 只能出现在 `src/runtime/`」，但也没必要为了统一再在 Rust 侧包一层 `check_update` 命令 —— 那要把 `Update` 句柄跨 IPC 持有，还得自己做进度事件，纯属增加状态。

做法：`types.ts` 扩 `DesktopRuntime` 接口两个方法，`tauri-runtime.ts` 内 `import` 插件实现，其它层照旧只认接口。

```ts
export interface AppUpdateInfo {
  version: string;        // 远端版本号
  currentVersion: string;
  notes: string | null;
  date: string | null;
}
export interface AppUpdateProgress { downloaded: number; total: number | null }
```

`checkUpdate(): Promise<AppUpdateInfo | null>` —— `null` 表示无更新或当前不是桌面环境。
`installUpdate(onProgress?): Promise<void>` —— 内部复用 `checkUpdate` 缓存的 `Update` 句柄，下载安装完调 `relaunch()`。

### D2 依赖可注入，避免 mock 模块

`tauri-runtime.test.ts` 现有模式是给 `createTauriRuntime(bindings)` 注入 fake。updater 同样处理：`TauriBindings` 增加可选 `updater` 字段，缺省时才 `import` 真插件。

```ts
export interface UpdaterBindings {
  check(): Promise<PendingUpdate | null>;   // 插件 Update 的最小投影
  relaunch(): Promise<void>;
}
```

好处：测试零 mock、插件包加载失败也不影响其它用例。

### D3 自动检查不弹窗，不自动装

启动后 `AUTO_CHECK_DELAY_MS = 8000` 静默 `checkUpdate()`：

- 失败（离线 / GitHub 不可达）→ **不写 error 状态**，只记录 `updateMessage = null`，避免每次开机弹红条。
- 有更新 → `updateInfo` 落到 App 状态，设置页「更新」面板显示「发现新版本 vX.Y.Z」+「立即更新」；顶栏版本号旁加小圆点提示。
- 用户点击安装 → `ConfirmDialog` 二次确认 → 安装（进度条）→ 重启。

理由：本应用常驻后台切壁纸，静默重启会打断用户；网络抖动在国内容易发生，不能当错误报。

### D4 状态归属

更新状态是**会话态**，不进 `AppState`（后端快照流），不落盘。App 顶层 `useState` 持有，通过 props 传给 `SettingsView`。符合 `state-management.md`「后端快照只装后端拥有的状态」。

### D5 版本单一来源不动

`package.json` → `tauri.conf.json:version` → tag `tauri-v{x}`。updater 的 semver 比对与现有 CI 的 tag 校验天然一致，不改现有发版流程。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.createUpdaterArtifacts`；`plugins.updater` |
| `src-tauri/Cargo.toml` | 两个插件依赖，挂 `desktop` feature |
| `src-tauri/src/lib.rs` | 两行 `.plugin(...)` |
| `src-tauri/capabilities/default.json` | `updater:default`、`process:allow-restart` |
| `package.json` | `@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process` |
| `src/runtime/types.ts` | 两个类型 + `DesktopRuntime` 两方法 |
| `src/runtime/tauri-runtime.ts` | `UpdaterBindings` + 实现 |
| `src/App.tsx` | 更新状态、自动检查、`SettingsView` 更新面板、`createDefaultRuntime` 补桩 |
| `src/App.test.tsx` | fake runtime 补两方法 |
| `.github/workflows/release-tauri.yml` | `tauri-action` + 密钥 env |
| `.gitignore` | `*.key` / `*.pem` |

## 风险

| 风险 | 处置 |
|---|---|
| 私钥泄露 / 丢失 | 私钥只进 Secrets；`.gitignore` 兜底；文档写明备份要求 |
| 老版本用户无法自动更新 | Release notes 明确要求手动装首个带 updater 的版本 |
| GitHub 不可达 | 失败静默；endpoint 留数组位便于后续加镜像 |
| `perMachine` 安装导致静默更新失败 | 显式 `installMode: "passive"` |
| 动态加载插件在 `tauri://` 下失败 | 用静态 import，构建期由 Vite 打进主 chunk |
