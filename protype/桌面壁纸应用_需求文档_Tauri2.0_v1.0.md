# 桌面壁纸应用程序 (Tauri 2.0) 产品需求文档 (PRD)

| 文档版本 | 创建日期 | 产品形态 | 架构体系 | 商业模式 | 适用系统 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **v1.0 (Tauri 版)** | 2026年8月 | Windows 桌面客户端 | **Tauri 2.0 (Rust + WebView2)** | 纯免费 | Windows 10 (1803+) / Windows 11 |

---

## 1. 文档概述与产品定位

### 1.1 产品愿景
基于 **Tauri 2.0** 架构打造一款极致轻量、高质感的 PC 桌面美学与互动枢纽。利用 Rust 底层高性能优势与 Windows 原生 WebView2 渲染引擎，在不依赖复杂创作编辑器与高昂硬件开销的前提下，让用户现有的 2D 壁纸秒变立体 3D 视差壁纸，并与 Windows 系统界面产生一体化沉浸美学联动。

### 1.2 核心竞争壁垒（差异化优势）
1. **零门槛 2D 转 3D**：直接读取现有本地/在线 2D 壁纸，利用 Rust 调起 GPU 进行 AI 单目深度估算生成立体 3D 视差壁纸，打破传统 3D 壁纸的内容生态限制。
2. **深度系统美学融合**：基于 Rust `windows-rs` 绑定调用 DWM 底层 API，实现任务栏透明/亚克力/Mica 材质无缝切换及壁纸色彩提取联动。
3. **WASAPI 音频实时律动**：Rust 后端直接进行毫秒级 WASAPI 音频抓包与 FFT 频域转换，无缝驱动前端 WebGL 视听同步交互。
4. **极致性能与内存控制**：依靠 Tauri 2.0 原生架构，应用后台静态**内存占用仅 30MB~50MB**；AI 预处理后由 WebGL Shader 高效渲染（GPU <3%），全屏应用/游戏下实现 0% 开销自动暂停。

### 1.3 技术栈架构说明
* **前端 (UI & 渲染)**：HTML5 / CSS / React + WebGL 2.0 / WebGPU Shader (视差与律动渲染) + WebView2 引擎。
* **后端 (System & AI Core)**：**Rust (Tauri 2.0 Core)**。
* **AI 推理引擎**：Rust `ort` (ONNX Runtime 绑定) + DirectML（调用本地 GPU 高效加载 Depth Anything v2 预处理模型）。
* **系统 API 与美化**：Rust `windows-rs` / `winapi`（深度挂钩 DWM、Shell Event Hooks、注册表及 Win32 API）。
* **音频抓包**：Rust `cpal` / `windows-rs` (WASAPI Loopback 模式)。

---

## 2. 核心业务流程与功能架构

### 2.1 产品功能架构图
```text
┌────────────────────────────────────────────────────────────────────────┐
│                   桌面壁纸应用程序 (Tauri 2.0 + Rust)                   │
├───────────────────┬────────────────────┬───────────────────────────────┤
│    壁纸输入源     │    AI & 渲染引擎    │      DWM & 系统控制模块       │
│  (前端资产复用)   │   (Tauri 核心引擎) │       (Rust 系统底层)         │
├───────────────────┼────────────────────┼───────────────────────────────┤
│ • 本地 2D 照片    │ • DirectML 深度估算│ • 任务栏美化 (透明/亚克力/Mica)│
│ • 在线高清图库    │ • WebGL 视差 Shader│ • K-Means 色彩提取与主题联动  │
│                   │ • WASAPI 律动 FFT  │ • Shell 全屏/游戏暂停 (0%开销)│
└───────────────────┴────────────────────┴───────────────────────────────┘
```

### 2.2 用户主工作流
1. **壁纸选择**：用户在 WebView2 前端页面中选择“本地 2D 照片”或“在线高清图库”中的图片。
2. **一键生成 3D 视差**：触发 Tauri Command，Rust 后端在后台调用 DirectML 执行深度图提取，前端 WebGL 接收深度图并应用视差 Shader 渲染为桌面背景。
3. **系统美化响应**：Rust 后端提取壁纸主色调，调整任务栏图标反色防护及系统主题色，同步调用 Win32 API 更新任务栏材质（如亚克力或 Mica）。
4. **音频交互**：播放音乐时，Rust 后端 WASAPI 抓包进行 FFT 处理，将频带数据推送至前端 WebGL 驱动动态粒子/光晕律动。
5. **游戏/全屏避让**：Rust 监听 Shell 全屏事件，检测到全屏应用时下发 `pause` 事件，前端停止 WebGL `requestAnimationFrame` 渲染，CPU/GPU 降至 0% 占用。

