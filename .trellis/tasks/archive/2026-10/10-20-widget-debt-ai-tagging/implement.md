# 实施计划

> 按阶段顺序执行；每阶段结束跑门禁（tsc + vitest + cargo check/test）并手动冒烟，全绿才进下一阶段。可多次会话推进，用本文件记录进度。

## Phase 1 — 工程还债（行为零变化）

- [x] 1.1 拆 `widget.rs`：迁 L654-782 浮窗几何 + `delete_current_wallpaper`；`cargo test` 绿。
- [x] 1.2 拆 `online.rs`（扩展现有文件）：迁 L578-653、L1131-1538、L1539-1679 在线域；`cargo test` 绿。
- [x] 1.3 拆 `wallpaper.rs`：迁 L784-1130 切换命令族 + L1974-2470 切换/历史/跳过辅助 + L3012-3170 Win32 壁纸设置；`cargo test` 绿。
- [x] 1.4 拆 `library.rs`：迁文件夹/扫描/目录监听/image assets 域；`cargo test` 绿。
- [x] 1.5 拆 `state.rs`：迁数据结构 + `RuntimeState::load` + `persist` + `build_state*` + `mutate` 族；拆 `system.rs`：系统集成/调度/托盘；runtime.rs 删除；`lib.rs` 收口注册。
- [x] 1.6 前端 `src/shared/paths.ts` 抽取，App.tsx / FloatingWidget.tsx 改导入。
- [x] 1.7 CONTEXT.md 补三条术语（design.md 1.3 草案）。
- [x] 1.8 门禁 + 冒烟：切换/托盘/浮窗/在线抓取手动过一遍；git 提交。（门禁四项全绿；托盘菜单由老大真机点验通过；浮窗冒烟暴露两处布局/定位问题并已修（bb20043 展开高度与启动定位、65bf51e 六键单行）；代码提交 6fe6aa9）

## Phase 2 — 浮窗闭环

- [x] 2.1 FloatingWidget.tsx 操作区扩为 6 键：暂停/恢复（Pause/Play 随 `paused` 切换）、跳过（SkipForward）；接 `tauriRuntime.togglePaused()` / `skipCurrentWallpaper()`；失败走内联 error。
- [x] 2.2 新增 `src/widget/FloatingWidget.test.tsx`（fake runtime 注入）：暂停/恢复渲染与调用、跳过调用、错误提示。
- [x] 2.3 app.css 浮窗操作区样式适配两行三列。
- [ ] 2.4 门禁 + 冒烟（与主窗口暂停状态联动）；git 提交。（门禁全绿、代码提交 9a0cb37；**暂停/恢复与主窗口的联动未经人工确认**——浮窗靠 `app://state-changed` 事件渲染 `state.paused`，机制与既有按钮一致，vitest 5 用例覆盖按钮与调用；老大收尾时决定不再单独点验，风险已知接受）

## Phase 3 — 持久化统一 + 容错

- [x] 3.1 state.rs：`WidgetLayout` 进 `AppConfig`（serde default）。
- [x] 3.2 widget.rs：`get_widget_layout` / `set_widget_layout` 命令；`position_floating_widget` 启动时按已存布局定位；lib.rs 注册。
- [x] 3.3 FloatingWidget.tsx：删 localStorage 逻辑，落点写 IPC；恢复流程简化。
- [x] 3.4 state.rs `RuntimeState::load` 容错：反序列化失败 → 改名 `.corrupt-<ts>` + 默认重建（仅解析失败，IO 错误仍报错）。
- [x] 3.5 测试：Rust 单测覆盖容错分支（写全零文件 → load 成功 → 备份存在）；vitest 覆盖布局写回调用。
- [x] 3.6 门禁 + 冒烟（拖拽重启恢复、手工写坏状态文件验证）；git 提交。（门禁四项全绿；拖拽/吸附位置重启恢复由老大真机验证通过；状态文件容错由主会话自动化验证三用例——全零 / 非法 UTF-8 / 合法 UTF-8 非 JSON 均 PASS，其中「非法 UTF-8」用例暴露启动级 bug，已修于 f1e102d；代码提交 e53d39a）

