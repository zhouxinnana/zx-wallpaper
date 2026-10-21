# 组件规范

> 本项目的组件模式与 props 约定。

---

## 概览

React 19 函数组件 + TypeScript，无组件库、无 CSS 框架。应用是**单文件 UI**：`src/App.tsx` 包含外壳、全部五个视图（工作台 / 在线发现 / 我的喜欢 / 实验室 / 设置）、对话框和模块级辅助函数。

小的展示片段用**文件内函数组件**，不是独立文件（如 `App.tsx:728` 的 `SettingsRow`）。

---

## 实际模式（有代码出处）

- **视图切换**：`const [view, setView] = useState<View>("workbench")`，由模块级常量 `const views: Array<{ key, label, subtitle, icon }>`（`App.tsx:100`）驱动。新增视图 = 扩展这个常量 + `View` 联合类型。
- **设置行**：`<SettingsRow label description>{children}</SettingsRow>` —— 设置视图的布局原语。直接复用，不要新造布局包装。
- **枚举驱动下拉**：选项来自模块级常量（`displayModes`、`upx8Categories`，`App.tsx:51-80`），渲染为 `<option key value>label</option>`。label 为中文。
- **破坏性操作**（删除 / 跳过 / 清空）：必须走 `openConfirm(ConfirmOptions)` → 文件内 ConfirmDialog → `confirmAction`。删除走系统回收站（永不硬删）。「跳过图片」≠ 删除（见 `CONTEXT.md`）。
- **所有用户操作**统一经 `run(key, action)`（`App.tsx:168`）：防重入（`busyRef`）、busy/status/error 生命周期、用返回的 `AppState` 整体替换 state。禁止在事件处理器里直接调 `api.xxx`。
- **可访问性**：控件加 `aria-label` 或用中文 `<label>` 包裹（如 `aria-label="显示方式"`）；导航有 `aria-label="主导航"`。测试按 role + 可访问名定位，所以可访问名是承重结构。
- **图标**：`lucide-react` 组件作为 `icon` 放进 `views` 常量。

---

## Props 约定

- `App` 接受可选注入的 runtime：`export default function App({ runtime }: { runtime?: DesktopRuntime })` —— `const [api] = useState(() => runtime ?? createDefaultRuntime())`。这是**唯一**的 DI 接缝，测试通过它注入 fake。不要引入模块 mock。
- 文件内辅助组件用显式类型化 props（`SettingsRow({ label, description, children }: { label: string; description: string; children: ReactNode })`）。

---

## 禁止项

- 未经 ADR 级决策，不新建组件文件、不从 `App.tsx` 抽取组件。
- 组件内不允许直接 import `@tauri-apps/api`。
- 不硬删；破坏性操作不得绕过 ConfirmDialog。
- UI 文案不用英文——用户可见字符串遵循 `CONTEXT.md` 词汇。
