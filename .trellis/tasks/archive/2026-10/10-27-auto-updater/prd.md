# 实现应用自动更新（Tauri updater）

## Goal

把当前 `disabled` 的「检查更新」按钮接成真实能力：应用能通过 GitHub Releases 检测新版本、下载签名安装包、原地升级并重启。

## 现状（2026-10-27 盘点）

| 位置 | 现状 |
|---|---|
| `src/App.tsx:995` | 「更新」面板只有一个 `disabled` 按钮，title 写「需要签名私钥和更新地址」 |
| `src-tauri/tauri.conf.json` | 无 `plugins.updater`，无 `bundle.createUpdaterArtifacts` |
| `Cargo.toml` / `package.json` | 无 `plugin-updater` / `plugin-process` |
| `.github/workflows/release-tauri.yml` | 只上传 `*.exe`，不产 `latest.json` / `.sig` |
| `.gitignore` | 无密钥忽略规则 |

## Requirements

1. **签名密钥**：Ed25519 密钥对，公钥进 `tauri.conf.json`，私钥只存在于 GitHub Secrets 与用户本地备份。
2. **Tauri 配置**：`bundle.createUpdaterArtifacts=true`；`plugins.updater` 配置 pubkey、GitHub `latest.json` endpoint、NSIS `installMode=passive`。
3. **插件注册**：Rust 侧注册 `tauri-plugin-updater` 与 `tauri-plugin-process`；capability 放开 `updater:default`、`process:allow-restart`。
4. **CI**：tag 发布工作流改用 `tauri-apps/tauri-action`，产出并上传 `.exe` + `.nsis.zip` + `.sig` + `latest.json`；保留现有 tag/版本一致性校验。
5. **前端检查更新**：设置页「更新」面板显示当前版本、检查状态、发现的新版本号，按钮可点击并给出中文反馈。
6. **安装与重启**：下载进度可见，安装完成后自动重启；安装前必须经用户确认（沿用 `ConfirmDialog`）。
7. **自动检查**：应用启动后延迟静默检查一次，失败静默不打扰；有更新只在设置页提示，**不静默安装**。

## 非目标

- 不做增量差分更新（走官方完整安装包）。
- 不做降级/回滚通道。
- 不做私有仓库鉴权分发。
- 不引入遥测或更新统计（违反本地优先约束）。

## Acceptance Criteria

- [ ] `tauri signer generate` 生成的公钥已写入 `tauri.conf.json`，私钥在 `~/.tauri/` 且被 git 忽略
- [ ] `cargo check` 通过，两个插件在 `lib.rs` 注册
- [ ] `capabilities/default.json` 含 `updater:default` 与 `process:allow-restart`
- [ ] 设置页「检查更新」按钮可点击；无更新时提示「已是最新版本」，有更新时显示新版本号
- [ ] 网络失败与「已是最新」提示可区分，错误文案为中文
- [ ] 安装走 `ConfirmDialog` 二次确认，安装中显示下载进度，完成后重启
- [ ] `release-tauri.yml` 使用 `tauri-action` 且注入签名密钥 env
- [ ] `npm run typecheck` / `npm run test` / `cargo test` 全绿
- [ ] 浏览器模式（无 Tauri）下按钮降级为不可用提示，不抛异常

## Notes

- 私钥丢失 = 永久失去对已安装用户推送更新的能力，必须离线备份。
- 首个带 updater 的版本，老用户（≤0.2.2）必须手动装一次才进入自动更新通道。