## Phase 4 — 本地 AI 打标

- [x] 4.1 依赖验证：`ort` 2.0.0-rc.15 + 最小推理 demo 跑通 `cargo check`（实测 9m36s，rsproxy 镜像）；Windows/MSVC 编译链接可用，`cargo test` 含真实 int8 模型推理。
- [x] 4.2 模型选型钉死：CLIP ViT-B/32 int8 图像编码器 = `Xenova/clip-vit-base-patch32` `onnx/vision_model_int8.onnx`（88,648,877 B，SHA-256 0ab0c1b3…bd93，hf-mirror URL 实测可下载）；`text-embeds.bin`（10×512 f32）本机生成（fp32 text encoder + HF tokenizers，6 通用 + game 3 专项模板）；样图评测：游戏类 19 张 top-1 57.9%（其余 9 类缺标注样本，Phase 4b 补测）；结论回写 design.md 4.1。
- [x] 4.3 `tagging.rs`：模型下载/校验/缓存、打标队列（增量、未打标优先、低优先级线程）、`ImageTag` 数据模型进 AppConfig。
- [x] 4.4 IPC：`set_tagging_enabled` / `get_tagging_status` / `rescan_tags`；目录监听接入增量打标；TS 类型镜像 + runtime 方法。
- [x] 4.5 UI：设置页「智能分类」区（开关 + 下载进度 + 就绪状态）；两个列表加分类筛选下拉。
- [x] 4.6 测试：tagging 数据模型与筛选逻辑单测；vitest 覆盖设置区渲染与筛选。
- [ ] 4.7 门禁 + 冒烟（启用→下载→打标→筛选→断网验证）；git 提交。（门禁四项全绿、代码提交 c8c0bf9；真机已验：开关启用→88.6MB 模型下载完成（SHA 校验通过）→ 19 张在线图全部打标写回、pending=0；**未验**：分类筛选手感、断网重下自动重试（老大决定不测，风险已知接受）。附带发现：19 条标签置信度仅 0.229~0.284，区分度低，筛选可信度有限，且在线图本可零成本使用接口分类——见遗留项）

## 收尾

- [x] 回顾：新坑回写 `.trellis/spec/`；`task.py finish` + archive。（2026-10-21 回写 `spec/frontend/quality-guidelines.md` 四节：Rust 状态持久化与容错 / 桌面进程级冒烟 / 浮窗窗口尺寸 / 本地构建环境）
- [ ] 版本与发布决策留给老大（是否随 v0.1.6 发布）。（**未决**：当前 package.json 0.1.5；本次四阶段改动未发版）

## 进度日志

