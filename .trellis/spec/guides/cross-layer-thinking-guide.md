# 跨层思维指南

> **目的**：实现之前，先理清跨层的数据流。

---

## 问题所在

**大多数 bug 发生在层边界**，而不是层内部。

常见跨层 bug：

- API 返回 A 格式，前端按 B 格式解析
- 数据库存 X，service 转成 Y，中途丢数据
- 多层各自实现了同一逻辑，实现却不一致

---

## 实现跨层功能之前

### 第一步：画出数据流

把数据的流动画出来：

```
Source → Transform → Store → Retrieve → Transform → Display
```

对每个箭头问：

- 数据此刻是什么格式？
- 可能出什么问题？
- 谁负责校验？

### 第二步：识别边界

| 边界                  | 常见问题                           |
| --------------------- | --------------------------------- |
| API ↔ Service         | 类型不匹配、字段缺失               |
| Service ↔ Database    | 格式转换、null 处理                |
| Backend ↔ Frontend    | 序列化、日期格式                   |
| Component ↔ Component | props 形状变化                     |

### 第三步：定义契约

对每个边界：

- 确切的输入格式是什么？
- 确切的输出格式是什么？
- 可能发生哪些错误？

---

## 常见跨层错误

### 错误 1：隐式格式假设

**坏**：不检查就假设日期格式

**好**：边界处显式格式转换

### 错误 2：校验散落

**坏**：同一件事在多层各校验一遍

**好**：入口处校验一次

### 错误 3：抽象泄漏

**坏**：组件知道数据库 schema

**好**：每层只认识自己的邻居

### 错误 4：每个消费者各自解析同一载荷

**坏**：命令读 JSONL 事件时就地 cast 字段：

```typescript
const thread = (ev as { thread?: string }).thread;
const labels = (ev as { labels?: string[] }).labels;
```

看起来是局部小事，实际意味着每个消费者都私有一份事件契约。下次字段变更就会改了一个命令、漏了另一个。

**好**：在事件边界解码一次，然后导出类型化的投影：

```typescript
if (!isThreadEvent(ev)) return false;
return ev.thread === filter.thread;
```

**规则**：对 append-only 日志、JSON 流、RPC 载荷或配置文件，为以下内容建立唯一所有者：

- 事件 / 载荷类型定义
- 从 `unknown` 出发的类型守卫与归一化
- UI 命令使用的元数据投影
- 从事实源重放状态的 reducer

渲染代码可以格式化字段，但不得重新定义载荷契约。

---

## 跨层功能清单

实现前：

- [ ] 画出了完整数据流
- [ ] 识别了所有层边界
- [ ] 定义了每个边界的格式
- [ ] 决定了校验发生在哪

实现后：

- [ ] 用边界情况测过（null、空、非法）
- [ ] 验证了每个边界的错误处理
- [ ] 确认数据能完整往返
- [ ] 确认消费者 import 共享解码器 / 投影，而不是本地 cast 载荷字段
- [ ] 确认派生状态指回源事件标识（`seq`、`id`、`version`），而不是发明第二个游标

---

## 跨平台模板一致性

在 Trellis 中，命令模板（如 `record-session.md`）在**多个平台**下存在内容相同或近乎相同的副本。这是一个跨层边界。

### 清单：修改任何命令模板之后

