# 桌面壁纸应用方案设计文档（Tauri 2.0）

| 项目 | 决定 |
| --- | --- |
| 文档版本 | v1.1，2026-08-04 |
| 目标平台 | Windows 10 1803+、Windows 11；WebView2 是运行前置条件 |
| 目标技术栈 | Tauri 2.0 + Rust + React 19 + Vite + TypeScript + WebView2 |
| 前端运行时 | React/Vite/CSS 通过 Tauri Command/Event facade 访问桌面能力 |
| 首发在线范围 | 完整迁移内置来源、自定义 HTTPS 单页来源、定时抓取、UPX8 分类轮询、受管目录、下载与安全校验 |
| AI 模型 | 不进入安装包；用户主动启用后按 manifest 下载、校验并缓存 |
| DWM 系统美化 | 不进入首发；仅作为默认关闭、可完全回退的 Win11 实验能力 |

## 1. 目标、范围与发布定义

### 1.1 产品目标

ZX Wallpaper 是本地优先的 Windows 静态壁纸管理器。它管理本地壁纸目录和用户主动启用的在线来源，将所有可用图片纳入同一随机循环；用户能够明确切换、暂停、跳过和恢复壁纸。在线发现的联网、下载和元数据均留在本机，不引入账号、云同步、遥测或通用网页爬虫。

Tauri 的目标是提供 Rust 系统能力和更小的基础运行时；它不是重写 React UI，也不是把 AI 3D、DWM 或音频特效塞入首发版本。

### 1.2 首个可发布版本的核心闭环

首发版本必须完成两个相连的闭环，缺一不可：

```text
本地目录 -> 扫描候选 -> 设为壁纸 -> 自动切换 -> 跳过/恢复

在线来源 -> 用户启用/手动或定时抓取 -> 安全过滤 -> 下载到受管目录
         -> 写入本地元数据 -> 并入同一候选集 -> 手动设为壁纸或自动切换
```

**发布验收**：在全新安装、无网络和有网络两种环境中，以下行为可连续运行 24 小时且重启后保持一致。

1. 用户选择本地目录，应用递归发现可解码的 `.jpg/.jpeg/.png/.bmp/.webp`，并展示可用、空、不可访问和无效图片数量。
2. “下一张”能实际改变 Windows 桌面壁纸，`fill/fit/stretch/tile/center/span` 显示方式正确生效。
3. 自动切换、暂停/恢复、休眠恢复补切和随机循环正确工作；同一轮候选不会重复。
4. “跳过当前壁纸”会持久化排除该路径、立即切换下一张；恢复后才可再次参加循环。
5. 新安装默认不联网；用户显式启用来源并手动抓取后，只下载符合规则的原图到受管在线目录。
6. 所有内置来源、用户自定义 HTTPS 单页来源和 UPX8 分类轮询均能独立设置抓取间隔、保存运行状态和失败原因。
7. 下载的在线图片按最终 URL 去重，受目录容量/最小分辨率限制，支持查看来源页、打开本地文件夹、删除和手动设为壁纸。

### 1.3 明确后置的差异化能力

- 2D 深度图推理、2D 转 3D 视差、动态桌面宿主。
- WASAPI loopback、FFT 音频律动、全屏游戏感知暂停。
- 任务栏透明/Acrylic/Mica、壁纸主色提取与注册表主题联动。
- 多显示器独立壁纸、视频/GIF/网页壁纸。

标准 Windows 壁纸 API 只能设置静态位图；“WebGL 渲染成动态桌面”需要额外的 WorkerW/Progman 类桌面宿主研究，不能作为 Tauri Command 的普通延伸。首发版在静态壁纸与完整在线发现通过验收前，不启动这些模块的产品开发。

## 2. 当前实现与 Tauri 架构评估

### 2.1 已有资产