- 2026-10-20 规划完成（prd/design/implement/research 落盘），待 start。
- 2026-10-20 Phase 1 步骤 1.1~1.7 完成（p1-refactor 子代理执行）：runtime.rs（3170 行）按 design.md 拆分表拆为 widget.rs / online.rs（扩展）/ wallpaper.rs / library.rs / state.rs / system.rs，lib.rs 仅剩组装，runtime.rs 已删除；每步 cargo test 全绿（37 用例）。偏离与归属说明：① `delete_current_wallpaper` 归 wallpaper.rs（implement.md 1.1 写在 widget.rs，与 design.md 拆分表冲突，从 design.md）；② 目录监听（start_directory_watcher + directory_* 辅助）归 system.rs（design.md system.rs 行明确列出，与 library.rs 行"目录监听"冲突，从更具体的 system.rs 行）；③ `same_path` 迁入 domain.rs（跨域共享的图片身份纯函数）；④ `get_state` 命令归 state.rs（快照命令，紧邻 build_state*）；⑤ `reveal_wallpaper` 归 wallpaper.rs（按语义校验 is_supported_wallpaper）；⑥ `is_switch_due` 归 wallpaper.rs、`due_source_ids` 归 online.rs（各自域的调度谓词）；⑦ 目录监听测试、autostart 测试随 system.rs，merge/reconcile/排序等测试随各自模块。门禁四项全绿：cargo check（0 代码警告）、npm run typecheck、vitest run（34 用例，vmThreads 配置未动）、cargo test（37 用例）。1.8 的 GUI 手动冒烟与 git 提交待主会话执行。
- 2026-10-20 Phase 2 步骤 2.1~2.4 完成（p2-widget 子代理执行；1.8 的 git 提交已由主会话完成）：2.1 浮窗操作区 4 键扩 6 键——排位为「上一张｜暂停/恢复｜下一张 / 跳过｜喜欢｜删除」，DI 接缝比照 App 模式给 FloatingWidget 加可选 `runtime` prop（`useState(() => runtime ?? tauriRuntime)`），tauriRuntime 调用全部改走 `api`；跳过无确认（与删除 confirming 显式对比），无当前壁纸时 disabled，暂停/恢复始终可点。2.2 新增 FloatingWidget.test.tsx 5 用例（本地 fake runtime factory，未 mock 模块）。2.3 `.widget-actions` flex→`grid repeat(3, 1fr)`，`.widget-action` 移除失效的 `flex: 1 1 0`，无新视觉概念。2.4 门禁：typecheck 绿、vitest 39 用例全绿（原 34 + 新 5）、cargo check 绿（无 Rust 改动）；与主窗口暂停状态联动的 GUI 冒烟待主会话执行。
- 2026-10-20 Phase 3 步骤 3.1~3.5 完成（p3-persist 子代理执行）：3.1 `WidgetLayout { docked/x/y: Option<…> }` 进 state.rs 并以 `#[serde(default)] widget_layout` 挂入 AppConfig（旧状态文件无此字段自动兜底，未做 localStorage 迁移）；顺手 derive PartialEq 供测试断言。3.2 新命令 `get_widget_layout` / `set_widget_layout`（后者走 `mutate_without_rescan` + persist，不触发重扫），lib.rs 注册两命令；`position_floating_widget` 去掉 `expanded` 参数改读 `config.widget_layout`——docked∈{left,right} → `set_widget_geometry(false, side, true, layout.y)`，x/y 均有值 → 抽出的 `apply_free_position`（与 `widget_set_free_position` 共用逻辑），均无 → 原 `position_fallback` 右缘居中兜底；初始化顺序：setup 中 `app.manage(runtime)` 在前、定位调用在后，函数内仍用 `try_state` + 锁失败/缺失时回退默认布局防御。3.3 FloatingWidget 删除 STORAGE_KEY/SavedLayout/localStorage 恢复 useEffect，挂载改经 DI runtime `getWidgetLayout` 只同步 docked/anchor 渲染状态（几何由 Rust 启动定位）；endGrab 三处落点（吸附边/整卡等效位置/自由位置）统一经 `persistLayout(api, …)` → `set_widget_layout`（失败静默，对齐旧 persistLayout 语义）；DesktopRuntime/tauri-runtime 同步补 `getWidgetLayout`/`setWidgetLayout`（命名跟随现有「镜像命令名」风格，未用 setLayout 简称），TS `WidgetLayout` 手工镜像（`string|null`/`number|null`）并加进 AppConfig 接口，四处 fake state/runtime 工厂（App.tsx 浏览器预览、App.test、FloatingWidget.test、tauri-runtime.test）同步补字段与方法。3.4 `RuntimeState::load` 拆出 `load_from_dir(directory: &Path)`（load 只解析目录后委托）；仅反序列化失败分支：`fs::rename` 为 `wallpaper-state.json.corrupt-<Unix毫秒>`（std::time，文件名安全、无新依赖）+ eprintln 记录备份路径与原因 + `AppConfig::default()` 重建；NotFound 维持 default、其他 IO Err 维持报错。3.5 Rust 单测 2 例（temp_dir 独立目录：全零文件 → load Ok + 默认值 + 恰一个 `.corrupt-` 备份；文件缺失 → 默认值 + 无备份）；vitest 新增 1 例「自由拖拽落点调用 set_widget_layout」（fireEvent pointerdown/move/up + 屏宽 stub 1024 + setPointerCapture 空实现，断言落点换算为窗口坐标 `{docked:null,x:60,y:20}`）。门禁四项全绿：cargo check（无代码警告）、npm run typecheck、npx vitest run（40 用例，vmThreads 配置未动）、cargo test（39 用例）。3.6 的拖拽重启恢复/写坏状态文件 GUI 冒烟与 git 提交待主会话执行。
- 2026-10-20 Phase 4a（4.1 + 4.2）完成（p4a-model 子代理执行，只做验证选型，未动业务代码/UI）：
  - **4.1 ort 依赖验证**：Cargo.toml 新增 `ort = "2.0.0-rc.15"`（optional，挂入 runtime feature；2.x 系列均为 rc，无 stable，取 2026-10-19 发布的最新版；默认 features 自带 download-binaries 构建期拉预编译 CPU 动态库）。`cargo check` 全绿 9m36s（0 代码警告，仅 tagging.rs 骨架 5 个 dead_code 已 `#![allow(dead_code)]`）。新建 `src-tauri/src/tagging.rs` 骨架：钉死 MODEL_URL/MODEL_SHA256/MODEL_FP16_URL 常量 + 三个测试（builder API 编译验证 / 模型加载 / 真实推理 [1,512] 断言，均走 `CLIP_TEST_MODEL` 环境变量，无文件自动跳过）。lib.rs 加 `mod tagging;`。
  - **4.2 模型选型**：图像编码器钉死 `Xenova/clip-vit-base-patch32` `onnx/vision_model_int8.onnx`，88,648,877 字节（与 HF 报告一致），SHA-256 `0ab0c1b3ace708e539633af1744d5a95247fe4e14d3e08ff197ef82a6cb9bd93`。URL 域名钉 hf-mirror.com——本机 huggingface.co 经代理完全不可达（CONNECT 502），hf-mirror 实测 200 且可整文件下载；二者路径结构一致，发版可整域互换。fp16 备选 `vision_model_fp16.onnx` 176,080,659 字节（未下载）。
  - **text-embeds.bin**：本机生成成功。环境 Python 3.13 + pip 装 numpy/onnxruntime/tokenizers/pillow（国内代理对 pypi/crates.io 不稳，走 aliyun/rsproxy 镜像解决；pip 安装中途被杀会损坏 numpy 需 `--force-reinstall --no-deps` 修复）。脚本 `.workbuddy/tmp-models/gen_text_embeds.py`：fp32 `text_model.onnx`（254,058,553 字节）+ `tokenizer.json`，`text_embeds` 输出 [batch,512]，10 类 ×（6 通用模板；game 类另加 3 条专项），均值 L2 归一化 → 10×512 f32 = 20,480 字节。产物与 meta（`text-embeds-meta.json`，含类别顺序=n online.rs UPX8_CATEGORIES 顺序）在 `.workbuddy/tmp-models/`。
  - **推理验证（Rust 侧最终确认）**：`cargo test` 全量 42 用例全绿（39 既有 + 3 新增 tagging 测试）、0 警告。新增测试含真实 int8 模型经 ort 的完整推理：Session 加载 → 纯白图 [1,3,224,224] → `run` → `image_embeds` [1,512] 且数值全有限，1.0s 完成。注意：ort rc.15 API 与 rc.10 有差异——`Session::builder` 需传 `&Environment`（`ort::environment::init().with_name(..).build()?`，每进程仅允许一个 Environment，多测试共享 OnceLock）、`inputs()`/`outputs()` 是方法、`try_extract_tensor` 直接返回 `(&Shape, &[f32])`。
  - **重要坑：copy-dylibs 在本机会把 DirectML.dll 复制成 0 字节** → 测试进程 0xC0000020（STATUS_DLL_INIT_FAILED）异常退出。ort 默认 Windows 预编译包只有 directml 档（onnxruntime 静态链入 + 运行时依赖 DirectML.dll/D3D12/DXGI）。修复：从 `%LOCALAPPDATA%/ort.pyke.io/dfbin/x86_64-pc-windows-msvc/<hash>/DirectML.dll`（18,527,776 B）手动复制到 target/debug{,/deps,/examples}。后续 `cargo clean` 或构建脚本重跑后可能复发，Phase 4b 若遇 0xC0000020 先查该 DLL 是否为 0 字节。
  - **准确性初评**：19 张 UPX8「游戏」实图（本地 online-wallpapers，唯一有 ground-truth 的类）：通用模板 top-1 7/19=36.8%，game 类加专项模板后 11/19=57.9%（+21pp）；未命中几乎全部滑向相邻「动漫」（UPX8 游戏图多为动漫画风，可辩护）。其余 9 类尝试从 UPX8 API 取样被 CDN 403 + 权限拒绝，无评测集；Phase 4b 需人工拉各类型样图补测再最终定 int8/fp16 档位。类间文本嵌入余弦偏高（mean 0.89 / max 0.94），置信度区分度小，argmax 可用但 margin 薄。
  - 模型文件均在 `D:/code/zx-wallpaper/.workbuddy/tmp-models/`（vision_model_int8.onnx / text_model.onnx / tokenizer.json / text-embeds.bin / gen_text_embeds.py / eval_vision.py），不进 git。
  - 遗留：① 其余 9 类样图评测（UPX8 CDN 拒绝抓取，需人工取样）；② 随模型一起分发的 text-embeds.bin 托管位置（HF 仓库还是项目 Release，Phase 4b 定）；③ copy-dylibs 0 字节 DLL 复发问题（见上，不阻塞）。
