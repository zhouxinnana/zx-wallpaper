# 技术设计：统一图库 + 批量治理

## 1. 边界

改动集中在三条链路：

| 层 | 文件 | 性质 |
|---|---|---|
| 扫描 | `src-tauri/src/library.rs`、`src-tauri/src/state.rs` | 候选路径补「目录归属」，新增派生字段下发 |
| 命令 | `src-tauri/src/wallpaper.rs`、`src-tauri/src/lib.rs` | 新增 4 个批量命令并注册 |
| 视图 | `src/App.tsx`、`src/runtime/types.ts`、`src/runtime/tauri-runtime.ts`、`src/styles/app.css` | `online` 视图改造为 `gallery`，加来源 tab / 多选 / 批量栏 |

**不改**：`online.rs` 抓取与去重逻辑、`preferences.rs` 队列算法、`domain.rs` 身份口径、`tagging.rs` 打标流程。

## 2. 数据模型

### 2.1 后端

`LibraryScan`（`state.rs:29`）只剩扁平 `candidates: Vec<String>`，无目录归属。在线图库能列表化，是因为 `onlineImages` 自带 metadata；本地图没有这层记录，必须由扫描补齐。

```rust
pub(crate) struct LibraryScan {
    pub(crate) folder_statuses: HashMap<String, FolderStatus>,
    pub(crate) candidates: Vec<String>,           // 保持原语义：仅 enabled 目录，供队列/打标使用
    pub(crate) library_images: Vec<LibraryImage>, // 新增：全部目录（含停用）的图片归属
}

pub(crate) struct LibraryImage {
    pub path: String,
    pub folder_id: String,
    pub folder_enabled: bool,
}
```

- `inspect_folders` 已在按目录循环，逐目录收集 path 时顺手写入 `folder_id`，**不新增遍历**。
- `candidates` 语义不变 → `tagging.rs`（8 个 `collect_candidates` 调用方之一）与 `refresh_rotation_queue` 零改动。
- 停用目录的图只进 `library_images`，不进 `candidates`：可浏览，不参与轮转。

`AppState`（`state.rs:232`）新增 `library_images: Vec<LibraryImage>`（camelCase → `libraryImages`），在 `build_state_from_scan` 中从 scan 直接搬运。

**体积权衡**：本地 1000 张、平均路径 80 字节 ≈ 80 KB，随每次 `mutate` 全量序列化，可接受。5000 张 ≈ 400 KB，切换壁纸时会明显。决策：先随 `AppState` 全量下发（与 `onlineImages` 同模式，保持单一数据源），在 `implement.md` 中加一条测量项；若实测单次 mutate 序列化 > 30 ms，退化为按需命令 `list_library_images(folder_id)`，届时只影响前端取数入口。**实测（2026-10-21，`state::app_state_stays_within_the_thousand_image_budget`）**：1000 张本地图 +`libraryImages` 的 `AppState` JSON 为 **97 KB**，`build_state_from_scan` 耗时 **199 µs**，远低于 30 ms / 400 KB 阈值 → **不退化**，保持全量下发。该测试留在单测里做长期回归护栏。

### 2.2 前端

`OnlineImage` 与 `LibraryImage` 字段不对等（在线有 width/height/downloadedAt/sourceId，本地只有 path/folderId）。用判别联合，禁止用假数据补齐：

```ts
type GalleryItem =
  | { kind: "online"; path: string; online: OnlineImage }
  | { kind: "local"; path: string; folderId: string; folderEnabled: boolean };
```

来源 id 约定：`"all"` / `"online"` / 实际 `folderId`。与现有 `sourceFilter` 的字符串 id 风格一致。

**「全部」的排序**：按规范化路径字典序（与「顺序」切换模式同口径），并在 UI 明确标注「列表顺序与切换顺序无关」——避免用户把浏览视图误读为队列。

## 3. 命令契约

全部返回 `AppState`，走既有 `mutate` / `mutate_with_cached_scan`，保证单次调用内完成「改配置 → 重扫 → 重建队列 → persist」。

| 命令 | 入参 | 行为 |
|---|---|---|
| `batch_skip_paths` | `paths: Vec<String>` | 去重后并入 `skipped_paths`；从 `remaining_paths` 移除；当前壁纸不动 |
| `batch_restore_skipped` | `paths` | 从 `skipped_paths` 移除；`rescan_config` 重建队列 |
| `batch_favorite` | `paths`, `favorite: bool` | 批量增删 `favorite_paths`；已存在/不存在时幂等 |
| `batch_delete_paths` | `paths` | 逐张 `trash::delete`；清理 favorite/skipped/history；若含 `current_path` 则 `switch_to_next_wallpaper` |

要点：

