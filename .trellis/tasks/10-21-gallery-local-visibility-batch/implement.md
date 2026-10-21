# 执行计划：统一图库 + 批量治理

> 前置：`prd.md` / `design.md` 评审通过后运行 `task.py start` 再开工。
> 每步结束后跑该步的验证命令；红则就地修，不进下一步。

## 步骤 0 · 基线

```bash
cd D:/code/zx-wallpaper
npm run typecheck && npm run test
cd src-tauri && cargo test
```

记录基线通过情况（本机 vitest 已固定 `pool: "vmThreads"`，勿改）。

## 步骤 1 · 后端：扫描补目录归属

1. `state.rs`：`LibraryScan` 增 `library_images: Vec<LibraryImage>`；新增 `LibraryImage { path, folder_id, folder_enabled }`。
2. `library.rs::inspect_folders`：现有逐目录循环内收集 path 时写入 `folder_id` / `folder_enabled`（停用目录也写，但**不进** `candidates`）。
3. `collect_candidates` / `initial_scan` 两处构造点补齐新字段；`initial_scan` 的本地图列表为空 Vec（首扫不枚举目录，与现有行为一致）。
4. `AppState` 增 `library_images`（camelCase `libraryImages`），`build_state_from_scan` 搬运。

验证：

```bash
cd src-tauri && cargo test library
```

新增单测：
- 两个目录（一启用一停用）→ `candidates` 只含启用目录的图，`library_images` 含两者且 `folder_enabled` 正确。
- 同一路径出现在两个目录 → `candidates` 去重，`library_images` 保留首条归属。

## 步骤 2 · 后端：批量命令

1. `wallpaper.rs` 新增 `batch_skip_paths` / `batch_restore_skipped` / `batch_favorite` / `batch_delete_paths`，内部拆出 `*_config(config, paths)` 纯函数便于单测。
2. 删除复用 `trash`（参照 `delete_skipped_file_with`）；批量失败收集后一次性 `Err`。
3. 删除集合含 `current_path` → 清空并 `switch_to_next_wallpaper`，失败时保持 `None`。
4. `lib.rs` 注册 4 个命令。

验证：

```bash
cd src-tauri && cargo test wallpaper
```

新增单测：
- `batch_skip_paths` 后 path 不在 `remaining_paths`，`skipped_paths` 含全部去重项。
- `batch_restore_skipped` 后重新进入队列。
- `batch_favorite(false)` 对不存在的路径幂等、不报错。
- 删除集合含当前壁纸：`current_path` 变成队列下一张；队列空时为 `None`。

## 步骤 3 · 前端：类型与导航改造

1. `runtime/types.ts`：`LibraryImage` 类型 + `AppState.libraryImages`；`View` 的 `"online"` → `"gallery"`。
2. `runtime/tauri-runtime.ts`：补 4 个方法的 `invoke` 映射。
3. `App.tsx`：导航标签改「图库」、副标题「浏览与治理」；`App` 的视图分发同步改名。

验证：

```bash
npm run typecheck
```

预期：类型错误集中在 `App.test.tsx` 的旧导航断言 —— 留到步骤 7 统一修，此处先确认无其他类型错误。

## 步骤 4 · 前端：GalleryView 只读版

1. 由现有 `OnlineView` 派生 `GalleryView`：来源 tab（`all` / `online` / 各 `folderId`）、文件名筛选、AI 分类筛选、grid 分页 + 懒加载 + prewarm。
2. 抽 `GalleryCard`：`kind === "online"` 走原卡片信息区，`kind === "local"` 显示文件名 + 目录 + 分类角标 + 状态角标（当前/已跳过/已喜欢）。
3. 「全部」按路径字典序合并去重，UI 标注「列表顺序与切换顺序无关」。
4. 停用目录 tab 带「已停用」标记。

验证：`npm run typecheck` + 手动 `npm run dev` 目视（本地目录图能出缩略图、能滚动加载）。

## 步骤 5 · 前端：多选与批量操作

1. 选择态 `Set<string>` + 卡片勾选框；切换来源/筛选时清空。
2. 批量栏：已选 N 张 / 全选可见 / 反选 / 清空 + 操作组（跳过、取消跳过、喜欢、取消喜欢、删除）。
3. 「设为壁纸」`selection.size > 1` 时禁用。
4. 批量删除 → `openConfirm`，文案含数量，走回收站。
5. 操作后清空选择，列表随 `AppState` 刷新。

验证：`npm run typecheck`；手动走一遍 PRD 的 4 条批量验收项。

## 步骤 6 · 前端：入口与折叠区

1. `FolderRow` 增加「查看 N 张」→ 跳图库并预选该目录（`App` 层传 `initialSource`）。
2. 存储概览 / 抓取来源 / 同步日志移入图库页底部折叠 section，功能与文案原样搬运。

验证：手动 — 目录行点击跳转正确；在线来源管理、同步日志、存储数字均正常。

## 步骤 7 · 测试

```bash
npm run test        # 修 App.test.tsx 导航断言 + 新增图库用例
npm run typecheck
```

新增前端用例：
- 来源 tab 渲染出每个本地目录（含停用标记）。
- 勾选 2 张 → 「设为壁纸」disabled；勾选 1 张 → 可点。
- 批量跳过 → 调用 `batchSkipPaths` 且入参为所选路径。
- 批量删除 → 弹确认框，确认后调用 `batchDeletePaths`。
- 千张：分页只渲染首页节点数（参考既有 `MockIntersectionObserver`）。

## 步骤 8 · 全量收尾检查

```bash
npm run build && cd src-tauri && cargo test
```

外加 design.md 的测量项：

- 本地目录放入 ≥1000 张图，记录单次 `mutate`（切一张壁纸）的耗时与 `AppState` JSON 体积。
- 超过 30 ms 或 400 KB → 触发退化路径（按需命令），在 `prd.md` 备注后重走步骤 1/4。

## 评审门禁

| 门禁 | 时机 |
|---|---|
| 三产物评审 | `task.py start` 之前 |
| 每步验证命令全绿 | 进入下一步之前 |
| 全量测试 + 测量项 | 提交之前 |
| 删除路径人工复核 | 步骤 5 完成后，确认无永久删除分支 |

## 回滚点

- 步骤 1–2（后端）与步骤 3–7（前端）各自独立可回滚；后端先合不影响前端。
- 任一步骤验证连续两次失败 → 回退该步骤改动，回到 `design.md` 复核契约。
