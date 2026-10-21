# 工作区索引

> 所有 AI Agent 在本项目中的工作记录汇总

---

## 概览

本目录记录所有开发者在本项目中与 AI Agent 协作的会话记录。

### 文件结构

```
workspace/
|-- index.md              # 本文件 —— 总索引
+-- {developer}/          # 每个开发者一个目录
    |-- index.md          # 个人索引（含会话历史）
    |-- tasks/            # 任务文件
    |   |-- *.json        # 活动任务
    |   +-- archive/      # 按月归档的任务
    +-- journal-N.md      # 日志文件（顺序编号：1、2、3……）
```

---

## 活跃开发者

| 开发者 | 最近活跃 | 会话数 | 当前文件 |
|-----------|-------------|----------|-------------|
| （暂无） | - | - | - |

---

## 上手指南

### 新开发者

运行初始化脚本：

```bash
python ./.trellis/scripts/init_developer.py <你的名字>
```

脚本会：
1. 创建你的身份文件（已 gitignore）
2. 创建你的进度目录
3. 创建你的个人索引
4. 创建初始日志文件

### 回归开发者

1. 获取你的开发者名：
   ```bash
   python ./.trellis/scripts/get_developer.py
   ```

2. 读取你的个人索引：
   ```bash
   cat .trellis/workspace/$(python ./.trellis/scripts/get_developer.py)/index.md
   ```

---

## 约定

### 日志文件规则

- 每个日志文件**最多 2000 行**
- 达到上限后创建 `journal-{N+1}.md`
- 创建新文件时同步更新个人 `index.md`

### 会话记录格式

每条会话记录包含：
- Summary（摘要）：一句话描述
- Branch（分支）：工作在哪个分支上完成
- Main Changes（主要改动）：修改了什么
- Git Commits（提交）：提交哈希与信息
- Next Steps（后续步骤）：接下来做什么

---

## 会话模板

记录会话时使用以下模板：

```markdown
## Session {N}: {标题}

**Date**: YYYY-MM-DD
**Task**: {任务名}
**Branch**: `{分支名}`

### Summary

{一句话摘要}

### Main Changes

- {改动 1}
- {改动 2}

### Git Commits

| Hash | Message |
|------|---------|
| `abc1234` | {提交信息} |

### Testing

- [OK] {测试结果}

### Status

[OK] **已完成** / # **进行中** / [P] **受阻**

### Next Steps

- {后续步骤 1}
- {后续步骤 2}
```

---

**语言**：本项目所有文档使用**简体中文**；代码标识符、路径、命令保持英文。
