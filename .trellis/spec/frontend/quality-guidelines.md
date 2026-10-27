# 质量规范

> 代码质量标准、测试与项目级约束。

---

## 门禁（任何任务收尾前必须全绿）

```bash
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
cargo test          # 在 src-tauri/ 目录下运行
```

注意：`vitest.config.ts` 固定了本机环境所需的 worker pool——不要改。

---

## 命令执行纪律（禁止盲等）

**禁止把 `sleep N` 当作等待手段。** 2026-10-20 实测：单次任务里 4 条 `sleep 240` / `sleep 180` / `sleep 120` 白烧 11 分钟，占该任务 Bash 时间的 8%，而它们等的进程本来可以直接阻塞等完。

| 场景 | 错误做法 | 正确做法 |
|---|---|---|
| 构建/测试要等结果 | `cargo test &` + `sleep 120` + `tail 日志` | 前台直接跑，命令返回即结果；超过 10 分钟才考虑后台 |
| 必须后台的长任务 | `sleep 240 && tasklist \| grep cargo` | 轮询**目标条件**（进程退出 / 日志出现完成标记），间隔 ≤3s、设最大轮询次数，超时即报失败 |
| 等外部状态变化 | 固定 sleep 后单次断言 | `until <条件>; do sleep 1; done` 并带次数上限 |
| 启动 GUI 应用等待就绪 | `sleep 10` 后检查 | 每秒轮询到稳态再断言（见「桌面应用冒烟」） |

- **单条命令里的 sleep 一律 ≤5s**；需要更长的等待说明命令该放到后台或该改写。
- 判断「等待中」不要靠猜时长：先看命令本身是否能阻塞到完成（`cargo`、`npm run build`、`pytest` 都能），能就直接跑。
- 后台任务的 `cargo ... | tail` 管道会假死（进程已亡但任务仍显示 running）——改用**日志落盘**，读文件而不是读管道。

### 构建命令频率（`cargo test` 是大头，不是编译慢）

2026-10-20 实测单任务内命令分类：

| 类别 | 次数 | 总耗时 | 均值 |
|---|---|---|---|
| `cargo test` | **46** | **45.9 分钟** | 60s |
| `sleep` | 17 | 21.8 分钟 | 77s |
| `cargo check` | 16 | 7.0 分钟 | 26s |
| `npm run test` | 4 | 2.3 分钟 | 34s |

**问题不是编译慢，是全量测试跑太多次（46 次）。**增量 `cargo check` 只要 26-28s，本身不慢；sccache / cargo-watch 对此类增量重编（源文件已变，缓存不命中）没有收益。

> 实测：一次 `cargo test` 总耗时 135 秒，其中测试执行只有 **1.97 秒**，98% 花在编译 crate 和链接 test 二进制上。所以中间验证用 `cargo check`（28s）而不是 `cargo test`（135s），**单次省 5 倍**。

- 改完代码先跑 `cargo check`（26s）确认能编译。
- 需要测试时**只跑受影响的模块**：`cargo test --lib <module>` / `cargo test <测试函数名>`。
- **全量 `cargo test` 只在门禁收尾跑一次**，不要每改一个文件跑一遍。
- AI 打标的两个真实模型测试（`loads_int8_vision_model_when_provided`、`runs_int8_inference_when_provided`）已标记 `#[ignore]`，默认 56 passed / 2 ignored。需要验证推理链路时才显式执行 `CLIP_TEST_MODEL=<path> cargo test -- --ignored`，**一次确认即可，不要反复跑**（每次 2-3 分钟）。
- 前端同理：`npm run test` 支持 `npm run test -- <文件路径>` 只跑相关用例。

---

## 测试（实际模式出自 `App.test.tsx`、`tauri-runtime.test.ts`）

- 测试与被测物同目录：`*.test.tsx` / `*.test.ts`。
- **通过 `App` 的 `runtime` prop 注入 fake**（factory 如 `createOnlineGalleryRuntime`，再用 `vi.fn` 覆写单个方法）。禁止 mock `@tauri-apps/api` 模块。
- 按 role + 中文可访问名查询：`findByRole("button", { name: "暂停切换" })`、`getByLabelText("筛选已跳过图片")`。这就是 `aria-label` 必须存在的原因。
- 异步：`const user = userEvent.setup()`；用 `await screen.findBy...` 等待。
- Rust：每个模块底部 `#[cfg(test)] mod tests`；测纯函数（normalize / merge / 领域规则）。把逻辑抽成纯函数让命令函数体可测。

---

## 架构约束（理由见 `docs/trellis/README.md`）

未经 ADR 决策，禁止：

- 引入 HTTP 服务器 / REST 层 —— 唯一 API 表面是 Tauri IPC 命令。
- 引入认证、账号或遥测 —— 本应用是本地优先（`CONTEXT.md`：本地优先）。
- 引入日志框架（`log`、`tracing`）或 `println!` 调试 —— 可观测性 = `Err(String)`（用户可读中文）→ 前端 `error` 状态；后台失败写入 `AppState` 上的来源运行状态字段。
- 拆分 `src/App.tsx` 或引入状态管理库。

## 语言与领域

- 用户可见字符串、错误信息、UI 文案一律**中文**，严格使用 `CONTEXT.md` 词汇（如：跳过图片 ≠ 删除；跳过不得说成删除）。遇到未定义术语 → 属于新语言，显式上抛，不要默默造词。
- 破坏性操作：走系统回收站，永不硬删；必须经 ConfirmDialog。

---

## 可访问性

- 每个控件都要有中文可访问名（`aria-label` 或包裹 `<label>`）——测试和用户都依赖它。

---

## Rust 侧状态持久化与容错（`src-tauri/src/state.rs`）

