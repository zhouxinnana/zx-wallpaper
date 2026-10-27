# 执行计划

## 阶段 1 —— 密钥与配置（无代码风险，先做）

1. `npx tauri signer generate -w ~/.tauri/zx-wallpaper.key`（本机执行一次，公钥抄进配置）
2. `.gitignore` 加 `*.key` / `*.pem` / `*.key.pub`
3. `tauri.conf.json`：`bundle.createUpdaterArtifacts=true`、`plugins.updater`
4. 验证：`node -e "JSON.parse(...)"` 确认 JSON 合法；`npx tauri info` 不报配置错

## 阶段 2 —— 插件接入（Rust）

5. `Cargo.toml` 加 `tauri-plugin-updater` / `tauri-plugin-process`，挂 `desktop` feature
6. `lib.rs` 注册两个插件（放在 `opener` 之后）
7. `capabilities/default.json` 加权限
8. 验证：`cargo check`（约 30s；新增依赖首次可能 3-5 分钟，日志落盘后台跑）

## 阶段 3 —— 前端接线

9. `package.json` 安装两个 JS 包
10. `types.ts`：`AppUpdateInfo` / `AppUpdateProgress` / `DesktopRuntime` 两方法
11. `tauri-runtime.ts`：`UpdaterBindings`、`checkUpdate`、`installUpdate`
12. `App.tsx`：
    - App 顶层 `updateInfo` / `updateMessage` / `updateProgress` / `checkingUpdate` / `installingUpdate`
    - `AUTO_CHECK_DELAY_MS` 静默检查 `useEffect`
    - `SettingsView` 更新面板重写（检查 / 发现新版本 / 进度 / 安装确认）
    - `createDefaultRuntime` 补兜底桩
13. `App.test.tsx` fake 补两方法
14. 验证：`npm run typecheck`、`npm run test -- src/App.test.tsx`

## 阶段 4 —— CI

15. `release-tauri.yml` 用 `tauri-action` 替换 build + publish，注入密钥 env
16. 验证：`npx yaml-lint` 或本地解析 YAML 确认语法；逻辑走查（tag 校验仍在 build 之前）

## 阶段 5 —— 门禁与沉淀

17. `npm run typecheck` + `npm run test` + `cargo test`（全量只跑一次）
18. 更新 `.trellis/spec/frontend/quality-guidelines.md`：记录 updater 接入约定与密钥纪律
19. 归档任务

## 需要用户手动完成（无法自动化）

- 把 `~/.tauri/zx-wallpaper.key` 内容填进 GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY`
- 密码填 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（若生成时留空则填空字符串或用空）
- 离线备份私钥

## 风险与回滚

- 阶段 2 失败（依赖拉不下来）：单独回退 `Cargo.toml` + `lib.rs` 两处即可，不影响前端。
- 阶段 3 失败：前端改动全部在接口层，删方法即可恢复；`App.tsx` 更新面板回退到 `disabled` 占位。
- CI 改动不影响历史 tag，新 tag 才生效。
