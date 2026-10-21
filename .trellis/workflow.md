# 开发工作流

---

## 核心原则

1. **先计划后写码** —— 动手前先想清楚要做什么
2. **规范靠注入，不靠记忆** —— 指南通过 hook/skill 注入，而不是靠回忆
3. **一切落盘** —— 研究、决策、经验都写进文件；对话会被压缩，文件不会
4. **增量开发** —— 一次一个任务
5. **沉淀经验** —— 每个任务结束后回顾，把新知识回写到 spec

---

## Trellis 系统

### 开发者身份

首次使用时初始化身份：

```bash
python ./.trellis/scripts/init_developer.py <你的名字>
```

会创建 `.trellis/.developer`（已 gitignore）+ `.trellis/workspace/<你的名字>/`。

### 规范系统

`.trellis/spec/` 按包（package）和层（layer）组织编码指南。

- `.trellis/spec/<package>/<layer>/index.md` —— 入口，含**开发前检查清单** + **质量检查**。具体指南在它指向的 `.md` 文件里。
- `.trellis/spec/guides/index.md` —— 跨包的通用思维指南。

```bash
python ./.trellis/scripts/get_context.py --mode packages   # 列出包 / 层
```

**何时更新 spec**：发现新模式/约定 · 要把防 bug 的经验固化下来 · 有新的技术决策。

### 任务系统

每个任务在 `.trellis/tasks/{MM-DD-name}/` 下有独立目录，包含 `task.json`、`prd.md`、可选 `design.md`、可选 `implement.md`、可选 `research/`，以及供支持子代理的平台使用的上下文清单（`implement.jsonl`、`check.jsonl`）。

```bash
# 任务生命周期
python ./.trellis/scripts/task.py create "<标题>" [--slug <名字>] [--parent <目录>]
python ./.trellis/scripts/task.py start <名字>          # 设置活动任务（有会话身份时为会话级）
python ./.trellis/scripts/task.py current --source      # 显示活动任务及来源
python ./.trellis/scripts/task.py finish                # 清除活动任务（触发 after_finish 钩子）
python ./.trellis/scripts/task.py archive <名字>        # 移入 archive/{年-月}/
python ./.trellis/scripts/task.py list [--mine] [--status <s>]
python ./.trellis/scripts/task.py list-archive

# 代码-规范上下文（经 JSONL 注入给 implement/check 子代理）。
# `implement.jsonl` / `check.jsonl` 在 `task create` 时播种（空文件）；规划阶段由 AI 填入真实的
# spec + research 条目。`validate` 会失败、`start` 会拒绝，只要播种的清单还是空的——
# 否则子代理将在零规范上下文下运行。确属有意为之时传 `start --allow-empty-context`。
python ./.trellis/scripts/task.py add-context <名字> <action> <文件> <原因>
python ./.trellis/scripts/task.py list-context <名字> [action]
python ./.trellis/scripts/task.py validate <名字>

# 任务元数据
python ./.trellis/scripts/task.py set-branch <名字> <分支>
python ./.trellis/scripts/task.py set-base-branch <名字> <分支>    # PR 目标分支
python ./.trellis/scripts/task.py set-scope <名字> <scope>

# 层级（父/子任务）
python ./.trellis/scripts/task.py add-subtask <父> <子>
python ./.trellis/scripts/task.py remove-subtask <父> <子>

# 创建 PR
python ./.trellis/scripts/task.py create-pr [名字] [--dry-run]
```

> 运行 `python ./.trellis/scripts/task.py --help` 查看权威、最新的命令列表。

**当前任务机制**：`task.py create` 创建任务目录，并在（有会话身份时）自动设置会话级活动任务指针，让规划阶段的面包屑立即生效。`task.py start` 写入同一个指针（已设置则幂等），并把 `task.json.status` 从 `planning` 翻转为 `in_progress`。状态存放在 `.trellis/.runtime/sessions/` 下。如果 hook 输入、`TRELLIS_CONTEXT_ID` 或平台原生会话环境变量都提供不了上下文键，就没有活动任务，`task.py start` 会报会话身份提示错误。`task.py finish` 删除当前会话文件（状态不变）。`task.py archive <task>` 写入 `status=completed`、把目录移入 `archive/`，并删除仍指向该任务的运行时会话文件。

### 工作区系统

在 `.trellis/workspace/<开发者>/` 下记录每次 AI 会话，用于跨会话追踪。

- `journal-N.md` —— 会话日志。**每文件最多 2000 行**；超限自动创建 `journal-(N+1).md`。
- `index.md` —— 个人索引（总会话数、最近活跃）。

