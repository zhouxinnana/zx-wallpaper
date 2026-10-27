# 技术设计：在线来源定时同步支持选择分类

## 1. 边界与契约

### 1.1 数据契约（Rust，`src-tauri/src/state.rs`）

`OnlineSource` 新增字段：

```rust
/// 定时同步参与的 UPX8 分类 key。空表示全部（含未来新增分类）。
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub sync_categories: Vec<String>,
```

- serde 已 `rename_all = "camelCase"` → IPC/落盘键名 `syncCategories`。
- `#[serde(default)]` + `skip_serializing_if` → 旧配置读入为空 Vec；全选时不写盘（canonical form）。
- 降级安全：`AppConfig` / `OnlineSource` 都没有 `deny_unknown_fields`（`state.rs:150-152`、`state.rs:57-58`），旧版本应用读到新字段只忽略。

### 1.2 前端契约（`src/runtime/types.ts`）

```ts
export interface OnlineSource {
  // ...
  /** 定时同步参与的 UPX8 分类 key；缺省/空表示全部。 */
  syncCategories?: string[];
}
```

与 `categoryStatuses?` 保持同样的可选风格（后端 `skip_serializing_if` 时不出现）。

## 2. 语义与核心函数

### 2.1 canonical form（关键决策）

- `[]`（或字段缺省）= 全部 10 类，且自动包含未来新增分类。
- 归一化时，**若选择集合等于全集，收敛为 `[]`**。理由：让「默认」「用户全选」只有一种存储形式，`skip_serializing_if` 才有意义，也免去「10 项 vs 空」两种等价状态的比较负担。

### 2.2 新增纯函数（`src-tauri/src/online.rs`）

```rust
/// 宽容归一化：过滤未知 key、去重、按 UPX8_CATEGORIES 顺序排序；全集收敛为空。
pub(crate) fn normalize_sync_categories(categories: &[String]) -> Vec<String>

/// 严格校验：供命令入口使用，含未知 key 返回 Err("UPX8 分类不存在。")。
pub(crate) fn validate_sync_categories(categories: &[String]) -> Result<Vec<String>, String>

/// 定时同步实际要请求的分类；空配置回退全量。返回 key 列表。
pub(crate) fn due_sync_category_keys(source: &OnlineSource) -> Vec<String>

/// 把一次来源设置变更落到 config（命令体只做转发，逻辑可测）。
pub(crate) fn apply_source_settings(config: &mut AppConfig, source: &OnlineSource) -> Result<(), String>
```

`apply_source_settings` 复制现 `update_online_source` 闭包里的逻辑（id 校验、interval 白名单钳制），并新增：
```rust
saved.sync_categories = validate_sync_categories(&source.sync_categories)?;
```

### 2.3 归一化时机

| 位置 | 函数 | 策略 |
|---|---|---|
| 读盘合并 `merge_online_sources`（`online.rs:513-538`） | `normalize_sync_categories` | 宽容：脏 key 直接丢弃，绝不因配置脏而失败 |
| 写入 `update_online_source` | `validate_sync_categories` | 严格：非法 key 上抛中文 Err，与 `run_upx8_category` / `upx8_request_url` 一致 |

## 3. 数据流

```
用户勾选分类 (App.tsx SourceRow)
  └─ run(`source-<id>`, api.updateOnlineSource({ ...source, syncCategories }))
       └─ update_online_source → apply_source_settings → validate → persist
                                                                  ↓
后台循环 system.rs::start_background_tasks（30s 一轮）
  └─ run_due_tasks → due_source_ids（只看 enabled + next_run_at）
       └─ run_online_source_impl(app, state, id, None, /*manual=*/false)
            └─ category_key == None && !manual → due_sync_category_keys(&source)
                 └─ fetch_upx8_categories(选中的 key) → start_online_sync_logs(选中的 key)
```

关键改动点：`online.rs:622-630` 的三元表达式改为三分支：

```rust
let category_keys = match category_key {
    Some(key) => vec![key],
    None if manual => all_upx8_category_keys(),   // 手动「同步全部」：仍全 10 类
    None => due_sync_category_keys(&source),      // 定时：只跑选中分类
};
```

## 4. 未选中分类的状态保持（R2 / R6）

现有实现天然满足，只需不改：