当前工程是 **React 19 + Vite + Tauri 2 + Rust**。`src/App.tsx` 和 CSS 已实现工作台、目录、在线来源、在线图片和已跳过图片等视图；`src/runtime/tauri-runtime.ts` 通过 Tauri Command/Event facade 调用 `src-tauri/src/runtime.rs`，后者集中持有配置、目录扫描、监听、随机循环、计时、跳过、来源抓取、下载、托盘、快捷键和 Windows 调用。

以下资产应复用而非重写：

- React 组件结构、路由/视图切换、样式、文案、Lucide 图标和现有视觉设计令牌。
- 领域定义和行为测试：壁纸目录、受管在线目录、随机循环、跳过图片、来源状态、下载规则。
- JSON 配置字段与状态恢复样本。
- 内置来源协议、UPX8 分类清单、SSRF 拒绝规则和打包/验收脚本的测试意图。

### 2.2 实现范围与难度

| 区域 | Tauri 实现 | 目标 | 难度 | 结论 |
| --- | --- | --- | --- | --- |
| React UI | React 19/Vite，业务通过 facade 访问 | 组件和 CSS 保持，状态由 Runtime 快照驱动 | 中 | 高复用 |
| IPC | Tauri Command 与状态事件 | 前端只依赖 facade | 中 | 稳定接口 |
| 配置 | `serde` JSON、默认值与原子写入 | 保持数据语义 | 中 | 已实现 |
| 本地目录 | `walkdir`、`notify`、`image`、Tauri dialog | 目录扫描、监听与缩略图 | 中 | 已实现 |
| 静态壁纸 | PowerShell + 注册表/Windows 样式 | Rust `windows` Adapter | 高 | 真机验证，不接受模拟成功 |
| 在线发现 | Rust `reqwest`、URL/DNS 校验、来源 Adapter、受管库 | 完整在线发现 | 高 | 首发范围 |
| 托盘/快捷键/开机启动 | Tauri 官方插件 | 产品等价桌面能力 | 中 | 持续完善 |
| 3D/DWM/音频 | PRD 新能力，当前未实现 | 独立 POC 与功能开关 | 很高 | 不纳入首发完成标准 |

**总体判断**：React UI 与 Tauri facade 已形成清晰边界；首发风险集中在 Windows 壁纸 Adapter 与完整在线抓取安全性。在线发现选择 C 使首发范围显著增大，但仍可通过“本地内核先稳定、在线模块后接入、统一发布验收”的方式控制风险。

## 3. 目标架构与技术选型

### 3.1 技术栈

| 层级 | 选择 | 作用 |
| --- | --- | --- |
| 应用壳 | Tauri 2.0，NSIS 安装包优先 | Windows 壳、WebView2 检测、签名与升级 |
| 前端 | React 19、Vite、TypeScript、现有 CSS、Lucide | 保留成熟 UI；不再依赖 `window.zxWallpaper` |
| 前端状态 | 现有 React state/hooks 优先；仅在跨页面状态变复杂时引入轻量 store | 后端状态快照是唯一业务真相，不复制随机/抓取算法 |
| Rust 异步 | Tokio | 扫描、监听、计时、下载、写配置均不阻塞 UI |
| Windows 适配 | `windows` crate | 静态壁纸、显示样式、休眠/前台窗口等 Win32 交互 |
| 文件处理 | `walkdir`、`notify`、`image` | 扫描、监听、解码校验、缩略图 |
| 网络与安全 | `reqwest`、`url`、DNS 解析、`sha2` | HTTPS 抓取、每跳重定向验证、下载完整性和大小限制 |
| 数据 | `serde` + JSON + 原子替换 | 本地可读配置、在线元数据、迁移兼容 |
| 任务栏与系统集成 | Tauri dialog、tray、autostart、global-shortcut 插件 | 仅在产品等价阶段按需启用 |
| 测试 | Rust 单元/集成、React 组件测试、Windows smoke test | 业务规则可脱离 GUI，系统动作可替换验证 |