```bash
python ./.trellis/scripts/add_session.py --title "标题" --commit "哈希" --summary "摘要"
```

### 上下文脚本

```bash
python ./.trellis/scripts/get_context.py                            # 完整会话运行时
python ./.trellis/scripts/get_context.py --mode packages            # 可用包 + spec 层
python ./.trellis/scripts/get_context.py --mode phase --step <X.Y>  # 某个工作流步骤的详细指南
```

---

<!--
  WORKFLOW-STATE 面包屑契约（编辑下方标签块前先读这段）

  下方 ## Phase Index 小节里内嵌的 [workflow-state:STATUS] 块，是每个受支持
  AI 平台的 UserPromptSubmit hook 读取的逐轮 <workflow-state> 面包屑的
  唯一事实源。inject-workflow-state.py（Python 平台）和
  inject-workflow-state.js（OpenCode 插件）只做解析——v0.5.0-rc.0 之后
  脚本里没有内置的兜底字典。

  STATUS 字符集：[A-Za-z0-9_-]+。当 hook 找不到标签时，会退化为一条通用的
  "Refer to workflow.md for current step." —— 故意可见，让用户注意到并修复
  损坏的 workflow.md。

  不变量（test/regression.test.ts）：
    工作流走查中每个标记为 `[required · once]` 的步骤，必须在其所属阶段
    的 [workflow-state:*] 块中有一行对应的强制提示。面包屑是唯一的逐轮
    通道；如果某个强制步骤没写进去，AI 会悄悄跳过它（Phase 1 规划门禁
    被跳过、Phase 3.4 提交被跳过，都是这样发生的）。

  标签 ↔ 阶段对应：
    [workflow-state:no_task]      → 无活动任务；Phase 1 之前
    [workflow-state:task_error]   → 活动任务记录不可读；先修复再继续
    [workflow-state:planning]     → 整个 Phase 1（status='planning'）
    [workflow-state:planning-inline] → Codex 内联变体的 Phase 1
    [workflow-state:in_progress]  → Phase 2 + Phase 3.2-3.4
                                    （status 从 task.py start 到 task.py
                                    archive 一直保持 'in_progress'）
    [workflow-state:in_progress-inline] → Codex 内联变体的 Phase 2/3
    [workflow-state:completed]    → 目前是死状态：cmd_archive 在同一调用里
                                    翻转 status 并移动目录，解析器因此
                                    丢失指针（块保留给未来显式的
                                    in_progress→completed 转换）

  编辑检查清单：
    - 改了某个 [workflow-state:STATUS] 块后，同时检查对应阶段的
      `[required · once]` 走查步骤是否同步
    - 编辑后运行 `trellis update` 把新内容推给下游用户项目（块级受管替换）
    - 完整运行时契约：
      .trellis/spec/cli/backend/workflow-state-contract.md
-->

## 阶段索引

```
Phase 1: Plan    → 分类请求、征得建任务同意，然后写规划产物
Phase 2: Execute → 任务状态为 in_progress 后才能实现
Phase 3: Finish  → 验证、更新 spec、提交、收尾
```

### 请求分诊

- 简单对话或小任务：只问一句"这一轮要不要建 Trellis 任务"。用户说不建，本次会话就跳过 Trellis。
- 复杂任务：询问能否建 Trellis 任务并进入规划。用户拒绝，则不要大范围内联实现；解释、澄清范围，或建议更小的拆分。
- 用户同意建任务 ≠ 同意开始实现。规划仍然先行。

### 规划产物

- `prd.md` —— 需求、约束、验收标准。不要把技术设计或执行清单写在这里。
- `design.md` —— 复杂任务的技术设计：边界、契约、数据流、权衡、兼容性、上线/回滚形态。
- `implement.md` —— 复杂任务的执行计划：有序清单、验证命令、评审门禁、回滚点。
- `implement.jsonl` / `check.jsonl` —— 面向子代理上下文的规范与研究清单。它们不能替代 `implement.md`。
- 轻量任务可以只有 PRD。复杂任务必须在 `task.py start` 前具备 `prd.md`、`design.md`、`implement.md`。

### 父/子任务树

当一个用户请求包含多个可独立验证的交付物时使用父任务。父任务持有需求来源、任务地图、跨子任务验收标准和最终集成评审；通常不应作为实现目标，除非它自身也有直接工作。

子任务用于可独立规划、实现、检查、归档的交付物。父子结构不是依赖系统：如果某个子任务必须等另一个，把先后顺序写进子任务的 `prd.md` / `implement.md`，并保证每个子任务的验收标准可独立测试。