- **跳过 ≠ 删除**（CONTEXT.md 口径）：`batch_skip_paths` 只写 `skipped_paths`，不碰磁盘。
- **删除必须走 `trash` crate**，复用 `wallpaper.rs:328 delete_skipped_file_with` 的既有做法；不新增永久删除分支。
- **部分失败语义**：逐张执行，收集失败路径；全部处理完后若失败非空返回 `Err("N 张删除失败：<首条原因>")`，但已成功的变更仍保留并已 persist（与 `deleteAllSkipped` 一致）。前端通过既有 `run()` 的错误通道提示。
- **当前壁纸被删**：先删集合，再把 `current_path` 置空并切下一张；`switch_to_next_wallpaper` 失败（无可用图）时保持 `current_path = None`，由 UI 显示空态。
- 批量喜欢/取消喜欢不触发重扫（`mutate_without_rescan`），只改配置。

## 4. 前端结构

```
View: "online" → "gallery"，导航标签「图库」/ 副标题「浏览与治理」
GalleryView（两栏：主区图库 + 右侧栏信息）
├─ 来源 tab（全部 / 在线 / 目录…，停用目录带「已停用」标记）
├─ 筛选行（文件名输入 + AI 分类下拉，含「未分类」）
├─ 批量栏（常驻：已选 N 张 / 全选本页 / 全选筛选结果 / 反选本页 / 清空 / 批量操作按钮组）
├─ grid（真分页 + IntersectionObserver 懒加载 + 缩略图预热）
├─ 分页栏（页码导航 + 每页张数 24/48/96/192）
└─ 右侧栏 side-panel
   ├─ 存储概览（三格紧凑：已占用 / 已下载 / 请求分辨率）
   └─ 折叠区：抓取来源 / 同步记录（<details>，默认折叠）
```

- 卡片抽成 `GalleryCard`，内部按 `item.kind` 走在线/本地两种信息区，动作按钮共用。
- 选择态 `Set<string>`（规范化 path key）；**切换来源或筛选时清空选择**，避免对不可见项误操作。
- 「设为壁纸」在 `selection.size > 1` 时 `disabled`，与 PRD R4 一致。
- 批量删除走既有 `ConfirmDialog` + `openConfirm`，文案带数量。
- 工作台 `FolderRow` 增加「查看 N 张」→ `onNavigate("gallery", { source: folderId })`。

### 4.1 图库交互契约（本轮补齐）

**卡片本体可点选**：整卡 `onClick` 切换选中；复选框 label 与 `.image-actions` 容器 `stopPropagation`，避免一次点击触发两次切换。

**左键按压框选（marquee）**：
- 容器 `onMouseDown` 记录起点（容器相对坐标 + 视口坐标 + 按下时命中的 `data-gallery-path`）；`button !== 0` 或落在 `button/input/label/a` 上时不启动。
- `window` 级 `mousemove` 画矩形，累计位移 < 4px 视为点击不启动框选；`window` 级 `mouseup` 用 `getBoundingClientRect` 相交判定命中卡片。
- `Ctrl`/`Cmd` 为追加模式（否则覆盖选择）。
- **拖拽余波**：框选结束后浏览器补发的 `click` 会把起点卡片反选。用**坐标比对**排除——`pointerDownRef` 记录按下坐标，`handleCardClick` 比较 click 坐标，差 >2px 判为拖拽余波并忽略（不用布尔标志/时间窗，避免吞掉后续真实点击）。

**分页取代无限滚动**：原设计「分页 60/页」落地为**真分页**（`page` / `pageSize` state，默认 48，可选 24/48/96/192），`totalPages = ceil(n / pageSize)`，`pageItems = slice(...)`；页码栏显示「第 X / Y 页 · 共 N 张」+ 首尾/邻近页码 + 省略号。切换来源/筛选/页大小重置到第 1 页；prewarm 范围 = 当前页 + 下一页。
- 理由：网格列数自适应（4 列窄屏 2 列），虚拟列表需固定行高与列数，代价高且易错；真分页让 DOM 节点数恒定（千张 ≈ 48 节点），滚动长度可控。
- 来源 tab 需过滤 `folder.id !== "online-library"`：受管在线目录由 `config.online_directory` 单独管理，不是用户目录，不应作为来源 tab。

## 5. 兼容性

- `libraryImages` 是派生数据，**不写入 `wallpaper-state.json`**，无状态迁移，旧状态文件可直接加载。
- `LibraryScan` 新增字段是 `pub(crate)`，只影响 crate 内构造点（`library.rs` 3 处、`state.rs` 若干测试），编译器会全部报出。
- `View` 类型改名会影响 `App.test.tsx` 中按导航文本/位置的断言，需同步更新。
- 无 API 版本、无数据库、无迁移脚本。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 批量删除误操作 | 只能通过勾选触发；确认框写明张数；走回收站可还原 |
| 千张目录卡顿 | 分页 60/页 + 懒加载 + prewarm 限流（沿用在线图库参数），验收项含千张场景 |
| AppState 膨胀 | 上述体积权衡 + implement 阶段测量项 + 既定退化路径 |
| 「看到的 ≠ 轮转的」误解 | 「全部」按路径序，UI 标注与切换顺序无关；来源 tab 不承诺队列语义 |
| 两套卡片语义分裂 | 单一 `GalleryCard` + `kind` 分支，不维护两套样式 |

## 7. 上线与回滚

单 PR、单合并单元。回滚 = `git revert`，无数据迁移、无向后兼容负担。