核心首发不引入数据库、通用爬虫、账号系统、云同步、遥测、ONNX Runtime、DirectML、WebGPU、WASAPI 或 DWM 依赖。

### 3.2 代码组织

```text
src/                                  # 现有 React 代码迁移并逐步替换 bridge
├─ runtime/                           # TypeScript Tauri facade 与事件订阅
├─ views/                             # Workbench、OnlineDiscovery 等复用视图
├─ components/                        # 目录、来源、在线图片、跳过列表
└─ state/                             # 只保存 AppState、busy/error 等 UI 状态

src-tauri/src/
├─ runtime/                           # AppRuntime：唯一业务入口
├─ domain/                            # 纯模型：候选集、随机循环、来源状态、下载规则
├─ adapters/
│  ├─ windows_wallpaper.rs            # Win32 静态壁纸 Adapter
│  ├─ filesystem.rs                   # 扫描、监听、缩略图和目录移动
│  ├─ network.rs                      # URL/DNS/重定向校验及受限 HTTP Client
│  └─ sources/                        # 内置来源和自定义单页来源 Adapter
├─ persistence/                       # 设置、在线元数据与原子写入
├─ commands.rs                        # 薄 Command 转发层
└─ lib.rs                             # Tauri 初始化、依赖装配、事件注册
```

### 3.3 AppRuntime Interface

`AppRuntime` 是深模块：React 只知道少数业务操作和完整状态快照，不需要知道扫描、队列、下载、重定向检查或计时如何实现。每个成功的写操作均返回新 `AppState`，并发出 `app://state-changed`；失败返回稳定错误码和可读中文信息，不发出伪成功状态。

```text
get_state() -> AppState

add_folder() -> AppState
update_folder(folder) -> AppState
remove_folder(folder_id) -> AppState
open_folder(folder_id) -> AppState
rescan_folders() -> AppState

next_wallpaper(reason) -> AppState
skip_current_wallpaper() -> AppState
restore_skipped(path | all) -> AppState
delete_skipped(path) -> AppState
update_preferences(patch) -> AppState
toggle_paused() -> AppState

add_online_source(url) -> AppState
update_online_source(source) -> AppState
remove_online_source(source_id) -> AppState
run_online_source(source_id) -> AppState
select_online_directory() -> AppState
set_online_image_as_wallpaper(image_id) -> AppState
delete_online_image(image_id) -> AppState
reveal_online_image(image_id) -> AppState
get_thumbnail(image_id | skipped_path) -> DataUrl | null

event: app://state-changed(AppState)
```

`commands.rs` 只负责反序列化和调用 Runtime。所有状态更改通过一条内部路径执行：验证输入 -> 更新领域状态 -> 原子保存 -> 重置相关后台任务 -> 发送完整快照。React facade 使用 `@tauri-apps/api/core` 的 `invoke` 与事件订阅，让视图不感知平台细节。

## 4. 核心领域和数据设计

### 4.1 统一候选集和随机循环

- 图片以规范化绝对路径标识，Windows 比较路径时大小写不敏感；移动/重命名视为新图片。
- 候选集 = 已启用且可访问的用户目录图片 + 存在于受管在线目录的下载图片 - `skippedPaths`，按路径去重。
- 一轮随机循环维护打乱后的 `remainingPaths`。一张候选在一轮内最多出现一次；为空后才创建下一轮。
- 文件变化、下载完成、删除或恢复跳过图片后，丢弃队列中不存在/已跳过路径，再补入新增候选；不为了补齐而重复当前图片。
- `skip_current_wallpaper` 先持久化跳过路径并从候选与剩余队列移除，再立即调用下一张；无候选时返回领域错误，不修改 Windows 桌面。
- `set_online_image_as_wallpaper` 成功后暂停自动切换，符合既有“用户明确选择优先”的语义。

### 4.2 本地目录与自动切换

`FolderCatalog` 负责递归扫描、真实解码过滤和目录状态。文件监听只触发 600ms 去抖的重新扫描；全量扫描才是事实来源。监听失效或权限错误不能清空已知可用候选，必须显示“路径不可访问”并允许用户手动重扫。