- 2026-10-20 Phase 4b（4.3~4.6 完成，p4b-tagging 子代理执行；4.7 的门禁已跑、GUI 冒烟与 git 提交待主会话）：
  - **4.3 tagging.rs 管线**：模型管理 `ensure_model_ready`（models/vision_model_int8.onnx 存在且 SHA-256 整文件复检通过→直接用；hash 不符先删缓存；缺失则流式下载到 `.onnx.part` 边下边更新进度、完成后原子改名再复检，失败删文件报错；下载只限 30s 连接超时、不设总超时适配 88MB 大文件）。预处理 `preprocess_dynamic_image`：中心裁剪正方形→`resize_exact(224)`（Triangle）→RGB/255、CLIP mean/std 归一化→CHW [1,3,224,224]。推理：进程唯一 `OnceLock<Mutex<Option<Session>>>` 会话（intra_threads=1、Level3），[1,512] 输出 L2 归一化后与 `text-embeds.bin`（`include_bytes!("../assets/text-embeds.bin")`，20,480B 已进 git）逐行点积取 argmax，零范数嵌入判不可分类。队列：`TaggingQueue { Mutex<QueueInner>, Condvar }` 挂 RuntimeState，单 worker 线程（`tagging-worker`）Condvar 等待、FIFO 消费；入队口 `enqueue_pending` 只收未打标且未在队列的候选路径（library_scan 缓存优先，无缓存退化 collect_candidates）；推理全程不持 AppConfig 锁，结果经 `mutate_without_rescan` 短锁写回 `image_tags` 并 emit state-changed。数据模型 `ImageTag { path, category, confidence, tagged_at }` + `AppConfig.image_tags`/`tagging_enabled`（均 serde default）。性能红线达成：intra_threads=1、无配置锁推理。OS 线程优先级未调（std 无 API，不引依赖），靠单线程+低频推理兜底。
  - **4.4 IPC**：`set_tagging_enabled`（mutate_without_rescan 持久化开关；true→start_queue（置位+懒启动 worker+入队，模型下载在 worker 首任务内做，IPC 不阻塞）；false→清空队列、数据保留）、`get_tagging_status -> TaggingStatus { enabled, modelReady, downloading: {received,total|null}|null, pending }`（model_ready 首查后缓存在队列状态）、`rescan_tags`（清掉文件已不存在的旧标签+重新入队）。目录监听：system.rs 重扫钩子后接 `tagging::enqueue_pending`（未启用时空操作）。启动恢复：lib.rs setup 末尾 `tagging::start_if_enabled`。TS 侧 types.ts 手工镜像 `ImageTag`/`TaggingDownloadProgress`/`TaggingStatus` + AppConfig 两字段 + DesktopRuntime 三方法；tauri-runtime.ts 加三条 invoke 映射；三处 fake（App.tsx 浏览器预览、App.test、FloatingWidget.test、tauri-runtime.test）同步补齐。
  - **4.5 UI**：设置页「系统集成」后新增 `TaggingSettings` 面板——启用 Toggle（走 `run("tagging-toggle")`+`setTaggingEnabled`）+ 模型状态行（1.5s 轮询 getTaggingStatus：未下载/下载中 MB+百分比/就绪+待打标数，四态文案+Tag 色调）；说明文案「本地推理为图片自动标注十分类，全程无遥测；首次启用需下载约 85MB 模型。」。分类筛选：在线图片列表（gallery-controls 内、来源筛选旁）与我的喜欢列表（section-actions 内）各加「分类」下拉（全部分类/十分类中文标签/未打标），`matchesCategoryFilter` 纯前端按 `state.imageTags` 小写路径匹配过滤；`taggingEnabled=false` 时下拉隐藏。无新 CSS 类。
  - **4.6 测试**：Rust 5 新例——SHA-256 校验（内容匹配通过/大小写不敏感/错 hash 拒绝/缺文件拒绝）、内置 text-embeds 解析（10×512、逐行 L2≈1）、错尺寸 payload 拒绝、预处理（300×200 渐变图触发中心裁剪，len=3·224·224、值域 [-2.5,2.5]、首像素手算值比对）、argmax 选类（余弦打分、index→UPX8_CATEGORIES 类名、零向量 None）；骨架 3 例真模型门控测试保留。vitest 8 新例——设置区四态（未启用可开/下载中 42/85 MB 50%/就绪待打标 3/未下载）、在线列表分类筛选（nature/untagged/all 三段切换）、喜欢列表分类筛选、关闭时筛选下拉隐藏；tauri-runtime.test 1 例转发三命令。
  - **4.7 门禁**：全绿——`cargo check`（无警告）、`npm run typecheck`、`npx vitest run` 48 用例（vmThreads 未动）、`cargo test` 47 用例（CLIP_TEST_MODEL 指向真实 int8 模型跑通两例门控推理测试）。依赖变更：Cargo.toml +`sha2 = "0.10"`（runtime feature）。新文件：`src-tauri/assets/text-embeds.bin`（20,480B，SHA-256 b1868374…051c）。
  - **偏离说明**：①「本地图库列表」落点选了「我的喜欢」列表（工作台无独立本地图库大列表，喜欢列表是最接近的本地图片全集视图）；② rescan_tags 语义按「清失配标签+重入队」实现；③ 下载 hash 边下边算改为完成后整文件复检（简单可靠，进度照常上报）。**遗留**：9 类人工取样评测（UPX8 CDN 403，仅 game 类有 57.9% 初评）；启用中停用会等当前一张推理完才真正停（无中途打断）；模型下载中断网需重试启用或 rescan_tags 触发重下（worker 内无自动重试循环）。
