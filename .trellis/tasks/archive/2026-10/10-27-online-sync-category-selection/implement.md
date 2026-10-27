# 执行计划：在线来源定时同步支持选择分类

## 0. 前置事实（实现时不要再猜）

- 改动的 5 个生产文件：
  - `src-tauri/src/state.rs`（`OnlineSource` 加字段）
  - `src-tauri/src/online.rs`（归一化/校验/定时分类选择 + 命令体转发）
  - `src/App.tsx`（`SourceRow`）
  - `src/runtime/types.ts`（TS 镜像）
  - `src/styles/app.css`（checkbox/summary 行样式）
- 文档：`CONTEXT.md`（术语）
- 测试：`src-tauri/src/online.rs` 底部 `#[cfg(test)] mod tests`、`src/App.test.tsx`
- **不需要**改：`src-tauri/src/lib.rs`（命令列表不变，`update_online_source` 签名不变）、`src/runtime/tauri-runtime.ts`（参数透传，形状不变）、`system.rs`（调用已带 `manual=false`）。

## 1. 后端：数据结构与纯函数（`state.rs` → `online.rs`）

- [ ] 1.1 `state.rs:57-72` `OnlineSource` 增加
      `#[serde(default, skip_serializing_if = "Vec::is_empty")] pub sync_categories: Vec<String>`
      —— 放在 `category_statuses` 之前，紧邻 `interval_hours` 之后便于阅读。
- [ ] 1.2 `online.rs:468-482` `built_in_sources()` 结构体字面量补 `sync_categories: Vec::new()`（**必填**，否则编译失败）。
- [ ] 1.3 `online.rs:513-538` `merge_online_sources()` 增加
      `builtin.sync_categories = normalize_sync_categories(&saved.sync_categories);`
- [ ] 1.4 新增 `normalize_sync_categories` / `validate_sync_categories` / `due_sync_category_keys` / `apply_source_settings` 四个函数（见 design 2.2）。`normalize` 内部按 `UPX8_CATEGORIES` 顺序输出，全集收敛为 `vec![]`。

## 2. 后端：命令与定时路径

- [ ] 2.1 `online.rs:540-562` `update_online_source` 的闭包体替换为
      `apply_source_settings(config, &source)`；保留原 `mutate_without_rescan` 包裹与错误语义。
- [ ] 2.2 `online.rs:622-630` 的三元表达式改为三分支 `match`（design 3 节代码）；新增私有 `fn all_upx8_category_keys() -> Vec<String>` 避免重复展开。
- [ ] 2.3 检查 `online.rs:595-620` 借用：`source` 已在闭包内 `cloned()`，定时分支直接用 `&source`，不新增锁。

## 3. 后端测试（`online.rs` 的 tests mod）

- [ ] 3.1 `normalize_sync_categories_drops_unknown_keys` —— 输入 `["nature","nope","nature"]` → `["nature"]`。
- [ ] 3.2 `normalize_sync_categories_collapses_the_full_set_to_empty` —— 输入 10 个 key（乱序）→ `[]`。
- [ ] 3.3 `validate_sync_categories_rejects_unknown_key` —— 断言 `Err("UPX8 分类不存在。")`。
- [ ] 3.4 `due_sync_category_keys_falls_back_to_every_category_when_empty` —— 空配置 → 10 个。
- [ ] 3.5 `due_sync_category_keys_uses_the_saved_selection` —— `["anime","game"]` → 恰这 2 个，顺序按 `UPX8_CATEGORIES`。
- [ ] 3.6 `merge_online_sources_keeps_saved_sync_categories` —— 基于现有 `merge_online_sources` 测试风格（若已有同类测试则紧随其后）。
- [ ] 3.7 `apply_source_settings_persists_sync_categories` —— 构造 `AppConfig::default()`（含 built_in_sources）+ 传入 source，断言写入且非法 key 报错。

## 4. 前端