`SwitchScheduler` 只在 `paused=false` 且候选非空时运行。更新间隔、暂停、候选变化和应用关闭都会取消旧任务并建立新任务。系统解锁/睡眠恢复后，如果错过下一个切换点，仅补切一次，禁止连续补历史次数。

### 4.3 在线来源 Interface

来源之间确实存在实现差异，因此有真实的 Adapter seam；不建立“万能爬虫”。

```text
SourceAdapter::discover(source, DownloadPolicy) -> DiscoveryReport
  - BuiltInAdapter：维护固定地址和协议，用户不可编辑地址
  - CustomPageAdapter：仅解析用户给出的单个 HTTPS 页面 HTML 的 img/srcset
  - Upx8Adapter：按固定 10 个分类顺序完成一次轮询，返回分类状态
```

所有 Adapter 输出统一的 `Candidate { image_url, source_page_url, width?, height?, category? }`。`OnlineLibrary` 负责去重、过滤、下载、写元数据和并入候选集，Adapter 不写文件、不改全局配置、不直接调用 Windows Adapter。

### 4.4 在线抓取、下载与安全规则

1. 默认禁用全部内置来源；应用不因启动或显示 UI 自动联网。
2. 用户启用来源后，可手动抓取或按 1/6/12/24 小时固定间隔执行；每个来源保存上次运行、下次运行、发现数、下载数和最近错误。
3. 自定义来源只接受 `https://` 公网单页 URL；拒绝 localhost、IP 字面量、私网/回环/链路本地/保留地址和非 HTTPS。
4. 每次初始请求及每一次重定向都重新解析主机名、校验所有解析地址和目标 scheme；校验失败即中止。不得执行页面 JavaScript、登录流程、无限滚动或递归爬站。
5. 内置来源仅使用项目维护的 Adapter；新来源必须单独审查协议、网络行为、许可和测试样例后才能加入。
6. 仅接受横向、达到最小分辨率的 JPEG/PNG/WebP/BMP；以最终下载 URL 去重。下载前检查 `Content-Type`、`Content-Length`，下载时执行流式硬上限，完成后再由 `image` 解码验证。
7. 文件下载到受管目录的唯一临时文件；验证成功后原子 rename，再写 `OnlineImage` 元数据。失败时删除临时文件且不写成功记录。
8. 达到 1/5/10/20 GB 目录上限时停止新下载并保留已下载图片；绝不自动清理。删除来源仅停止抓取，不删除历史下载。
9. UPX8 每轮依次请求风景、动漫、游戏、动物、城市、抽象、宇宙、汽车、美女、运动十个分类；每个分类失败独立记录，整轮完成后更新来源状态。

### 4.5 配置持久化

Tauri 将状态保存到应用配置目录，使用 JSON 与原子写入。首次启动没有状态文件时使用默认配置；后续启动只读取和验证当前状态文件。

状态文件包含目录、间隔、显示方式、暂停、当前路径、剩余队列、跳过路径、快捷键、在线来源、在线图片、在线目录、容量上限、最小分辨率和来源运行状态。读取后重新验证路径和图片存在性；可恢复的数据保留，不可访问路径以状态反馈，不静默删除用户记录。无法读取时使用默认配置并提供诊断信息。

## 5. Windows 系统 Adapter

`WindowsWallpaperAdapter` 的 Interface 保持很小：

```text
apply(path, display_mode) -> Result<AppliedWallpaper, WallpaperError>
current() -> Result<Option<PathBuf>, WallpaperError>
```

Implementation 负责验证图片、写入 Windows 样式相关设置并调用 `SystemParametersInfoW(SPI_SETDESKWALLPAPER, ..., SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)`。不得继续依赖 PowerShell；Command 成功不等于验收成功，必须在 Windows 10/11 真机确认桌面实际更新。`span` 在单屏或系统不支持时必须返回降级状态。

