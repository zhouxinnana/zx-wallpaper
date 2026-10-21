# 目录结构

> 前端代码在本项目中的组织方式。

---

## 概览

ZX Wallpaper 是 **Tauri 2 桌面应用**（React 19 + TypeScript + Vite 6）。没有 HTTP 层——"后端"就是 Rust 的 Tauri IPC 命令。UI 代码刻意集中在一个文件里。

**记录的是现状，不是理想态**：UI 全部在约 800+ 行的 `src/App.tsx` 里。未经明确决策（见 `docs/trellis/README.md`）不得拆分、不得自行发明组件树。

---

## 目录布局

```
/
├── src/                      # 前端（React + TS）
│   ├── App.tsx               # 全部 UI：外壳、五个视图、表单、对话框、辅助函数
│   ├── App.test.tsx          # UI 测试（vitest + Testing Library）
│   ├── main.tsx              # React 入口，挂载 <App />
│   ├── vite-env.d.ts
│   ├── styles/               # CSS
│   └── runtime/              # IPC 绑定层（唯一允许接触 Tauri API 的地方）
│       ├── types.ts          # AppState / AppConfig / DesktopRuntime 接口
│       ├── tauri-runtime.ts  # createTauriRuntime：方法 -> invoke("command", args) 映射
│       └── tauri-runtime.test.ts
├── src-tauri/                # Rust 后端
│   └── src/
│       ├── main.rs           # 5 行，调用 lib::run()
│       ├── lib.rs            # Tauri builder：插件、托盘、invoke_handler 注册
│       ├── runtime.rs        # RuntimeState + 全部 #[tauri::command] + 测试
│       ├── domain.rs         # 领域规则（纯函数）+ 测试
│       ├── online.rs         # 在线来源抓取（UPX8 适配器）+ 测试
│       ├── image_assets.rs   # 图片资源协议 + 测试
│       └── preferences.rs    # 持久化
└── CONTEXT.md                # 领域术语表（中文）——权威词汇来源
```

---

## 模块组织

- **新增 IPC 相关功能** = 恰好改 4 个文件：
  1. `src-tauri/src/runtime.rs` —— 定义 `#[tauri::command]`
  2. `src-tauri/src/lib.rs` —— 加入 `tauri::generate_handler![...]`
  3. `src/runtime/types.ts` —— 扩展 `DesktopRuntime` 接口
  4. `src/runtime/tauri-runtime.ts` —— 映射为 `command("snake_case_cmd", { args })`
- **新领域规则 / 纯逻辑** → 放 `src-tauri/src/domain.rs`（或命令所属模块内可被 `#[cfg(test)]` 覆盖的纯函数），不要写在命令函数体里。
- **新 UI** → 写在 `App.tsx` 内部。当前不存在任何独立组件文件；新增组件文件需要明确理由。
- 前端不允许在 `src/runtime/` 之外 import `@tauri-apps/api`。

---

## 命名约定

- Rust 命令：`snake_case`（如 `skip_current_wallpaper`）；前端 invoke 参数用 `camelCase`（Tauri 自动转换：`{ folderId }` → `folder_id`）。
- 前端事件：带命名空间前缀的字符串，如 `app://state-changed`。
- 领域词汇：UI 文案与错误信息必须逐字使用 `CONTEXT.md`（中文）中的术语；避开其列出的 Avoid 词。

---

## 示例

- 完整 IPC 链路：`skip_current_wallpaper`（runtime.rs）→ `DesktopRuntime.skipCurrentWallpaper`（types.ts）→ `command("skip_current_wallpaper")`（tauri-runtime.ts）。
- 非命令的专用通道：图片加载走 `image_assets::PROTOCOL_NAME` 自定义协议（`lib.rs` 注册）。