用 `task.py create "<标题>" --slug <名字> --parent <父目录>` 创建新子任务。用 `task.py add-subtask <父> <子>` 关联已有任务，用 `task.py remove-subtask <父> <子>` 解除错误关联。

<!-- 逐轮面包屑：无活动任务时显示（Phase 1 之前） -->

[workflow-state:no_task]
当前没有活动任务。先对当前这轮请求分类，并在创建任何 Trellis 任务之前征得建任务同意。
简单对话 / 小任务：只问这一轮要不要建 Trellis 任务。用户说不建，本次会话跳过 Trellis。
复杂任务：询问用户能否建 Trellis 任务并进入规划阶段。用户拒绝，则解释、澄清范围，或建议更小的拆分。
[/workflow-state:no_task]

<!-- 逐轮面包屑：活动任务记录不可读时显示。 -->

[workflow-state:task_error]
活动任务记录无法读取。不要创建或激活别的任务。
检查上方任务目录并修复其 task.json。它必须是合法 JSON 对象且 status 非空。
保留既有任务字段与产物。若无法安全确定正确状态，先询问用户再重建记录。
[/workflow-state:task_error]

### Phase 1：Plan（规划）
- 1.0 创建任务 `[required · once]`（仅在征得建任务同意后）
- 1.1 需求探索 `[required · repeatable]`（`prd.md`；复杂任务还需 `design.md` + `implement.md`）
- 1.2 研究 `[optional · repeatable]`
- 1.3 配置上下文 `[required · once]` —— Claude Code、Cursor、OpenCode、Codex、Kiro、Gemini、Qoder、CodeBuddy、Copilot、Droid、Pi、Oh My Pi、ZCode、Snow、Reasonix、Trae、Grok、Kimi Code（仅子代理派发平台；内联平台跳过）
- 1.4 激活任务 `[required · once]`（评审门禁，然后 `task.py start`；status → in_progress）
- 1.5 完成标准

<!-- 逐轮面包屑：整个 Phase 1 期间显示（status='planning'） -->

[workflow-state:planning]
加载 `trellis-brainstorm`；保持在规划阶段。
轻量任务：`prd.md` 即可。复杂任务：完成 `prd.md`、`design.md`、`implement.md`，并在 `task.py start` 前请求评审。
多交付物范围：考虑父任务 + 可独立验证的子任务；依赖关系必须写在子任务产物里，不能靠树形位置隐含。
子代理模式：在 start 前把 `implement.jsonl` 和 `check.jsonl` 整理成规范/研究清单。
[/workflow-state:planning]

<!-- 逐轮面包屑：status='in_progress' 且 codex.dispatch_mode=inline 时显示。
     Codex 专属的 Phase 1 替代块。主会话直接改码，跳过 jsonl 整理 ——
     Phase 2 通过 `trellis-before-dev` 读取产物/规范。 -->

[workflow-state:planning-inline]
加载 `trellis-brainstorm`；保持在规划阶段。
轻量任务：`prd.md` 即可。复杂任务：完成 `prd.md`、`design.md`、`implement.md`，并在 `task.py start` 前请求评审。
多交付物范围：考虑父任务 + 可独立验证的子任务；依赖关系必须写在子任务产物里，不能靠树形位置隐含。
内联模式：跳过 jsonl 整理；Phase 2 经 `trellis-before-dev` 读取产物/规范。
[/workflow-state:planning-inline]

### Phase 2：Execute（执行）
- 2.1 实现 `[required · repeatable]`
- 2.2 质量检查 `[required · repeatable]`
- 2.3 回滚 `[按需]`

<!-- 逐轮面包屑：status='in_progress' 期间显示。
     覆盖范围：整个 Phase 2 + Phase 3.2-3.4（status 从 task.py start 到
     task.py archive 一直是 'in_progress'；只有 archive 会翻转）。
     因此正文必须覆盖从实现到提交的全部强制步骤，包括 Phase 3.3 的 spec
     更新和 Phase 3.4 的提交。 -->

子代理派发协议适用于所有平台和所有子代理，包括原生 Codex `SubagentStart` 上下文注入（子侧拉取兜底）、class-2 Gemini/Qoder/Copilot/Reasonix/Trae/Grok/Kimi Code、带 hook 的 ZCode/Snow，以及 `trellis-research`：每次派发提示词必须以 `Active task: <task path from task.py current>` 开头，再写角色专属指令。Grok Build 上用 `spawn_subagent` 并把 `subagent_type` 设为 Trellis 代理名（如 `trellis-implement`）。Kimi Code 上派发内置 `coder` / `explore` 子代理，并附带对应 `.kimi-code/skills/trellis-<role>/SKILL.md` 指令。

