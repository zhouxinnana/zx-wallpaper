# 现状研究（2026-10-20）

> 本文件是规划阶段的事实清单，实施阶段以这里记录的行号/结构为出发点（行号以当天工作区为准，重构后失效）。

## 1. runtime.rs 结构盘点（3170 行）

按功能域分段的函数分布：

| 行段 | 职责 | 关键项 |
|------|------|--------|
| 1-321 | 数据结构 + RuntimeState | `OnlineSource`/`OnlineImage`/`OnlineSyncLog`/`AppState`/`ShortcutStatus`/`RuntimeState::load`（L289） |
| 322-555 | 系统集成 | `start_background_tasks`、`start_directory_watcher`、`synchronize_system_integration`、autostart、全局快捷键、`hide_to_tray_on_close`、托盘触发的 next/skip/pause |
| 556-577 | 调度 | `run_due_tasks`（到期的自动切换 + 在线抓取） |
| 578-653 | 在线来源合并 | `built_in_sources`、`merge_online_sources`、UPX8 分类状态 |
| 654-782 | 浮窗 + 删除当前壁纸 | `widget_monitor_frame`、`position_floating_widget`、`set_widget_geometry`、`widget_set_expanded`、`widget_set_free_position`、`delete_current_wallpaper` |
| 784-1130 | 主窗口命令 | 文件夹增删改、`next_wallpaper`、`select_wallpaper`、`skip_current_wallpaper`、`toggle_favorite`、skipped 系列、`toggle_paused`、`update_preferences` |
| 1131-1538 | 在线同步编排 | `run_online_source(_impl)`、UPX8 分类抓取、sync logs |
| 1539-1679 | 在线图片命令 + 图片资产 | `set_online_image_as_wallpaper`、`delete_online_image`、`get_image_asset` 等 |
| 1680-1970 | mutate/persist 及辅助 | `mutate` 系列、`persist`、在线目录迁移 |
| 1974-2470 | 扫描/切换/历史辅助 | `inspect_folders`、`collect_candidates`、`record_wallpaper_history`、`switch_to_next_wallpaper` 等 |
| 2474-2478 | `same_path` | Rust 侧路径比较 |
| 2479-3011 | `#[cfg(test)] mod tests` | 单文件单测模块，覆盖混合域 |
| 3012-3170 | Win32 壁纸设置 | `set_desktop_wallpaper`、显示模式注册表、IActiveDesktop |

## 2. 状态加载容错点（真实风险）

`RuntimeState::load`（runtime.rs L298-303）：

```rust
match fs::read_to_string(&state_file) {
    Ok(contents) => serde_json::from_str(&contents)
        .map_err(|error| format!("Unable to read saved wallpaper settings: {error}"))?,  // ← 解析失败 = 启动失败
    Err(NotFound) => AppConfig::default(),
    Err(error) => return Err(...),
}
```

- 本机曾出现 `wallpaper-state.json` 64697 字节全零 → `serde_json::from_str` 必失败 → 应用无法启动。
- 容错方案：解析失败时把损坏文件改名保留（`wallpaper-state.json.corrupt-<时间戳>`），按 `AppConfig::default()` 重建。

## 3. 浮窗闭环缺口

- 后端命令**已存在**：`toggle_paused`、`skip_current_wallpaper`；前端 runtime 层已有 `tauriRuntime.togglePaused()` / `skipCurrentWallpaper()`。浮窗缺的只是两个按钮 + 交互细节。
- 「跳过当前壁纸」语义（CONTEXT.md）：加入跳过列表 + 立即切下一张，≠ 删除。

## 4. 持久化双轨

- 其余全部设置：Rust 侧 `AppConfig` → `wallpaper-state.json`（`persist()` L1839）。
- 浮窗布局：前端 localStorage `zx-widget-layout-v1`（FloatingWidget.tsx L13），结构 `{ docked: "left"|"right"|null, x?, y? }`。
- 迁移方案：布局进 `AppConfig`，新增 IPC 读/写命令；启动时 Rust 侧直接按已存布局定位浮窗（比 webview 恢复更早、无闪烁）。

## 5. 前端重复代码

- `samePath`：App.tsx 与 FloatingWidget.tsx 各一份（实现一致：`/`→`\` + 小写比较）。
- `pathName`：同上两份。
- 目标：抽 `src/shared/paths.ts`，两窗口共用。

## 6. AI 打标技术约束

- 环境：Windows、Tauri v2、Rust 后端；无 GPU 依赖要求。
- 分类体系：跟随 UPX8 十分类（风景/动漫/游戏/动物/城市/抽象/宇宙/汽车/美女/运动），与在线来源口径对齐。
- 模型路线（design.md 详述）：CLIP ViT-B/32 int8 量化 ONNX + ort crate，零样本分类；首次启用下载、SHA-256 校验、缓存于 app config dir。
- 注意：`cargo check` 首次新增依赖约 5 分钟（本机已知）；vitest 固定 `pool: "vmThreads"` 勿改。

## 7. 测试基线

- 前端 vitest：34 用例（App.test.tsx 669 行，注入 fake runtime）。
- Rust：runtime.rs 内 `mod tests`；`cargo check`/`cargo test` 均可用。
- 门禁：tsc + vite build + vitest + cargo check 全绿。