- 2026-10-20 主会话收口：四个 Phase 全部独立复核（各阶段 vitest/cargo test/typecheck 复跑）并分别提交——6fe6aa9（P1+浮窗 feature 合并提交）、9a0cb37（P2）、e53d39a（P3）、d826698（4a）、c8c0bf9（4b）。最终基线：vitest 48、cargo test 47 全绿。剩余：GUI 手动冒烟（主会话引导老大执行）→ 冒烟通过后回顾回写 spec + finish/archive。
- 2026-10-21 冒烟修复（bb20043）：浮窗展开窗口 272px 高度不足以容纳 2×3 操作区（实测内容 317px，第二行「跳过/喜欢/删除」整行被裁）→ 改 332px + 显式行高 + 操作区 margin-top:auto；启动定位改以主显示器为基准、显示器枚举重试、自由位置按目标点归屏钳制（current_monitor 在窗口未落位时会取错显示器）。已用无头浏览器按真实编译 CSS 复测：272 时仅 3 键可见，332 时 6 键全可见且底部留 11px。
- 2026-10-21 3.6 冒烟自动化（主会话）：状态文件容错三用例真机实测（release exe + 写坏文件 + 轮询稳态）——① 全零 3 字节 PASS（3s）② 非法 UTF-8 PASS（4s）③ 合法 UTF-8 非 JSON PASS（3s），均表现为：进程存活、`.corrupt-<Unix毫秒>` 备份保留原始坏字节、`wallpaper-state.json` 被重建为合法默认配置（2594 B）。
  - **首轮验证发现启动级 bug**：`fs::read_to_string` 对非法 UTF-8 抛 `InvalidData`，被当成 IO 故障 `return Err` → `lib.rs` setup `?` 失败 → 进程退出（rc=101），无备份无日志，GUI 下表现为双击无反应。已修（f1e102d）：改 `fs::read` + 自行转码，非 UTF-8 与 JSON 失败合并进同一修复分支；修复后立即 `persist` 一次，消除「磁盘无状态文件」中间态。新增单测 `load_from_dir_recovers_when_state_file_is_not_valid_utf8`（cargo test 48 全绿）。
  - **测试方法教训**（复用了 3 轮才定位）：批量串跑多用例时会出现「进程存活但状态文件长时间不变」的假 FAIL——因为上一实例的 WebView2 子进程/用户数据目录尚未释放，新实例卡在窗口创建阶段，`setup`（含 `load`）压根没执行。正确姿势：① 每用例前 `taskkill /IM zx-wallpaper.exe /F /T` 杀进程树并确认主进程归零；② 启动后按秒轮询到稳态（备份出现 + 主文件可解析）而不是固定 sleep 后断言一次；③ 用例之间隔离，不要复用同一次进程启动。
  - 未验项（老大明确暂不测）：断网重下、AI 打标全流程的筛选效果（模型下载/打标/写回已由其本人真机跑通，19 张在线图 pending=0）。

---

## 遗留项（收尾时确认，未处理）

1. **在线图分类应由接口提供而非 AI**：`Candidate.category_key` 在下载时就在手边，但 `OnlineImage` 无该字段，分类在写盘时被丢弃。修法：`OnlineImage` 加 `#[serde(default)] category_key: Option<String>` + 下载时写入 + 用 `OnlineSyncLog.response_image_urls ∩ image_url` 回填历史 + 前端筛选改 `onlineImage.categoryKey ?? imageTag.category`。零依赖、约 1~2 小时，未做（老大未拍板）。
2. **AI 打标准确率与置信度偏低**：仅"游戏"类有 ground-truth（57.9%），实测 19 条置信度 0.229~0.284，类间文本嵌入余弦 mean 0.89 导致 margin 薄。fp16 后备 URL 已钉但未启用。
3. **模型下载断网无自动重试循环**：重新开关一次或 `rescan_tags` 可触发。
4. **重编后需注意**：`ort` 的 DirectML.dll 可能被复制成 0 字节（详见 spec/quality-guidelines.md）。