- [ ] 找出所有有同名命令的平台：`find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] 更新所有平台副本（Markdown `.md` 与 TOML `.toml`）
- [ ] Gemini TOML：适配行续接（`\\` vs `\`）和三引号字符串
- [ ] 运行 `/trellis:check-cross-layer` 确认没有遗漏

**真实案例**：更新了 Claude 平台的 `record-session.md` 使用 `--mode record`，但忘了 iFlow、Kilo、OpenCode 和 Gemini——靠跨层检查兜住的。

---

## 运行时解析模板的升级一致性

有些生成文件既是文档又是运行时输入。在 Trellis 中，`.trellis/workflow.md` 被 `get_context.py`、`workflow_phase.py`、SessionStart 过滤器和逐轮 hook 解析。模板变更必须同时对全新 init 和升级两条路径验证。

### 清单：修改被运行时解析的模板之后

- [ ] 找出每个读取该模板的运行时解析器，而不只是安装它的文件写入器
- [ ] 检查相关语法是否位于标签块等显式受管区域之外
- [ ] 验证全新 `init` 输出，以及写入旧版 `.trellis/.version` 的版本化 `update` 场景
- [ ] 用旧版原始模板 fixture 加一条升级回归，断言安装后的文件达到当前打包形态
- [ ] 更新拥有该运行时契约的后端 spec

---

## 版本化文档边界

版本化文档是一个跨层边界：源码路径、`docs.json` 版本路由和渲染出的版本选择器必须描述同一条发布线。

### 清单：编辑版本化文档之前

- [ ] 确定目标发布线：stable、beta 还是 RC
- [ ] 核实编辑的 MDX 路径与该发布线匹配：
  - stable：`docs-site/{start,advanced,...}` 与 `docs-site/zh/{start,advanced,...}`
  - beta：`docs-site/beta/**` 与 `docs-site/zh/beta/**`
  - RC：`docs-site/rc/**` 与 `docs-site/zh/rc/**`
- [ ] 核实 `docs.json` 导航把版本标签指向同样的路径
- [ ] 提交前对另一棵目录树 grep 发布线专属术语
- [ ] 在根发布路径下出现 beta 内容，按源码路径 bug 处理，不是渲染 bug

**真实案例**：一个仅 beta 的任务工作流变更，把 `prd.md` + `design.md` + `implement.md`、建任务同意和 Codex 模式横幅写在了根路径 `start/` 和 `advanced/` 下。结果文档站在 Release 选择器下输出了 0.6 beta 行为。修复：恢复根发布文档、把 0.6 内容移到 `beta/` 和 `zh/beta/`，并对根发布树加 grep 审计 beta 标记。

**真实案例**：Codex 内联模式把工作流平台标记从 `[Codex]` / `[Kilo, Antigravity, Windsurf]` 改成了 `[codex-sub-agent]` / `[codex-inline, Kilo, Antigravity, Windsurf]`。全新 init 正确，但 `trellis update` 只合并 `[workflow-state:*]` 块、保留了块外的旧标记。结果：升级后的项目拿到了新 hook 脚本却带着旧工作流路由，`get_context.py --mode phase --platform codex` 可能返回空的 Phase 2.1 详情。

---

## 模式探测清单

当 CLI 通过探测远端资源自动判定模式时（如检查 `index.json` 是否存在来决定 marketplace 还是直连下载）：

### 实现前：

- [ ] 探测在**所有**使用其结果的代码路径都运行（interactive、`-y`、`--flag` 各种组合）
- [ ] 区分 404 与瞬时错误——不要都当"不存在"
- [ ] 瞬时错误**中止或重试**，绝不静默切换模式
- [ ] 上下文变化时（如用户切换来源）**重置**共享状态（缓存、预取数据）
- [ ] **快捷路径**（如 `--template` 跳过选择器）必须具备与探测路径同级的错误处理——检查下游函数有没有调兜底包装

### 实现后：

- [ ] 从探测结果到模式判定分支的每条路径都追踪过——没有漏判
- [ ] 外部格式契约（giget URI、raw URL）有测试或至少有注释文档
- [ ] 元数据读取要么消费完整响应，要么用流式解析器——绝不把固定大小前缀当完整 JSON 解析
- [ ] 从解析片段重建复合标识符时，核实**所有**字段都在且**位置正确**（是 `provider:repo/path#ref` 不是 `provider:repo#ref/path`）
- [ ] 核实快捷路径之后调用的**动作函数**内部没有继续用旧的兜底 fetch——错误区分有意义的场景必须用探测级变体

**真实案例**：自定义 registry 流程在 3 轮评审中共修了 8 个 bug：(1) 探测只在交互模式运行，(2) 瞬时错误落入错误模式，(3) giget URI 的 `#ref` 位置错误，(4) 预取模板跨来源切换泄漏，(5) `--template` 快捷路径绕过探测但 `downloadTemplateById` 内部用兜底 `fetchTemplateIndex`，把超时变成"Template not found"。

**真实案例**：agent 会话更新提示用 `response.read(4096)` 读 npm `latest` 元数据然后当完整 JSON 解析。`@mindfoldhq/trellis` 的包元数据超过 4 KB，JSON 被截断、解析静默失败，首轮会话注入没有更新提示。修复：解析前读完整响应，并加一条 `version` 后跟 8 KB 元数据尾部的回归。

---

## 何时编写流程文档

以下情况写详细的流程文档：

- 功能横跨 3+ 层
- 多团队参与
- 数据格式复杂
- 该功能之前出过 bug

---

## 事件日志 / 投影边界

Append-only 日志是跨层契约。单个事件会流经：

```
CLI input → event writer → events.jsonl → reader → filter → reducer → display
```

### 清单：新增事件类型或字段之后

- [ ] 把事件类型加进中央事件分类表
- [ ] 在事件层加类型化事件变体或类型守卫
- [ ] 为来自用户输入或 JSON 的数组/对象字段加归一化辅助函数
- [ ] `seq` / `id` 分配只留在事件写入器里
- [ ] 过滤器和 reducer 消费类型化事件守卫，不用本地 cast
- [ ] 展示代码消费 reducer 输出或类型化事件，不消费原始 JSON
- [ ] 至少加一条回归，证明历史重放与实时过滤使用同一过滤模型

**真实案例**：Thread channel 加了 `kind: "thread"`、`description`、`context`、labels 和 `lastSeq`。第一版正确重放了 thread 状态，但若干命令仍在用本地 cast 重新解析事件载荷字段。修复：让核心事件层持有 `ThreadChannelEvent` 和 `isThreadEvent`，让 `reduceChannelMetadata` 成为唯一的 channel 元数据投影，让 `reduceThreads` 成为唯一的 thread 重放 reducer。
