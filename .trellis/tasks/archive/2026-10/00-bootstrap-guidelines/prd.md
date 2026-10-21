# 引导任务：填写项目开发规范

**由你（AI）执行本任务。开发者不阅读本文件。**

开发者刚刚首次在本项目运行了 `trellis init`，`.trellis/` 目录与空的规范脚手架已生成，本引导任务位于 `.trellis/tasks/` 下。当开发者要处理它时，应从提供 Trellis 会话身份的会话中启动本任务。

**你的职责**：帮助开发者把团队真实的编码约定填入 `.trellis/spec/`。后续每个 AI 会话——本项目的 `trellis-implement` 和 `trellis-check` 子代理——都会自动加载各任务 jsonl 清单中列出的规范文件。规范为空 = 子代理写出通用代码；规范真实 = 子代理贴合团队实际模式。

不要一次倾倒所有指令。以简短问候开场，确认仓库是否已有约定文档（CLAUDE.md、.cursorrules 等），然后以对话方式推进。

---

## 状态（每完成一项更新勾选框）

- [x] 填写前端规范
- [x] 补充代码示例

---

## 待填写的规范文件


### 前端规范

| 文件 | 需记录的内容 |
|------|------------------|
| `.trellis/spec/frontend/directory-structure.md` | 组件/页面/hook 的组织方式 |
| `.trellis/spec/frontend/component-guidelines.md` | 组件模式、props 约定 |
| `.trellis/spec/frontend/hook-guidelines.md` | 自定义 hook 命名与模式 |
| `.trellis/spec/frontend/state-management.md` | 状态库、模式、状态归属 |
| `.trellis/spec/frontend/type-safety.md` | TypeScript 约定、类型组织 |
| `.trellis/spec/frontend/quality-guidelines.md` | Lint、测试、可访问性 |


### 思维指南（已预填）

`.trellis/spec/guides/` 内含预填最佳实践的通用思维指南。仅在明显不适配本项目时才做定制。

---

## 如何填写规范

### 第一步：优先从既有约定文档导入

在仓库中搜索既有约定文档。若存在，阅读并把相关规则提取到对应的 `.trellis/spec/` 文件——通常比从零编写快得多。

| 文件 / 目录 | 对应工具 |
|------|------------------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / 兼容 agent 的工具 |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor（规则目录） |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | 通用项目约定 |
| `.editorconfig` | 编辑器格式化规则 |

### 第二步：分析代码库，补齐文档未覆盖的内容

扫描真实代码以发现模式。写每个规范文件前：
- 为每个模式找到 2-3 个真实代码示例。
- 引用真实文件路径（不要写假设路径）。
- 记录团队明确规避的反模式。

### 第三步：记录现状，而非理想态

**关键**：写代码**实际**在做什么，而不是应该做什么。
子代理会贴合规范，因此写进规范但代码库中不存在的理想化模式，会导致子代理写出格格不入的代码。

如果团队有已知技术债，记录现状——改进是另一次对话的事，不属于引导任务范畴。

---

## 运行时速览（当开发者问"为什么需要规范"时分享）

- 每个编码任务会派生两个子代理：`trellis-implement`（写代码）和 `trellis-check`（质量校验）。
- 每个任务有 `implement.jsonl` / `check.jsonl` 清单，列出要加载的规范文件。
- 平台 hook 会自动把这些规范文件 + 任务 `prd.md` 注入每个子代理的提示词，子代理按团队约定编码/校验，无需任何人手动粘贴。
- 事实源：`.trellis/spec/`。这就是为什么现在把它填好能长期受益。

---

## 完成方式

当开发者确认上方勾选项已用真实示例（而非占位内容）完成后，引导其运行：

```bash
python ./.trellis/scripts/task.py finish
python ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

归档后，之后加入本项目的每个新开发者会得到一个 `00-join-<slug>` 入职任务，而不是本引导任务。

---

## 建议开场白

"欢迎来到 Trellis！init 已经让我准备好帮你填写项目规范——这是一次性设置，之后每个 AI 会话都会遵循团队约定而不是写出通用代码。开始前问一句：仓库里有没有现成的约定文档（CLAUDE.md、.cursorrules、CONTRIBUTING.md 等）可以让我提取，还是我直接扫代码库？"
