# 状态管理

> 本项目的状态管理方式。

---

## 概览

**不用状态库**（无 Redux / Zustand / React Query）。架构是**后端快照流**：

1. Rust 持有事实源（`RuntimeState`，经 `preferences.rs` 持久化）。
2. 每个变更类 IPC 命令返回**完整的 `AppState` 快照**（`Result<AppState, String>`）。
3. 后台推送的变化（扫描、定时抓取、下载）以 `app://state-changed` 事件到达，载荷为 `AppState`。
4. 前端用最后到达的快照整体替换唯一的状态原子。

---

## 状态分类

| 类别 | 位置 | 例子 |
|---|---|---|
| 服务端（后端持有）状态 | `state: AppState \| null` —— 唯一状态原子 | `folders`、`onlineSources`、`skippedPaths` |
| 纯 UI 状态 | `App` 内 `useState` | `view`、`busy`、`error`、`status`、`viewerPath`、`confirmOptions` |
| Ref（不参与渲染） | `useRef` | `busyRef`（防重入）、`statusTimerRef` |

服务端状态**没有本地副本**——表单控件直接 `value={state.xxx}` 绑快照（没有草稿对象、没有「保存」按钮；改动经 `updateConfig(patch)` 立即生效）。

---

## 流转规则

- 变更：处理器 → `run(key, () => api.command(args))` → 后端返回新 `AppState` → `setState(nextState)`（仅当 `isAppState(nextState)` 通过——命令可能返回 `null`，如 `revealWallpaper`）。
- 后台更新：`onStateChanged` 监听器做同样的 `setState`。
- 快照是整体对象，**不要**在客户端对旧 state 做 spread/patch 合并；信任最新快照。

---

## 常见错误

- 给配置值留本地可编辑副本 → 造成回声/覆盖 bug；直接绑 `state`。
- 客户端乐观修改 `state` → 下一个快照才是权威，乐观写会被冲掉。
- 在 `run()` 的 action 闭包里读 state —— 需要的值作为参数传进去；快照可能已经变了。
