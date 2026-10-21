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
