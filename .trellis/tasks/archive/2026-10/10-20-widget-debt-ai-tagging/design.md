# 技术设计

> 事实依据见 `research/findings.md`。四个阶段相互独立、可分别提交，但必须按序执行。

## Phase 1 — 工程还债

### 1.1 runtime.rs 拆分表

目标结构（`src-tauri/src/`，全部 `pub(crate)` 可见性，命令保持 `#[tauri::command] pub`）：

| 新文件 | 迁入内容（按 findings.md 行段） | 说明 |
|--------|-------------------------------|------|
| `state.rs` | 数据结构（OnlineSource/OnlineImage/OnlineSyncLog/AppState/ShortcutStatus 等）、`RuntimeState` + `load`、`persist`、`build_state*` | P3 的容错改这里 |
| `library.rs` | 文件夹命令、`inspect_folders`、`collect_candidates`、目录监听、`initial_scan`、image assets 命令 | 本地库域 |
| `wallpaper.rs` | `next/select/skip/favorite/paused/skipped` 命令族、`switch_to_next_wallpaper`、`record_wallpaper_history`、Win32 设置壁纸与显示模式（L3012+）、`delete_current_wallpaper` | 切换域（含 win32 细节） |
| `online.rs`（扩展现有文件） | 来源合并/内置来源、`run_online_source*`、UPX8 抓取、sync logs、在线图片命令 | 纯抓取逻辑已在 online.rs，把编排与命令并进去 |
| `widget.rs` | `widget_monitor_frame`、`position_floating_widget`、`set_widget_geometry`、`widget_set_expanded`、`widget_set_free_position` | P3 的布局持久化改这里 |
| `system.rs` | `start_background_tasks`、`start_directory_watcher`、autostart、全局快捷键、托盘、`run_due_tasks`、`hide_to_tray_on_close` | 系统集成域 |
| `lib.rs` | `run()`、setup、`generate_handler![...]`、`mod` 声明 | 仅组装 |

- 单测 `mod tests`（L2479-3011）按被测对象随迁；跨域测试集中放 `wallpaper.rs` 或保留于最相关模块。
- 迁移策略：**纯移动 + `use` 调整**，不改任何逻辑、不改签名；每迁完一个域跑一次 `cargo test`。
- `runtime.rs` 最终删除或仅留 `pub use` 重导出（倾向直接删除，`lib.rs` 引用各新模块）。

### 1.2 前端共享工具

```
src/shared/paths.ts   // samePath(pathA, pathB), pathName(path)
```

App.tsx、FloatingWidget.tsx 删除本地实现改导入；签名与现实现逐字一致（`/`→`\`、小写比较）。

### 1.3 CONTEXT.md 术语（草案）

- **浮动速控浮窗**：桌面常驻的速控小窗；收起为贴边小球或自由悬浮球，悬停/点击展开为当前壁纸速控卡片（上一张、下一张、暂停、跳过、喜欢、删除）。_Avoid_: 桌面挂件、悬浮球应用、独立应用
- **删除当前壁纸**：从浮窗对当前壁纸发起的删除；移入回收站，清理喜欢与跳过记录，并立即切换到下一张；删除前必须确认。_Avoid_: 静默删除、直接永久删除
- **自由悬浮与吸附**：浮窗的两种摆放状态；拖到屏幕左右缘 28px 内吸附收纳，其余位置保持自由悬浮常驻。_Avoid_: 强制吸顶、自动隐藏悬浮球

## Phase 2 — 浮窗闭环

- 卡片操作区从 4 键扩到 6 键：`暂停/恢复`（`Pause`/`Play` 图标，随 `state.paused` 切换文案与图标）、`跳过`（`SkipForward` 图标）。布局用现有 `widget-actions` 网格，两行三列。
- 复用 `run()` 包装 + `error` 内联提示；不新增确认步骤（跳过可随时在跳过列表恢复）。
- 收起态卡片内已展示 paused 文案，改为与新按钮状态一致。
- vitest：FloatingWidget 尚无测试，新增 `src/widget/FloatingWidget.test.tsx`（fake runtime 注入，参照 App.test.tsx 模式）覆盖：暂停/恢复按钮渲染与调用、跳过调用、错误提示。

## Phase 3 — 持久化统一 + 容错

### 3.1 布局迁入 AppConfig

```rust
// state.rs
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WidgetLayout { pub docked: Option<String>, pub x: Option<f64>, pub y: Option<f64> }
// AppConfig 增加 #[serde(default)] pub widget_layout: WidgetLayout
```

- 新命令：`get_widget_layout() -> WidgetLayout`、`set_widget_layout(layout) -> AppState`（走 `mutate_without_rescan` + `persist`）。
- 前端：`startGrab/endGrab` 落点处把 `persistLayout(localStorage)` 替换为 `invoke("set_widget_layout")`；启动恢复改为 Rust 侧 `position_floating_widget` 读取 `config.widget_layout` 直接定位（expanded=false 初态）。
- localStorage 迁移：Rust `load` 时若 `widget_layout` 为默认且存在迁移需求则忽略——旧 localStorage 值不做迁移读取（损失一次自定义位置，代价可忽略，PRD 已确认"读一次旧值后弃用"降级为直接弃用，实现取简）。

### 3.2 状态文件容错（state.rs `RuntimeState::load`）

```rust
Err(parse_error) => {
    let backup = directory.join(format!("{STATE_FILE_NAME}.corrupt-{}", timestamp()));
    let _ = fs::rename(&state_file, &backup);
    eprintln!("wallpaper-state.json 损坏已备份: {backup} ({parse_error})");
    AppConfig::default()
}
```

- 只对**反序列化失败**触发；`NotFound` 保持 default；其他 IO 错误仍然报错（磁盘故障不该静默重置）。

## Phase 4 — 本地 AI 打标

### 4.1 架构

```
[启用开关] → [模型就绪?] ─否→ [下载 model.onnx + text-embeds.bin → SHA-256 校验 → 缓存 config dir/models/]
                          ─是→ [后台打标队列：遍历未打标候选图 → ort 推理 → 写 AppConfig.image_tags → persist]