未来的多显示器独立壁纸、动态桌面和 DWM 改造必须是新的 Adapter，不应污染此静态壁纸 Interface。

## 6. 分步骤开发流程

### 阶段 0：运行时契约冻结

**目标**：固定 Tauri Runtime 的行为契约与可重复验收信号。

- 固定 Tauri 2 + React/Vite 工程的 CSS、视图、图标和 TypeScript 数据类型。
- 建立 `tauriRuntime` facade，用内存 fake 支持 UI 测试，不在视图内散落 `invoke` 调用。
- 固化当前 JSON 状态样本、正常/空/损坏目录、内置来源响应 fixture、重定向/私网 URL 测试集。
- 验收：React 视图可用 fake Runtime 演示本地和在线所有状态；Tauri 桌面端通过实际验证。

### 阶段 1A：本地静态壁纸内核

**顺序**：配置导入 -> 目录扫描 -> 候选集/随机循环 -> Windows Adapter -> 下一张 -> 自动切换 -> 跳过/恢复。

- 先为纯 Rust 领域规则编写测试，再接文件系统和 Win32。
- 只通过 `AppRuntime` 驱动 UI；不存在“前端改配置、后端再猜状态”的双写路径。
- 验收：本地无网络的完整闭环通过第 1.2 节的 1–4 项，并在重启、目录变更、无候选和 Adapter 失败时保持数据完整。

### 阶段 1B：完整在线发现内核

**顺序**：受管目录 -> 网络校验 -> 单个内置来源 -> 下载事务 -> 在线元数据/UI -> 其余内置来源 -> 定时抓取 -> 自定义来源 -> UPX8 分类轮询。

- 每完成一个来源 Adapter，就运行相应 fixture、网络安全、下载、去重、容量和恢复测试；不等到所有来源完成后集中调试。
- 下载成功后才加入统一候选集；失败、取消或容量满不得影响本地循环。
- 自定义来源与内置来源共享 `OnlineLibrary`，但绝不共享“任意 URL 解析”逻辑。
- 验收：第 1.2 节的 5–7 项全部通过，所有来源可以独立失败并保留可解释状态。

### 阶段 1C：首发集成与发布候选

- 合并本地/在线候选集、迁移导入、UI busy 状态、缩略图懒加载和可访问性。
- 在无网、网络失败、来源失败、下载中断、目标目录被删除、容量耗尽、重启与休眠恢复下进行回归。
- 通过 Windows 10/11 手工 smoke test、安装/卸载/升级测试和 24 小时运行测试后，发布 `1.0-static-online`。

### 阶段 2：产品等价桌面能力

托盘、关闭到托盘、开机启动、全局下一张快捷键、主题跟随、目录文件监听和恢复补切。快捷键冲突必须显示未注册状态；监听只优化刷新，不是候选集真相来源。

### 阶段 3：差异化功能 POC

每一项单独立项、默认关闭、通过退出条件才可产品化：

1. **AI 深度图**：用户主动下载带版本/许可/SHA-256 的模型 manifest；支持下载失败、缓存命中、取消与删除，不以“1.5 秒”作为未测量承诺。
2. **动态桌面宿主**：验证 Explorer 重启、锁屏、多显示器、全屏程序、崩溃恢复和卸载清理。WebGL 预览成功不代表可交付。
3. **全屏暂停与 WASAPI**：先分别验证前台窗口判断、音频设备切换、独占模式和资源恢复，再与动态桌面集成。
4. **DWM 美化**：仅 Win11 实验开关；必须能在 Explorer 重启、最大化窗口、浅色壁纸、系统升级和功能关闭时恢复 Windows 默认状态。

## 7. 测试、性能和安全验收

