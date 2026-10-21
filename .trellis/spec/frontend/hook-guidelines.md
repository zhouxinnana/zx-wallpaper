# Hook 规范

> 本项目中 hook 的使用方式。

---

## 概览

只用原生 React hook——**当前不存在自定义 hook 文件，也不应无需求创建**。所有 hook 用法都在 `src/App.tsx`。本该抽成自定义 hook 的状态逻辑，目前以 `useCallback` 闭包形式放在 `App` 顶部。

---

## 实际模式（出自 `App.tsx`）

- **惰性 DI 初始化**：`const [api] = useState(() => runtime ?? createDefaultRuntime())` —— 用初始化函数形式，保证 runtime 只创建一次。
- **ref 做防重入守卫**：`run()` 内用 `busyRef.current` 阻止并发操作；配套 `const [busy, setBusy] = useState<string | null>(null)` 供渲染。规则：ref 管守卫/定时器，state 管要渲染的东西。
- **定时清除的状态消息**：`statusTimerRef` 持有 `window.setTimeout`，到时清掉成功 status（`SUCCESS_STATUS_DURATION_MS`）；新操作开始前先清掉上一个定时器。
- **事件订阅带清理**（`App.tsx:119-156`）：`useEffect` 里通过 `api.onStateChanged` 订阅，返回 unlisten 函数作为清理；另有一个 effect 返回清理函数清掉未到期定时器。
- **处理器全部 memo 化**：传给 JSX 的每个操作都是 `useCallback`（`updateConfig`、`openViewer`、`openConfirm`、……）。`run` 本身是 `useCallback(async (key, action) => {...}, [])`。
- **派生数据**：渲染期需要计算的地方用 `useMemo` 内联。

---

## 禁止项

- 不建 `src/hooks/` 目录或自定义 hook 文件（今天没有任何东西支撑它；除非出现真实的第二个消费者再议）。
- effect / 组件内直接调 `invoke()` —— 必须走 `DesktopRuntime` 接口。
- 不写 async 组件、不写无清理的 effect。