```

- **只跑图像编码器**：十分类的文本侧嵌入（每类多条中文/英文模板均值，L2 归一化）**离线预计算**为 `text-embeds.bin`（10×512 f32 ≈ 20KB），随模型一起下载。运行时零 tokenizer 依赖、零文本推理。
- 模型：CLIP ViT-B/32 图像编码器 int8 量化 ONNX，`ort` crate（CPU, 并行维度=1，避免抢占 UI）。**选型已钉死（2026-10-20，Phase 4a 实测验证）**：
  - ort：`2.0.0-rc.15`（2.x 系列均为 rc，最新版；默认 features 含 download-binaries，MSVC x64 编译链接验证通过）。Windows 预编译包仅有 directml 档：onnxruntime 静态链入、运行时依赖 `DirectML.dll`（随构建自动复制到产物旁，默认仍是 CPU 推理，DML 仅作为可选 EP 存在）。**坑**：本机 copy-dylibs 偶发把 DirectML.dll 复制成 0 字节导致进程 0xC0000020，需从 `%LOCALAPPDATA%/ort.pyke.io/dfbin/...` 手动复制真身；`cargo test` 42 用例全绿（含真实 int8 模型推理）。
  - 图像编码器：`Xenova/clip-vit-base-patch32` → `onnx/vision_model_int8.onnx`，88,648,877 字节，SHA-256 `0ab0c1b3ace708e539633af1744d5a95247fe4e14d3e08ff197ef82a6cb9bd93`（下载实测与 HF 报告大小一致）。URL 钉死 `https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_int8.onnx`（本机 huggingface.co 经代理不可达，hf-mirror 实际可下载；二者路径结构一致，可整域互换）。fp16 备选 `onnx/vision_model_fp16.onnx`（176,080,659 字节）。
  - text-embeds.bin：本机离线生成（Python 3.13 + onnxruntime 1.31 + tokenizers，脚本 `.workbuddy/tmp-models/gen_text_embeds.py`，模型 `onnx/text_model.onnx` fp32 254,058,553 字节，输出 `text_embeds` [batch,512]）。配方：10 类 ×（6 条通用英文模板 + game 类 3 条专项模板 "screenshot from a video game" 等）均值后 L2 归一化，10×512 f32 = 20,480 字节。产物已生成并经 19 张 UPX8 实图验证。
  - 准确性初评：UPX8 「游戏」19 张实测 top-1 11/19 = 57.9%（通用模板基线 7/19 = 36.8%，专项模板 +21pp）；未命中多为相邻「动漫」（UPX8 游戏图多为动漫画风，语义上可辩护）。其余 9 类无本地标注样本（UPX8 CDN 拒绝抓取），Phase 4b 需补全评测集再定精度档位；若不达标换 fp16。
- 新文件：`src-tauri/src/tagging.rs`（下载校验、推理、队列；已建骨架，钉死 URL/SHA 常量与最小 ort 推理验证测试）；`online.rs`/`library.rs` 仅提供候选列表。

### 4.2 数据与 IPC

```rust
pub struct ImageTag { pub path: String, pub category: String, pub confidence: f32, pub tagged_at: String }
// AppConfig: #[serde(default)] pub image_tags: Vec<ImageTag>
```

- 命令：`set_tagging_enabled(bool)`（触发模型下载/停止队列）、`get_tagging_status() -> {enabled, model_ready, progress}`、`rescan_tags()`。
- 新图入目录由现有目录监听触发增量打标；只处理未打标路径，重启续跑。

### 4.3 UI

- 设置页新增「智能分类」区：启用开关 + 模型下载进度/就绪状态 + 说明文案（本地推理、无遥测、首次需下载模型）。
- 本地图库与在线图片列表各加分类筛选下拉（全部/十分类/未打标），纯前端过滤现有列表数据。

### 4.4 风险

| 风险 | 应对 |
|------|------|
| int8 量化模型精度不足（动漫/抽象类易混） | 选型阶段先用样图离线评测十类准确率，低于预期换 fp16 或换 SigLIP 小模型 |
| ort 在 Windows MSVC 的编译体积/依赖问题 | 先加依赖跑 `cargo check` 验证可行性，失败则降级方案：调用 PowerShell/独立子进程 ONNX Runtime 共享库（作为备选，不改变数据模型） |
| 首次下载源不可达 | URL 常量集中一处，支持后续发版替换；下载失败错误透出设置页 |