**读状态文件必须 `fs::read` + 显式转码，禁止 `fs::read_to_string`。**

`read_to_string` 遇到非法 UTF-8 返回 `ErrorKind::InvalidData`，会被误判成「磁盘 IO 故障」，把「内容损坏」升级成「应用无法启动」——GUI 下用户看到的就是双击没反应，无日志无备份。2026-10-21 实测：全零文件能恢复（`\0` 是合法 UTF-8），但断电写半截/坏块产生的非法字节会直接打死启动。

容错三分支（`load_from_dir`）：

| 情况 | 处理 |
|---|---|
| `NotFound`（首次运行） | 默认配置，不建备份 |
| 内容损坏：非 UTF-8 **或** JSON 非法 | 改名 `wallpaper-state.json.corrupt-<Unix毫秒>` 备份 → 默认配置重建 → **立即 `persist` 落盘** |
| 其余 IO 错误（权限/坏道） | `Err` 上抛，**不得静默重置**（否则磁盘故障被当成用户配置清零） |

- 备份时间戳用 `std::time` 毫秒，不要用 rfc3339 —— 冒号在 Windows 文件名里非法。
- 备份必须**逐字节保留原始坏文件**（单测断言 `fs::read == payload`），这是用户找回配置的最后凭据。
- 修复后不落盘会留下「磁盘上没有状态文件」的中间态，必须补一次 `persist`。
- 回归测试：`load_from_dir_recovers_when_state_file_is_not_valid_utf8`、`..._when_state_file_is_corrupt`、`..._without_backup_when_state_file_is_missing`。

### 可选集合配置的持久化约定（2026-10-27）

对「用户可选的子集，空 = 全部」这类配置（如 `OnlineSource.sync_categories`）：

- 字段用 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`，旧配置读入空 Vec，零迁移。
- **归一化时把「全集」收敛回空**：`normalize_sync_categories` 在 `len >= UPX8_CATEGORIES.len()` 时返回 `vec![]`。这样「默认」和「用户全选」只有一种存储形式，否则两种等价状态会让之后每次比较和断言都要写双分支。
- 读盘路径（`merge_online_sources`）用宽容归一化（丢弃非法 key）；写入路径（`apply_source_settings`）用严格校验（非法 key → 中文 Err）。读盘阶段报错会把脏配置升级成「应用打不开」。
- 命令体的设置写入走 `apply_source_settings` 这类纯函数，并且**先校验后赋值**：用 `?` 提前返回会留下「enabled 改了、分类没改」的半截状态。
- `built_in_sources()` 是结构体完整字面量，给 `OnlineSource` 加字段必须同步补 `sync_categories: Vec::new()`，`cargo check` 首轮就会报。

### 定时任务与手动命令的分流（2026-10-27）

`run_online_source_impl(..., category_key, manual)` 用 `manual` 区分后台定时（`system.rs::run_due_tasks` 传 `false`）与手动触发（命令层传 `true`）：手动路径必须保持全量，只有定时路径读用户配置。新增「受用户配置影响的后台行为」时沿用这个三元分支（`Some(key)` / `None if manual` / `None`），不要用「配置为空就代表手动」这类隐式判断。

---

## 桌面应用冒烟（进程级验证）

- **杀进程必须 `/T` 杀进程树**：`taskkill /IM zx-wallpaper.exe /F /T`。只杀主进程会残留 WebView2 子进程并锁住用户数据目录，新实例卡在窗口创建阶段 → `setup`（含状态加载）根本不执行，表现为「进程活着但状态文件长时间不变」的**假故障**。2026-10-21 为此误报过两轮。
- 用例启动前确认主进程计数归零，用例之间完全隔离（不复用同一次启动）。
- **轮询到稳态再断言**，不要固定 `sleep` 后单次判定：目标文件达到预期状态或进程退出即为稳态，超时才判失败。
- 状态文件测试必须**先备份用户真实状态、测试后还原**（`%APPDATA%/com.zhouxinnana.zxwallpaper/wallpaper-state.json`）。
- 透明窗口 + WebView2 合成层截不到图，也合成不出 hover → 布局/视觉验证改用「引用真实编译产物 CSS（`dist/assets/index-*.css`）的静态 harness + 指定视口」，量 DOM 几何判断裁切，不要靠肉眼估。

---

## 浮窗窗口尺寸（`src-tauri/src/widget.rs`）

- `WIDGET_EXPANDED_SIZE` / `WIDGET_COLLAPSED_SIZE` 必须与**实测**内容高度对齐，不能按 CSS 数值推算：`.widget-info` 实测比推算高 14px（字体 fallback 撑高），按 line-height 算会导致第二行按钮被窗口裁掉（2026-10-21 事故）。
- 现状：折叠 `36×132`，展开 `248×266`（内容 264px，尾部余量由 `.widget-actions { margin-top: auto }` 吸收）。
- 改浮窗内容（按钮行数、文案、行高、缩略图高度）→ 必须重新实测并同步常量。

---

## 本地构建环境（本机 Windows）

- `ort` 的 Windows 预编译包只带 DirectML 档，`copy-dylibs` 可能把 `DirectML.dll` 复制成 **0 字节** → 进程 `0xC0000020`（STATUS_DLL_INIT_FAILED）异常退出。真身在 `%LOCALAPPDATA%/ort.pyke.io/dfbin/x86_64-pc-windows-msvc/<hash>/DirectML.dll`（18,527,776 B）。`cargo clean` 后可能复发。
- 网络：`huggingface.co` 经本机代理不可达，**大模型文件走 `hf-mirror.com`**；cargo 需 rsproxy 镜像（临时 `--config source.crates-io.replace-with`），pip 走 aliyun 镜像。