---

## 3. 详细功能需求说明

### 模块一：DWM 系统美学与任务栏控制模块（Rust 底层）

#### 1.1 任务栏材质与透明度控制
* **需求描述**：提供多种任务栏渲染风格，与当前壁纸完美融为一体。
* **详细配置项 (Rust `windows-rs` 实现)**：
  1. **完全透明 (Fully Transparent)**：调用 `SetWindowCompositionAttribute` 的 `ACCENT_ENABLE_TRANSPARENTGRADIENT`，任务栏背景完全透明，壁纸延伸至屏幕底部。
  2. **亚克力模糊 (Acrylic Blur)**：调用 `ACCENT_ENABLE_ACRYLIC_BLURBEHIND`，呈现高斯模糊与微粒噪声质感。
  3. **云母材质 (Mica / Mica Alt)**：在 Win11 (Build 22523+) 上调用 `DwmSetWindowAttribute` (`DWMWA_SYSTEMBACKDROP_TYPE`)，动态绘制壁纸模糊采样。
  4. **窗口最大化自动切换 (Auto-Maximized Blur)**：挂钩 `Shell_TrayWnd` 监听窗口最大化消息 (`WM_SIZE`)。桌面状态下保持全透明，当有窗口最大化时自动切换为亚克力/云母模糊，提升工作专注度。

#### 1.2 壁纸色彩汲取与系统主题联动
* **需求描述**：避免浅色壁纸下任务栏图标无法识别或视觉冲突的问题。
* **详细逻辑**：
  * **主色提取**：Rust 端使用 K-Means 聚类算法在壁纸渲染前提取 3~5 种主导色（Dominant Colors）。
  * **图标反色保护**：分析任务栏区域壁纸的平均亮度（Luminance）。若亮度超过阈值（如 >0.7），自动将任务栏文字/图标切换为暗色模式；反之切换为亮色模式。
  * **系统主题色跟随**：可选开启修改注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` 的 `AccentColor`，使系统开始菜单与窗口边框配色随壁纸自动切换。

---

### 模块二：AI 2D 转 3D 视差壁纸引擎（Tauri 跨进程协同）

#### 2.1 本地单目深度估算预处理 (Rust 后端)
* **需求描述**：无需用户手动绘制深度图，一键完成 2D 静态图的 3D 空间结构提取。
* **详细逻辑**：
  * **模型加载**：Rust 后端集成 `ort` (ONNX Runtime) crate，配置 DirectML Execution Provider 绑定本地 GPU。
  * **处理流程**：前端发起 `generate_depth_map` 命令，Rust 后端在后台线程池异步运行 `Depth Anything v2` 模型，生成 16-bit 灰阶深度图。
  * **边缘平滑滤波**：Rust 端在内存中对比施加高斯模糊（Gaussian Blur）或导向滤波，平滑物体边缘锯齿。
  * **缓存机制**：生成的深度图由 Rust 缓存于 `app_cache_dir`，二次设置为壁纸时直接返回，无需重复推理。

#### 2.2 Shader 3D 视差实时渲染 (WebView2 前端)
* **需求描述**：根据鼠标移动实时计算视差，营造极具立体感的光学效果。
* **技术实现**：
  * WebView2 前端将原始 RGB 壁纸与生成的深度图加载为 WebGL 2.0 / WebGPU Texture。
  * **视差算法公式**：
    $$\text{UV}_{\text{offset}} = \text{UV}_{\text{orig}} + (\text{Mouse}_{\text{offset}} \times \text{Depth}_{\text{value}} \times \text{Parallax}_{\text{strength}})$$
  * **交互效果**：指针光标移动时，前景物体随鼠标大范围偏移，背景微幅收缩，呈现光学视差。
* **UI 控制参数**：前端提供“视差强度（Strength）”、“响应平滑度（Smoothing）”滑块供用户自定义。
* **性能要求**：纯 GPU Fragment Shader 计算，渲染状态下 GPU 占用率 <3%。

---

### 模块三：WASAPI 实时音频响应律动模块（Rust + WebGL 协作）

#### 3.1 WASAPI Loopback 采样与 FFT 转换 (Rust 端)
* **需求描述**：捕捉系统当前播放的所有音频，驱动壁纸视觉特效随音乐律动。
* **详细逻辑**：
  * **采样机制**：Rust 端通过 `cpal` 或原生 WASAPI Loopback 模式抓取系统默认渲染端点（如扬声器/耳机）的 PCM 音频数据流。
  * **环形缓冲区与 FFT**：Rust 后端维持 Ring Buffer，每 16ms 使用 `rustfft` 计算一次快速傅里叶变换，拆解为低音（Bass）、中音（Mid）、高音（Treble）三个频段。
  * **EMA 平滑**：施加指数移动平均算法：
    $$y_t = \alpha \cdot x_t + (1 - \alpha) \cdot y_{t-1}$$
  * **跨进程传输**：通过 Tauri Emit Event 或 WebSocket/IPC 毫秒级推送频带数据给 WebView2 前端，驱动 WebGL 粒子与光晕特效。

#### 3.2 异常处理与降级机制（Exclusive Mode 兼容）
* **需求描述**：针对部分 HIFI 播放器（如 Foobar2000）启用 WASAPI 独占模式（Exclusive Mode）时的容错。
* **处理逻辑**：Rust 捕获 WASAPI 设备锁定/采样异常，静默下发静音/退避信号，前端自动降级为平滑缓动状态，防止崩溃。

---

### 模块四：智能资源调度与低功耗控制 (0% 开销)

#### 4.1 全屏应用与游戏感知暂停
* **需求描述**：消除游戏玩家对壁纸后台占用 GPU/CPU 导致游戏掉帧的顾虑。
* **详细逻辑**：
  * **Shell Hook 监听**：Rust 后端注册 Windows Shell Event Hooks 及 DWM 状态监视，实时检测前台激活窗口是否为全屏应用（如 Steam 游戏、全屏视频等）。
  * **自动暂停**：识别到全屏应用时，Rust 向前端发送 `render-pause` 事件，取消 WebGL `requestAnimationFrame` 渲染，同时关闭音频抓包线程，CPU 与 GPU 资源开销**降至 0%**。
  * **智能恢复**：用户切回桌面时，100ms 内恢复 WebGL 渲染与音频同步。

---

### 模块五：Tauri 前端与系统能力协同

* **需求描述**：前端通过稳定的 Tauri Command/Event facade 使用系统能力，视图不直接依赖平台细节。
* **实现策略**：
  1. **UI 视图**：React 组件、CSS 与 WebView2 渲染保持统一的交互与视觉规范。
  2. **系统能力**：文件读写、窗口管理和壁纸控制通过 Rust `#[tauri::command]` 提供。
  3. **状态同步**：前端使用 `@tauri-apps/api/core` 的 `invoke` 与事件订阅更新完整应用状态。