| 层级 | 重点 | 通过条件 |
| --- | --- | --- |
| Rust 领域测试 | 随机、跳过、队列刷新、来源调度、下载状态机 | 不依赖 GUI/网络/真实桌面；行为可重复 |
| Adapter 测试 | JSON 导入、原子写入、路径规范化、来源 fixture | 损坏配置、非法 URL 和中断下载不丢失上次有效数据 |
| React 测试 | `AppState` 投影、忙碌禁用、失败提示、无障碍 | 只 mock Runtime interface，不重写业务规则 |
| Windows 集成测试 | 实际壁纸、显示样式、目录选择、受管目录迁移 | Win10/11 真机或 VM 都有记录 |
| 网络安全测试 | DNS、重定向、私网、内容大小/类型、格式伪装 | 任意失败均不触达内网、不留下半成品文件 |
| 发布回归 | 首启、升级、离线、24 小时计时/抓取 | 用户配置可保留或有明确诊断 |

性能以基线设备的 P50/P95 实测记录：空闲、目录扫描、壁纸切换、在线抓取、下载、暂停和恢复。不要把“30–50MB”“GPU <3%”或“全屏 0%”写成所有设备的无条件承诺；静态首发与后置动态功能必须分别统计。

核心安装包尺寸独立测量。WebView2 bootstrap/runtime、可选 ONNX Runtime 与按需模型必须在发布说明中单独说明；模型不进入核心安装包。

## 8. 风险与退出策略

| 风险 | 影响 | 缓解与退出策略 |
| --- | --- | --- |
| Tauri bridge 改造导致 React 回归 | 中 | facade 有集成测试与实际桌面验证 |
| Win32 显示样式差异 | 高 | 只经 `WindowsWallpaperAdapter` 调用；Win10/11 真机矩阵；失败不覆盖当前有效配置 |
| 完整在线来源过多 | 高 | 每个 Adapter 独立 fixture 和验收；一个来源阻塞不阻塞本地内核，但阻塞首发在线验收 |
| 自定义来源 SSRF/重定向 | 很高 | HTTPS、DNS/IP 每跳校验、禁止私网与脚本执行、流式大小上限；出现绕过即停止发布 |
| 目录监听遗漏/抖动 | 中 | 监听只触发去抖全量扫描；扫描是唯一事实来源 |
| 配置写入损坏数据 | 高 | 版本化、原子写入与可导出诊断 |
| WebView2 缺失或过旧 | 中 | 安装/启动检查并引导官方 runtime；不假定用户系统已存在 |
| 3D/DWM/音频拖累首发 | 很高 | 代码与排期隔离；首发分支不引入这些依赖和能力 |

## 9. 首发前检查清单

1. React UI 已完全通过 Tauri facade 访问后端，项目中不存在其他桌面运行时生产依赖。
2. Tauri 状态文件保持本地目录、跳过路径、在线来源、在线元数据和受管目录语义。
3. 本地闭环在无网络环境通过，在线闭环在用户主动启用后通过；默认启动没有网络请求。
4. 所有内置来源、自定义来源和 UPX8 分类轮询均有成功、失败、超时和重启恢复测试。
5. 每个下载路径完成 URL/DNS/重定向、大小、MIME、解码、临时文件清理和容量检查。
6. Windows 10/11 上实际验证壁纸切换和显示样式；Tauri 安装、卸载和升级不破坏用户图片与应用配置。
7. 只有 1–6 全部通过，才允许启动 AI、动态桌面、音频或 DWM POC。

## 10. 已确认的架构决策

- **1A：保留 React**。不改写 UI 框架，复用现有视图、样式和用户流程；只通过一个 Tauri facade 访问系统能力。
- **2A：模型按需下载**。静态壁纸和在线发现可完全离线运行；用户主动启用 AI 后才下载、校验与缓存模型。
- **3A：DWM 后置**。系统任务栏美化不阻塞首发，未来仅作为默认关闭且可完全恢复的 Win11 实验能力。
- **在线发现选择 C**。首发包含完整既有在线能力，但通过 1A/1B 的内部顺序实施；“本地先通过，再接线上”是开发顺序，不是缩减发布范围。
