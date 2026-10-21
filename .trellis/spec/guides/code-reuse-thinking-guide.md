# 代码复用思维指南

> **目的**：创建新代码前先停下来想——它是不是已经存在了？

---

## 问题所在

**重复代码是第一个不一致性 bug 来源。**

当你复制粘贴或重写既有逻辑：
- bug 修复不会传播
- 行为随时间漂移
- 代码库越来越难理解

---

## 写新代码之前

### 第一步：先搜索

```bash
# 搜索相似的函数名
grep -r "functionName" .

# 搜索相似的逻辑
grep -r "keyword" .
```

### 第二步：问自己这些问题

| 问题 | 如果是…… |
|----------|-----------|
| 已有相似函数吗？ | 用它或扩展它 |
| 这个模式在别处用过吗？ | 遵循既有模式 |
| 这可以做成共享工具吗？ | 放到正确的位置创建 |
| 我在从别的文件复制代码吗？ | **停** —— 抽到共享处 |

---

## 常见重复模式

### 模式 1：复制粘贴函数

**坏**：把校验函数复制到另一个文件

**好**：抽到共享工具层，需要的地方 import

### 模式 2：相似组件

**坏**：新建一个与已有组件 80% 相似的组件

**好**：用 props/variants 扩展已有组件

### 模式 3：重复常量

**坏**：同一个常量在多个文件各定义一份

**好**：单一事实源，处处 import

### 模式 4：重复的载荷字段提取

**坏**：多个消费者各自本地 cast 同一批 JSON/事件字段：

```typescript
const description = (ev as { description?: string }).description;
const context = (ev as { context?: ContextEntry[] }).context;
```

哪怕只有两行，这也是重复的契约逻辑。每个消费者从此都有一份自己对"合法载荷"的定义。

**好**：把解码器、类型守卫或投影放在数据所有者旁边：

```typescript
if (isThreadEvent(ev)) {
  renderThreadEvent(ev);
}
```

**规则**：同一个无类型载荷字段在 2+ 处被读取时，先建共享的类型守卫 / 归一化器 / 投影，再写第三个读者。

---

## 何时抽象

**该抽象**：
- 同样的代码出现 3+ 次
- 逻辑复杂到可能有 bug
- 多人可能都需要

**不该抽象**：
- 只用一次
- 平凡的单行
- 抽象比重复更复杂

---

## 批量修改之后

当你对多个文件做了相似修改：

1. **复查**：所有实例都改到了吗？
2. **搜索**：跑 grep 找漏网的
3. **考虑**：该抽象吗？

### Reducer 应使用穷举结构

当状态由类 action 值（`action`、`kind`、`status`、`phase`）派生时，优先用一个 `switch` 的 reducer，而不是散落的 `if/else` 更新。

```typescript
// BAD - 按 action 分散的状态转换难以审计
if (action === "opened") { ... }
else if (action === "comment") { ... }
else if (action === "status") { ... }

// GOOD - 一个 reducer 持有全部转换表
switch (event.action) {
  case "opened":
    ...
    return;
  case "comment":
    ...
    return;
}
```

事件日志是事实源时这一点尤其重要。reducer 就是被记录的重放模型；展示代码和命令不应重复实现重放模型的碎片。

---

## 提交前清单

- [ ] 搜索过既有的相似代码
- [ ] 没有本该共享的复制粘贴逻辑
- [ ] 没有在共享解码器之外重复提取无类型载荷字段
- [ ] 常量只定义在一处
- [ ] 相似模式遵循相同结构
- [ ] Reducer/action 转换集中在唯一的 reducer 或命令分发器里

---

## 陷阱：Python if/elif/else 穷举检查

**问题**：Python 的 if/elif/else 链没有编译期穷举检查。往 `Literal` 类型（如 `Platform`）加新值时，既有的 if/elif/else 链会静默落入 `else` 并给出错误默认值。

**症状**：新平台部分可用——某些方法返回 Claude 的默认值而不是平台专属值。没有任何报错。

**示例**（`cli_adapter.py`）：
```python
# BAD: "gemini" 落入 else，返回 "claude"
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    else:
        return "claude"  # gemini 静默拿到 "claude"！

# GOOD: 每个平台显式分支
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    elif self.platform == "gemini":
        return "gemini"
    else:
        return "claude"
```

**预防**：往 Python `Literal` 类型加新值时，搜索**所有**基于该类型分支的 if/elif/else 链并补显式分支。不要指望 `else` 对新值恰好正确。

---

## 陷阱：非对称机制产生相同输出

**问题**：两个不同机制必须产出相同的文件集合时（如 init 的递归目录复制 vs update 手动维护的 `files.set()`），结构性变更（重命名、移动、新增子目录）只会经自动机制传播，手动那份静默漂移。

**症状**：init 完美运行，但 update 在错误路径创建文件或干脆漏文件。

**预防**：
- **最优**：消除非对称——让手动路径调用自动路径（如 `collectTemplateFiles()` 调 `getAllScripts()`，而不是自己维护列表）
- **非对称不可避免时**：加一个对比两个机制输出的回归测试
- 迁移目录结构时，搜索**所有**引用旧结构的代码路径

**真实案例**：`trellis update` 曾手动维护一份 11 个脚本的 `files.set()` 列表，而 `getAllScripts()` 已经跟踪了它们。修复：把手动列表换成 `for..of getAllScripts()` 循环。见 v0.4.0-beta.3 的 `update.ts` 重构。

---

## 模板文件注册（Trellis 特有）

往 `src/templates/trellis/scripts/` 加新文件时：

**唯一注册点**：`src/templates/trellis/index.ts`

1. 加 `export const xxxScript = readTemplate("scripts/path/file.py");`
2. 加进 `getAllScripts()` Map

就这两步。`commands/update.ts` 直接使用 `getAllScripts()` —— 无需手动同步。

**为什么重要**：不在 `getAllScripts()` 注册的话，`trellis update` 不会把文件同步到用户项目。bug 修复和新功能无法传播。

**历史**：v0.4.0-beta.3 之前，`update.ts` 有自己手工维护的文件列表，经常与 `getAllScripts()` 失同步。这曾导致 11 个 Python 文件在 `trellis update` 时被静默跳过。修复方案是消除重复列表，以 `getAllScripts()` 为单一事实源。

### 新脚本快速清单

```bash
# 加完新 .py 文件后，确认它已在 getAllScripts() 里：
grep -l "newFileName" src/templates/trellis/index.ts  # 应当命中
```

### 模板同步约定

`.trellis/scripts/`（自用版本）与 `packages/cli/src/templates/trellis/scripts/`（模板）必须保持一致。编辑 `.trellis/scripts/` 后总是同步：

```bash
rsync -av --delete --exclude='__pycache__' .trellis/scripts/ packages/cli/src/templates/trellis/scripts/
```

**陷阱**：rsync 源/目标路径写错会造出嵌套垃圾目录（如 `.trellis/scripts/packages/cli/...`）。运行前务必核对路径。