---

## 4. 非功能性需求与性能指标 (NFR)

| 指标维度 | 目标要求 | Tauri 2.0 + Rust 实现保障 |
| :--- | :--- | :--- |
| **内存 (RAM) 占用** | **< 30MB - 50MB** | WebView2 共享系统引擎，无 Chromium 冗余打包 |
| **GPU 占用（渲染中）** | **< 3%** | WebGL 2.0 / WebGPU Fragment Shader 轻量计算 |
| **GPU/CPU 占用（全屏游戏）** | **0%** | Shell Hook 精准监听 + WebGL 帧循环彻底停止 |
| **CPU 占用（WASAPI律动）** | **< 1%** | Rust 原生多线程 FFT 极致性能 |
| **AI 深度预处理时间** | **< 1.5秒 / 张** | DirectML GPU 硬件加速 + Rust 无缝集成 |
| **安装包体积 (Installer)** | **< 15 MB** | 仅打包 Rust 二进制与 Web 前端编译产物 |
| **系统兼容性** | Windows 10 (1803+) / Windows 11 | 支持 Mica/Acrylic 及 Win32 API 自动降级处理 |

---

## 5. Tauri 2.0 实施路线图

```text
  ┌─────────────────────────────────────────────────────────────────┐
  │                 第一步：前端 UI 与业务逻辑完善                 │
  │ • 以 React 组件、CSS 与 Tauri facade 完成桌面交互             │
  │ • 通过 Rust Command 提供文件与图库系统能力                    │
  └─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                 第二步：Rust 底层核心扩展 (MVP)                 │
  │ • 编写 Rust DWM 任务栏透明与 Mica 效果模块                      │
  │ • 集成 `ort` (ONNX Runtime DirectML) 深度图推理引擎            │
  │ • 集成 WASAPI Loopback + FFT 音频处理模块                       │
  └─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                 第三步：WebGL 渲染与智能调度 (MVP)             │
  │ • 前端编写 WebGL 3D 视差 Shader 及音频律动 Canvas               │
  │ • Rust 实现 Shell 全屏监测，触发 WebGL 0% 占用暂停              │
  └─────────────────────────────────────────────────────────────────┘
```