[workflow-state:in_progress]
工具说明：`trellis-implement` / `trellis-research` 只是子代理类型（Task/Agent 工具，不是 Skill；没有同名 skill）。`trellis-update-spec` 是 skill。`trellis-check` 两者皆有；代码改动后的验证优先用 Agent 形态。
流程：`trellis-implement` → `trellis-check` → `trellis-update-spec` → 提交（Phase 3.4）→ `/trellis:finish-work`。
主会话默认：派发 implement/check 子代理。子代理自我豁免：若你已是 `trellis-implement`，不要再派生 `trellis-implement` 或 `trellis-check`；若你已是 `trellis-check`，不要再派生 `trellis-check` 或 `trellis-implement`。派发只发生在主会话。
派发提示词以 `Active task: <task path from task.py current>` 开头。读取顺序：jsonl 条目 → `prd.md` → `design.md`（若有）→ `implement.md`（若有）。
[/workflow-state:in_progress]

<!-- 逐轮面包屑：status='in_progress' 且 codex.dispatch_mode=inline 时显示。
     Codex 专属的 Phase 2/3 替代块。主会话直接改码而非派发子代理。 -->

[workflow-state:in_progress-inline]
流程：`trellis-before-dev` → 编辑 → `trellis-check` → 验证 → `trellis-update-spec` → 提交（Phase 3.4）→ `/trellis:finish-work`。
内联模式下不要派发 implement/check 子代理。
读取顺序：`prd.md` → `design.md`（若有）→ `implement.md`（若有），外加 skill 加载的相关规范/研究材料。
[/workflow-state:in_progress-inline]

### Phase 3：Finish（收尾）
- 3.2 Debug 复盘 `[按需]`
- 3.3 Spec 更新 `[required · once]`
- 3.4 提交变更 `[required · once]`
- 3.5 收尾提醒

> 注：原 3.1 已并入 2.2（最后一轮全量检查）和 3.4（提交前导）。编号保持不变以免破坏外部引用。

<!-- 逐轮面包屑：status='completed' 时显示。
     正常流程中当前是死状态：cmd_archive 在同一调用里写入 status='completed'
     并移动任务目录，活动任务解析器因此丢失指针，hook 不会在已归档任务上
     触发。块保留给未来的状态转换重构（如显式的 in_progress→completed 命令）。
     通过与存活块相同的通道编辑。 -->

[workflow-state:completed]
代码已提交。运行 `/trellis:finish-work`；若工作区仍有脏文件，先回到 Phase 3.4。
[/workflow-state:completed]

### 规则

1. 判断当前所处 Phase，从其中的下一步继续
2. 每个 Phase 内按顺序执行；`[required]` 步骤不可跳过
3. Phase 可以回退（如 Execute 中发现 prd 缺陷 → 回到 Plan 修复，再进 Execute）
4. 标记 `[once]` 的步骤，输出已存在则跳过；不要重跑
5. 产物存在性决定下一步；轻量任务缺 `design.md` / `implement.md` 是合法的，复杂任务缺则是规划未完成

### 活动任务路由

活动任务内，用户请求匹配以下意图时先路由，再按需加载详细阶段步骤。

[Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

- 规划或需求不清 → `trellis-brainstorm`。
- `in_progress` 的实现/检查 → 派发 `trellis-implement` / `trellis-check`。
- 反复调试 → `trellis-break-loop`；更新规范 → `trellis-update-spec`。

[/Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

[codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

- 规划或需求不清 → `trellis-brainstorm`。
- 改码前 → `trellis-before-dev`；改码后 → `trellis-check`。
- 反复调试 → `trellis-break-loop`；更新规范 → `trellis-update-spec`。

[/codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

### 护栏

- 建任务同意 ≠ 实现同意；实现要等产物评审后的 `task.py start`。
- 轻量任务 PRD-only 合法；复杂任务需要 `design.md` + `implement.md`。
- 规划必须落盘到任务产物；汇报完成前必须跑过检查。

### 加载步骤详情

每一步都可以运行以下命令获取详细指引：

```bash
python ./.trellis/scripts/get_context.py --mode phase --step <step>
# 例如：python ./.trellis/scripts/get_context.py --mode phase --step 1.1
```

---

## Phase 1：Plan（规划）

目标：对请求分类，需要任务时征得建任务同意，并在实现前产出所需的规划产物。

#### 1.0 创建任务 `[required · once]`

仅在征得建任务同意后创建任务目录。命令会把 status 设为 `planning`、写入 `task.json`、创建默认 `prd.md`，并在有会话身份时自动指向新任务：

```bash
python ./.trellis/scripts/task.py create "<任务标题>" --slug <名字>
```

`--slug` 只是可读名字。**不要**带 `MM-DD-` 日期前缀；`task.py create` 会自动加。

任务树场景：先建父任务，再用 `--parent <父目录>` 建每个子任务。不要因为子任务存在就去 start 父任务；start 拥有下一个可独立验证交付物的那个子任务。

命令成功后，逐轮面包屑自动切到 `[workflow-state:planning]`，提示 AI 保持在规划阶段。

这里只运行 `create` —— 不要接着运行 `start`。`start` 会把 status 翻转为 `in_progress`，在规划产物评审前就切到实现阶段。`start` 留给步骤 1.4。

若 `python ./.trellis/scripts/task.py current --source` 已指向某任务，则跳过本步。

#### 1.1 需求探索 `[required · repeatable]`

加载 `trellis-brainstorm` skill，按其指引与用户交互式探索需求。

brainstorm skill 会引导你：
- 一次只问一个问题
- 能自己研究就不问用户
- 优先给选项，少问开放式问题
- 用户每次回答后立即更新 `prd.md`
- 交付物可独立验证时，把大范围拆成父任务 + 子任务
- `prd.md` 只放需求与验收标准
- 复杂任务在实现开始前产出 `design.md` 和 `implement.md`

考虑父子拆分时：
- 一个请求包含多个可独立验证的交付物时才用父任务。
- 父任务持有需求来源、子任务地图、跨子任务验收标准和最终集成评审。
- 子任务持有可独立规划、实现、检查、归档的实际交付物。
- 父子结构不是依赖系统。子任务 B 依赖 A 时，把顺序写进 B 的 `prd.md` / `implement.md`。
- start 拥有下一个交付物的子任务。父任务自身没有直接实现工作就不要 start。

需求变化时随时回到本步修订相应产物。

#### 1.2 研究 `[optional · repeatable]`

研究可在需求探索期间随时进行。不限于本地代码——可以用任何可用工具（MCP server、skill、网页搜索等）查外部信息，包括三方库文档、业界实践、API 参考等。

[Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

派发研究子代理：

- **Agent 类型**：`trellis-research`
- **任务描述**：Research <具体问题>
- **关键要求**：研究产出必须落盘到 `{TASK_DIR}/research/`

[/Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

[codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

在主会话直接研究，把结论写进 `{TASK_DIR}/research/`。`codex-inline` 是明确把工作留在主会话的模式。

[/codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

**研究产物约定**：
- 每个研究主题一个文件（如 `research/auth-library-comparison.md`）
- 三方库用法示例、API 参考、版本约束记在文件里
- 记下发现的 relevant spec 文件路径，方便后续引用

Brainstorm 与研究可自由穿插——暂停去查个技术问题，再回来跟用户聊。

**关键原则**：研究产出必须写进文件，不能只留在聊天里。对话会被压缩；文件不会。

#### 1.3 配置上下文 `[required · once]`

[Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

整理 `implement.jsonl` 和 `check.jsonl`，让 Phase 2 的子代理拿到正确的规范/研究上下文。这两个文件在 `task create` 时播种了一条自描述的 `_example` 行；你要做的是填入真实条目。

**位置**：`{TASK_DIR}/implement.jsonl` 与 `{TASK_DIR}/check.jsonl`（已存在）。

**格式**：每行一个 JSON 对象 —— `{"file": "<路径>", "reason": "<原因>"}`。路径相对仓库根。

**放什么**：
- **Spec 文件** —— `.trellis/spec/<package>/<layer>/index.md` 及与本任务相关的具体指南文件（`error-handling.md`、`conventions.md` 等）
- **研究文件** —— 子代理需要参考的 `{TASK_DIR}/research/*.md`

**不放什么**：
- 代码文件（`src/**`、`packages/**/*.ts` 等）—— 那些由子代理实现时自行阅读，不在此预注册
- 你即将修改的文件 —— 同理

**两个文件怎么分工**：
- `implement.jsonl` → 实现子代理正确写码所需的规范 + 研究
- `check.jsonl` → 检查子代理所需的规范（质量指南、检查约定，研究文件按需同放）

这些清单不能替代 `implement.md`。`implement.md` 是复杂任务的人类可读执行计划；jsonl 只列出要注入/加载的上下文文件。

**如何发现相关规范**：

```bash
python ./.trellis/scripts/get_context.py --mode packages
```

列出所有包及其 spec 层路径。挑与本任务领域匹配的条目。

**如何追加条目**：

直接在编辑器里改 jsonl 文件，或用：

```bash
python ./.trellis/scripts/task.py add-context "$TASK_DIR" implement "<路径>" "<原因>"
python ./.trellis/scripts/task.py add-context "$TASK_DIR" check "<路径>" "<原因>"
```

有了真实条目后可删掉播种的 `_example` 行（可选——消费方会自动跳过它）。

就绪门禁：`implement.jsonl` 和 `check.jsonl` 都必须至少含一条真实 `{"file": "...", "reason": "..."}` 条目才能 `task.py start`。只有播种的 `_example` 行不算就绪。

两个文件都已有真实整理条目时才可跳过本步。

[/Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

[codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

跳过本步。上下文由 Phase 2 的 `trellis-before-dev` skill 直接加载。

[/codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

#### 1.4 激活任务 `[required · once]`

产物评审通过后，把任务状态翻转为 `in_progress`：

```bash
python ./.trellis/scripts/task.py start <任务目录>
```

轻量任务 `prd.md` 即可。复杂任务的 `prd.md`、`design.md`、`implement.md` 必须齐备并经评审后才能 start。子代理派发平台上，`implement.jsonl` 与 `check.jsonl` 都必须有真实整理条目才能 start。运行时消费方对缺失或仅播种的清单保持兼容，但那不是规划就绪状态。

命令成功后，面包屑自动切到 `[workflow-state:in_progress]`，后续进入 Phase 2 / 3。

如果 `task.py start` 报会话身份错误（hook 输入、`TRELLIS_CONTEXT_ID`、平台原生会话环境变量都没有上下文键），按错误提示设置会话身份后重试。

#### 1.5 完成标准

| 条件 | 必须 |
|------|:---:|
| `prd.md` 存在 | ✅ |
| 用户确认任务可进入实现 | ✅ |
| 已运行 `task.py start`（status = in_progress） | ✅ |
| `research/` 有产物（复杂任务） | 建议 |
| `design.md` 存在（复杂任务） | ✅ |
| `implement.md` 存在（复杂任务） | ✅ |

[Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

| `implement.jsonl` 与 `check.jsonl` 各含至少一条真实整理条目（播种行不算） | ✅ |

[/Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

---

## Phase 2：Execute（执行）

目标：把评审过的规划产物变成通过质量检查的代码。

#### 2.1 实现 `[required · repeatable]`

[Claude Code, Cursor, OpenCode, codex-sub-agent, CodeBuddy, Droid, Pi, ZCode, Snow, Oh My Pi]

派发实现子代理：

- **Agent 类型**：`trellis-implement`
- **任务描述**：按评审过的任务产物实现，参考 `{TASK_DIR}/research/` 下的材料；收尾运行项目 lint 和类型检查
- **派发提示词守则**：提示词必须以 `Active task: <task path>` 开头，然后告知被派生的 agent 它已经是 `trellis-implement` 子代理，直接实现，不要再派生 `trellis-implement` / `trellis-check`。

平台 hook/插件自动处理：
- 读取 `implement.jsonl`，把引用的规范/研究文件注入 agent 提示词
- 注入 `prd.md`、`design.md`（若有）和 `implement.md`（若有）
- Codex 由 `SubagentStart` 提供原生上下文注入；agent profile 保留子侧加载作为兜底

[/Claude Code, Cursor, OpenCode, codex-sub-agent, CodeBuddy, Droid, Pi, ZCode, Snow, Oh My Pi]

[Gemini, Qoder, Copilot, Reasonix, Trae, Grok, Kimi Code]

派发实现子代理：

- **Agent 类型**：`trellis-implement`
- **任务描述**：按评审过的任务产物实现，参考 `{TASK_DIR}/research/` 下的材料；收尾运行项目 lint 和类型检查
- **派发提示词守则**：提示词必须以 `Active task: <task path>` 开头，并明确告知被派生 agent 它已是 `trellis-implement`，直接实现、不要再派生 `trellis-implement` / `trellis-check`。

拉取式子代理定义自动处理上下文加载要求：
- 用 `task.py current --source` 解析活动任务，再读 `prd.md`、`design.md`（若有）、`implement.md`（若有）
- 读取 `implement.jsonl`，要求 agent 写码前加载每个引用的规范/研究文件

[/Gemini, Qoder, Copilot, Reasonix, Trae, Grok, Kimi Code]

[Kiro]

派发实现子代理：

- **Agent 类型**：`trellis-implement`
- **任务描述**：按评审过的任务产物实现，参考 `{TASK_DIR}/research/` 下的材料；收尾运行项目 lint 和类型检查
- **派发提示词守则**：告知被派生 agent 它已是 `trellis-implement` 子代理，直接实现，不要再派生 `trellis-implement` / `trellis-check`。

平台前置脚本自动处理上下文加载要求：
- 读取 `implement.jsonl`，把引用的规范/研究文件注入 agent 提示词
- 注入 `prd.md`、`design.md`（若有）和 `implement.md`（若有）

[/Kiro]

[codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

1. 加载 `trellis-before-dev` skill 阅读项目指南
2. 读 `{TASK_DIR}/prd.md`，然后 `design.md`（若有），再 `implement.md`（若有）
3. 参考 `{TASK_DIR}/research/` 下的材料
4. 按评审过的产物实现代码
5. 运行项目 lint 和类型检查

[/codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

#### 2.2 质量检查 `[required · repeatable]`

[Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

派发检查子代理：

- **Agent 类型**：`trellis-check`
- **任务描述**：对照规范和任务产物审查全部代码变更；直接修复发现的问题；确保 lint 和类型检查通过
- **派发提示词守则**：提示词必须以 `Active task: <task path>` 开头，然后告知被派生 agent 它已经是 `trellis-check` 子代理，直接审查/修复，不要再派生 `trellis-check` / `trellis-implement`。

检查代理的职责：
- 对照规范审查代码变更
- 对照 `prd.md`、`design.md`（若有）、`implement.md`（若有）审查代码变更
- 自动修复发现的问题
- 运行 lint 和 typecheck 验证

[/Claude Code, Cursor, OpenCode, codex-sub-agent, Kiro, Gemini, Qoder, CodeBuddy, Copilot, Droid, Pi, Oh My Pi, ZCode, Snow, Reasonix, Trae, Grok, Kimi Code]

[codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

加载 `trellis-check` skill，按其指引验证代码：
- 规范符合性
- lint / 类型检查 / 测试
- 跨层一致性（变更跨层时）

发现问题 → 修复 → 再查，直到全绿。

[/codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]

**收尾全量检查（Phase 3.4 提交前）**：任务的最后一个 2.2 必须全量跑，而不是只查最新一块实现。用 `python ./.trellis/scripts/get_context.py --mode packages` 列出所有受影响包，然后加载每个包 spec 索引的 Quality Check 小节。这能抓住迭代中途的局部 2.2 查不到的跨层/多包问题。

#### 2.3 回滚 `[按需]`

- `check` 发现 prd 缺陷 → 回 Phase 1 修 `prd.md`，然后重做 2.1
- 实现走偏 → 回滚代码，重做 2.1
- 需要更多研究 → 研究（同 Phase 1.2），结论写进 `research/`

---

## Phase 3：Finish（收尾）

目标：保证代码质量，沉淀经验，记录工作。

#### 3.2 Debug 复盘 `[按需]`

如果本任务经历了反复调试（同一问题修了多次），加载 `trellis-break-loop` skill：
- 给根因分类
- 解释为什么之前的修复失败
- 提出预防措施

目的是沉淀调试经验，让同类问题不再复发。

#### 3.3 Spec 更新 `[required · once]`

加载 `trellis-update-spec` skill，回顾本任务是否产生了值得记录的新知识：
- 新发现的模式或约定
- 踩过的坑
- 新的技术决策

据此更新 `.trellis/spec/` 下的文档。哪怕结论是"没有可更新的"，也要走一遍这个判断。

#### 3.4 提交变更 `[required · once]`

**Spec 同步前导**：起草提交前先问：本任务是否修了 bug、或浮现了应该写进 `.trellis/spec/` 的非显而易见的知识，让未来的你（或未来 AI）不再踩坑？有则先回到 Phase 3.3 —— spec 写入应属于本任务的同一批提交，而不是被遗忘的后续。

由 AI 驱动本任务代码变更的批量提交，让 `/finish-work` 之后能干净运行。目标：先产生工作提交，簿记提交（归档 + 日志）落在后面 —— 绝不交错。

**分步**：

1. **检查脏状态**：
   ```bash
   git status --porcelain
   ```
   快照每个脏路径。工作区干净则跳到 3.5。

2. **学习提交风格**（让拟写的提交信息融入历史）：
   ```bash
   git log --oneline -5
   ```
   记下前缀约定（`feat:` / `fix:` / `chore:` / `docs:` ……）、语言（中文/English）、长度风格。

3. **把脏文件分成两组**：
   - **本会话 AI 编辑过的** —— 你在本会话经 Edit/Write/Bash 工具调用写过/编辑过的文件。你知道改了什么、为什么。
   - **无法识别的** —— 本会话你**没有**碰过的脏文件（可能是用户手动改的、上次会话的遗留 WIP、或无关工作）。**不要**默默把它们包进来。

4. **起草提交计划**。把 AI 编辑的文件按逻辑分组（每个内聚变更单元 1 个提交，不是每文件 1 个）。每项：`<提交信息>` + 文件列表。无法识别的文件单独列在底部。

5. **一次性呈现计划，请求一次性确认**。格式：
   ```
   拟提交（按顺序）：
     1. <提交信息>
        - <文件>
        - <文件>
     2. <提交信息>
        - <文件>

   无法识别的脏文件（不在任何提交内 —— 请确认纳入/排除）：
     - <文件>
     - <文件>

   回复 'ok' / '行' 执行。有修改意见请直接说，或回复 '我自己来' / 'manual' 放弃。
   ```

6. **确认后**：按顺序对每批运行 `git add <文件>` + `git commit -m "<信息>"`。不要 amend。不要 push。

7. **被拒后**（用户回复"不行" / "我自己来" / "manual" / 对计划有任何异议）：停止。不要出第二个计划。用户会手动提交；等用户确认后你跳到 3.5。

**规则**：
- 全程不用 `git commit --amend` —— 三段三提交流程（工作提交 → 归档提交 → 日志提交）。
- 本步绝不 push 到远端。
- 用户只想改措辞但接受文件分组：改完信息再确认一次 —— 若分组本身被拒，退回手动模式。
- 批量计划只提示一次；不要每个提交单独问。

#### 3.5 收尾提醒

以上完成后，提醒用户可以运行 `/finish-work` 收尾（归档任务、记录会话）。

---

## 自定义 Trellis（面向 fork）

本节面向想修改 Trellis 工作流本身的开发者。所有定制都通过编辑本文件完成；脚本只是解析器。

### 修改步骤含义

编辑上方 Phase 1 / 2 / 3 小节中对应步骤的走查正文。关键不变量：
- 无活动任务时必须先分诊并征得建任务同意，才能创建 Trellis 任务。
- 规划必须区分"轻量 PRD-only 任务"与"start 前需要 `prd.md`、`design.md`、`implement.md` 的复杂任务"。
- 每条强制执行路径必须保证 Phase 3.4 提交提醒在 `/trellis:finish-work` 之前可达。

所有标签块位于上方 `## Phase Index` 小节，紧跟各阶段摘要之后：

| 范围 | 对应标签 |
|---|---|
| 无活动任务（Phase 1 之前） | `[workflow-state:no_task]`（Phase Index ASCII 图之后） |
| 活动任务记录不可读 | `[workflow-state:task_error]`（先修复现有任务再继续） |
| 整个 Phase 1（任务已建 → 待实现） | `[workflow-state:planning]`（Phase 1 摘要之后） |
| Codex 内联 Phase 1 | `[workflow-state:planning-inline]` |
| Phase 2 + Phase 3.2–3.4（实现 + 检查 + 收尾） | `[workflow-state:in_progress]`（Phase 2 摘要之后） |
| Codex 内联 Phase 2 + Phase 3.2–3.4 | `[workflow-state:in_progress-inline]` |
| Phase 3.5 之后（已归档） | `[workflow-state:completed]`（Phase 3 摘要之后；**当前为死状态**） |

### 修改逐轮提示文本

直接编辑对应 `[workflow-state:STATUS]` 块的正文。编辑后，模板维护者运行 `trellis update`（或自定义自己项目的用户重启 AI 会话）—— 无需改脚本。

### 新增自定义状态

新增一个块：

```
[workflow-state:my-status]
你的逐轮提示文本
[/workflow-state:my-status]
```

约束：
- STATUS 字符集：`[A-Za-z0-9_-]+`（允许下划线和连字符，如 `in-review`、`blocked-by-team`）
- 必须有生命周期钩子把 `task.json.status` 写成你的自定义值，否则标签永远不会被读到
- 生命周期钩子位于 `task.json.hooks.after_*`，绑定 `after_create / after_start / after_finish / after_archive` 之一

### 新增生命周期钩子

给 `task.json` 加 `hooks` 字段：

```json
{
  "hooks": {
    "after_finish": [
      "你的脚本或命令"
    ]
  }
}
```

支持的事件：`after_create / after_start / after_finish / after_archive`。注意 `after_finish` ≠ 状态变更（它只清除活动任务指针）；"任务完成"通知请用 `after_archive`。

### 完整契约

工作流状态机的运行时契约、所有状态写入器的位置、伪状态（`no_task` / `stale_<source_type>`）、钩子可达性矩阵等深层细节，见：

- `.trellis/spec/cli/backend/workflow-state-contract.md` —— 运行时契约 + 写入器表 + 测试不变量
- `.trellis/scripts/inject-workflow-state.py` —— 实际解析器（只读 workflow.md，不内嵌文本）
