# 浮窗闭环 + 工程还债 + 持久化统一 + 本地 AI 打标

## Goal

四阶段交付，顺序固定（先地基后功能）：拆分 runtime.rs 并去重前端路径工具、补齐 CONTEXT.md 术语 → 浮窗补暂停/恢复与跳过当前 → 浮窗布局迁至 preferences 并加固状态文件容错 → 本地 ONNX 图片自动分类打标（V1 仅数据 + 筛选入口）。

## Background

- 浮动速控浮窗已落地（可拖拽、贴边吸附、展开卡片），但卡片只有 上一张/下一张/喜欢/删除，缺 暂停/恢复 和 跳过当前。
- `src-tauri/src/runtime.rs` 3170 行混五职责；`samePath`/`pathName` 在 App.tsx 与 FloatingWidget.tsx 双份。
- 浮窗布局存 localStorage，与其余设置的 preferences 轨道不一致。
- `RuntimeState::load` 在状态文件损坏（曾出现全零）时直接启动失败。
- 「每日推荐」「Bing 来源」经讨论明确不做。

## Requirements

### Phase 1 — 工程还债（行为零变化）

1. runtime.rs 按域拆分为多个模块（见 design.md 拆分表），`lib.rs` 仅保留组装与命令注册。
2. 前端新建 `src/shared/paths.ts`（`samePath`、`pathName`），App.tsx 与 FloatingWidget.tsx 改为共用导入，删除本地副本。
3. CONTEXT.md 增补术语：浮动速控浮窗、删除当前壁纸、自由悬浮与吸附（含 _Avoid_ 词，风格与现有条目一致）。

### Phase 2 — 浮窗闭环

4. 浮窗卡片新增「暂停/恢复」按钮：调用现有 `toggle_paused`；按钮态随 `AppState.paused` 实时反映；文案/图标区分暂停与恢复。
5. 浮窗卡片新增「跳过当前」按钮：调用现有 `skip_current_wallpaper`（排除出循环 + 立即切下一张），**必须与删除明确区分**（删除走确认语义，跳过不弹确认）。
6. 操作失败在浮窗内联提示（复用现有 `error` 状态），不弹系统对话框。

### Phase 3 — 持久化统一 + 容错

7. 浮窗布局（docked/x/y）迁入 `AppConfig`，新增读写 IPC；浮窗拖拽落点/吸附时写回；localStorage 布局逻辑删除，首次迁移读取一次旧值后弃用。
8. 启动时浮窗定位改由 Rust 侧按已存布局执行（webview 恢复逻辑随之简化）。
9. `RuntimeState::load` 容错：反序列化失败时将损坏文件改名为 `wallpaper-state.json.corrupt-<时间戳>` 保留，按 `AppConfig::default()` 重建，应用正常启动。

### Phase 4 — 本地 AI 打标（V1）

10. 零样本图像分类：CLIP ViT-B/32 int8 量化 ONNX + `ort` crate，CPU 推理；模型首次启用时下载（固定 URL + SHA-256 校验），缓存于 app config dir，**不打包进安装包**。
11. 分类体系：UPX8 十分类（风景/动漫/游戏/动物/城市/抽象/宇宙/汽车/美女/运动）；每图存 top 类别 + 置信度。
12. 打标范围：本地壁纸目录候选 + 受管在线目录；结果存 `AppConfig`（路径 → 标签），随状态持久化。
13. V1 UI：本地图库列表与在线图片列表各加一个分类筛选入口（含"未打标/全部"）；**不改随机循环逻辑**。
14. 隐私边界：推理全程本地，无任何遥测；模型下载是唯一网络行为且仅在用户启用功能时发生。

## 约束

- 全程遵循 `.trellis/spec/frontend/` 既有规范（目录结构、类型镜像、质量门禁）。
- 删除语义一律走回收站 + 确认（CONTEXT.md 约定）；跳过 ≠ 删除。
- vitest `pool: "vmThreads"` 不改；cargo 新增依赖后首次 check 会慢，属预期。
- Phase 1 完成前不开始 Phase 2/3/4 的代码改动（Phase 4 的模型选型调研可并行）。

## Acceptance Criteria

- [ ] P1：`cargo check`/`cargo test` 全绿；运行行为与拆分前一致（手动冒烟：切换/托盘/浮窗/在线抓取）；runtime.rs 不再含业务实现（仅允许组装/重导出）；tsc + vitest 全绿且无重复定义。
- [ ] P1：CONTEXT.md 三条新术语落盘，含 _Avoid_ 行。
- [ ] P2：浮窗可暂停/恢复（状态与主窗口同步），可跳过当前（跳过列表出现该图且壁纸已切换）；vitest 覆盖两个按钮的渲染与调用。
- [ ] P3：拖拽落点后重启，浮窗位置恢复；清空 localStorage 不影响布局；损坏的 wallpaper-state.json（手工写入全零）不再阻止启动，且生成 .corrupt 备份。
- [ ] P4：启用后模型下载校验通过；本地库与在线图完成一轮打标；两个列表可按分类筛选；断网后打标与筛选仍可用；关闭功能后无任何网络请求。
- [ ] 全程：既有 34 个 vitest 用例与 Rust 单测不回归（允许随模块搬迁而调整导入）。

## Out of Scope

- 按分类自动切换、场景集合、每日推荐（下一期）。
- 动态壁纸、每屏独立壁纸（CONTEXT.md 明确 out of scope）。
- 模型训练/微调。