- [ ] 4.1 `src/runtime/types.ts:46-58` `OnlineSource` 加 `syncCategories?: string[];`（带中文注释）。
- [ ] 4.2 `src/App.tsx::SourceRow` 按 design 5.1-5.3 实现：`syncCategories` 解析、`toggleSyncCategory`、分类行 checkbox、summary 行 + 「全部纳入」按钮。
- [ ] 4.3 严格使用中文可访问名：`定时同步 <分类名>`、`定时同步全部纳入`。
- [ ] 4.4 `src/styles/app.css` 在 `.source-category*`（167-174 行）邻近追加 `.source-category-sync`、`.source-category-summary`，复用现有分隔线/字号 token，不引入新配色体系。

## 5. 前端测试（`src/App.test.tsx`）

- [ ] 5.1 `syncs every upx8 category by default` —— 进「图库」，断言 10 个 `getByLabelText("定时同步 <label>")` 全 checked。
- [ ] 5.2 `persists the unselected category list when toggled` —— 覆写 `runtime.updateOnlineSource = vi.fn(() => runtime.getState())`，点「定时同步 运动」，断言调用参数 `syncCategories` 长度 9 且不含 `sport`。
- [ ] 5.3 `keeps the last synced category selected` —— 先把 runtime 的 state 预置为只选 1 个（`createOnlineGalleryRuntime` 的 options 注入），断言该 checkbox `disabled` 且页面出现「至少保留 1 个分类」。
- [ ] 5.4 不改动既有用例；`createOnlineGalleryRuntime`（`App.test.tsx:697`）如需注入 `syncCategories`，加可选参数，保持所有既有调用点不传即默认。

## 6. 文档

- [ ] 6.1 `CONTEXT.md` 「UPX8 分类轮询」（59-61 行）改写：定时抓取只轮询用户选中的分类；手动「同步全部」仍轮询 10 类；补一句「未选中分类不产生同步记录、计数保持上一轮」。
- [ ] 6.2 `CONTEXT.md` 新增术语 **定时同步分类**：`内置在线来源中由用户勾选、参与间隔同步的分类集合；空表示全部 10 类。` + `_Avoid_: 抓取黑名单、分类开关、手动同步范围`
- [ ] 6.3 `CONTEXT.md` 「内置抓取来源」（23-25 行）在「用户可启用、停用和设置抓取间隔」后补「选择定时同步分类」。

## 7. 验证命令（按顺序，不要重复全量）

```bash
cd src-tauri && cargo check                       # 约 26s，先确认能编译
cd src-tauri && cargo test --lib online            # 只跑 online 模块
npm run test -- src/App.test.tsx                   # 只跑前端相关用例
npm run typecheck                                  # tsc --noEmit
# 全量门禁（收尾跑一次）
cd src-tauri && cargo test
npm run test
```

- 禁止 `sleep` 等待；`cargo test` 能前台阻塞到完成。
- 若 `cargo` 需要新增依赖 → 本任务不需要（复用现有 serde/Uuid/HashMap）。

## 8. 风险点与回滚

| 风险 | 处置 |
|---|---|
| 忘记给 `built_in_sources` 结构体字面量补字段 → 编译失败 | 1.2 是必做项，`cargo check` 首轮就能抓到 |
| `normalize` 收敛全集的判断写错（`len` 比大小而非 `contains`） | 3.2 与 3.5 双向覆盖 |
| 定时分支漏了 `manual` 判断，导致手动「同步全部」被裁剪 | 3.4/3.5 只测纯函数；在 2.2 后人工复核 `system.rs:259` 传的是 `false`、`run_online_source`（`online.rs:570`）传 `true` |
| 前端 `syncCategories` 为 `[]` 被当成「一个都没选」显示 | 4.2 用 `?.length ? ... : allKeys`，5.1 用例守护 |
| 既有 `App.test.tsx` 因新增 checkbox 导致 `getByRole("button")` 计数变化 | 5.4 明确不改既有用例；若失败先看是否 query 冲突 |

回滚点：按 §1→§4 的提交粒度回退，无数据迁移，无需修复脚本。

## 9. `task.py start` 前自查

- [ ] `prd.md` / `design.md` / `implement.md` 齐备
- [ ] `implement.jsonl` / `check.jsonl` 含真实 spec 条目
- [ ] 用户已对最终规划摘要明确批准