- `start_online_sync_logs` 只按 `category_keys` 建日志 → 未请求分类不产生「本轮 running」记录（R6）。
- 完成时 `for category in &category_results` 只覆盖请求过的分类条目，其余保持上一轮值（R2 第三条）。
- `normalize_upx8_category_statuses`（`online.rs:497-511`）以 `default_upx8_category_statuses()` 为骨架、逐项回填 saved 值 → 不重置计数；新增字段不改变该行为。
- `update_source_result`（`online.rs:1177-1195`）仍写全量合计 `last_discovered` / `last_downloaded` / `next_run_at`。语义为「本轮（选中的分类）合计」，与来源卡片上的 `N 发现 · M 下载` 一致，不改。

`online.rs:618-620` 的 `if !source.enabled && !manual { return Err(...) }` 保持不变。

## 5. 前端设计（`src/App.tsx::SourceRow`，`App.tsx:881-897`）

### 5.1 有效选择解析

```ts
const allCategoryKeys = upx8Categories.map((category) => category.key);
const syncCategories = source.syncCategories?.length ? source.syncCategories : allCategoryKeys;
```

空/缺省 → 全选（与后端 canonical form 一致，UI 上「全勾选」）。

### 5.2 分类行

在 `.source-category` 左侧 `div` 前插入 checkbox：

```tsx
<label className="source-category-sync">
  <input
    type="checkbox"
    aria-label={`定时同步 ${category.label}`}
    checked={isSynced}
    disabled={busy !== null || (isSynced && syncCategories.length === 1)}
    onChange={() => toggleSyncCategory(category.key)}
  />
</label>
```

`toggleSyncCategory`：
```ts
const next = isSynced ? syncCategories.filter((key) => key !== key0) : [...syncCategories, key0];
if (next.length === 0) return;                       // 双保险，UI 已 disabled
void run(`source-${source.id}`, () => api.updateOnlineSource(nextSource({ syncCategories: next })));
```

### 5.3 网格顶部提示行

```tsx
<div className="source-category-summary">
  <span>定时同步 {syncCategories.length}/{upx8Categories.length} 类{syncCategories.length === 1 ? " · 至少保留 1 个分类" : ""}</span>
  {syncCategories.length < upx8Categories.length && (
    <button type="button" className="action-button is-small" aria-label="定时同步全部纳入" disabled={busy !== null}
      onClick={() => void run(`source-${source.id}`, () => api.updateOnlineSource(nextSource({ syncCategories: allCategoryKeys })))}>全部纳入</button>
  )}
</div>
```

「至少保留 1 个分类」只在 N=1 时出现，满足 PRD R5 的可见提示，且不新增对话框。

### 5.4 复用约束

- 所有写入仍走 `run(key, action)`（`App.tsx:168`），不直接调 `api.*`。
- 不新建组件文件、不加状态库（`component-guidelines.md` 禁止项）。
- 新增样式只追加到 `src/styles/app.css` 的 `.source-category*` 区块附近，沿用现有 token（`rgba(255,255,255,.06)` 分隔线、11px/10px 字号）。

## 6. 兼容性与迁移

| 场景 | 行为 |
|---|---|
| 旧配置文件（无 `syncCategories`） | 读入空 → 全部，无迁移代码 |
| 旧版本应用 + 新配置 | 忽略未知字段，仍有 `enabled`/`intervalHours` 可用 |
| 用户全选后保存 | 归一化收敛为 `[]`，落盘不出现该键 |
| 用户选 9 个 | 落盘 9 个 key |
| 未来新增第 11 类 | 选 `[]`/`[10 项]` 升级后会自动包含；选子集不含 |

## 7. 权衡与放弃项

- **放弃「定时任务独立开关」**：`enabled` 已完成此事，双层开关会引入「启用但不抓」的新状态需要额外文案与状态位。
- **放弃「黑名单（排除某些分类）」**：白名单 + 空即全部的语义已经能表达同一集合，且与 `skip_serializing_if` 兼容。
- **放弃在 `last_discovered` 上区分选中/未选中**：现有字段语义为「本轮合计」，改动会牵连来源卡片文案与既有测试，收益低。
- **不在 `merge_online_sources` 里报错**：读盘阶段任何 Err 都可能升级成「应用打不开」，与 `quality-guidelines.md` 的容错三分支原则冲突。

## 8. 回滚形态

纯增量字段 + 单点分支改动，回滚 = 还原 5 个提交涉及的文件。旧配置（含新字段）回滚后仍可读（未知字段被忽略），不需要数据修复脚本。
