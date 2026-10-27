# ZX Wallpaper

Windows 11 本地优先的壁纸管理与自动切换软件。

## About

本地优先的 Windows 11 壁纸管理与自动切换软件，支持本地壁纸库、在线发现和系统托盘控制。

建议的 GitHub 主题词：`windows`、`windows-11`、`wallpaper`、`wallpaper-changer`、`tauri`、`desktop-app`。

## 功能

- 添加、扫描和管理本地壁纸目录，显示目录可用状态。
- 所有显示器同步使用同一张壁纸，并支持填充、适应、拉伸、平铺、居中和跨区显示模式。
- 在全部可用图片中随机且不重复地循环切换；支持暂停、下一张、跳过与恢复跳过图片。
- 支持自动切换间隔、恢复补切和可选的全局下一张快捷键。
- 通过系统托盘快速显示窗口、切换下一张或退出应用。
- 在线发现内置来源与自定义 HTTPS 来源，可配置抓取间隔、最低分辨率、存储目录及容量上限。
- 在线图片提供缩略图、来源页、打开所在文件夹、删除与手动设为壁纸；手动设为壁纸后会暂停自动切换。

## 安装

从 [Releases](https://github.com/zhouxinnana/zx-wallpaper/releases) 下载 `ZX-Wallpaper-Setup-*.exe` 并运行安装程序。

## 开发

环境要求：Windows 11、Node.js 22。

```powershell
npm ci
npm run tauri:dev
```

`npm run tauri:dev` 会启动 Vite 与 Tauri 桌面端。仅打开浏览器地址无法验证文件选择、系统托盘和桌面壁纸切换。

## 打包

```powershell
npm run tauri:build
```

安装包产物位于 `src-tauri/target/release/bundle/`，该目录不会提交到 Git。

`bundle.createUpdaterArtifacts` 已开启，打包会额外产出 `.nsis.zip` 和 `.sig`。**签名是强制的**：`plugins.updater.pubkey` 已配置时，缺少私钥会让 `tauri build` 直接失败（`A public key has been found, but no private key`），所以本地打包前必须指向私钥：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$HOME\.tauri\zx-wallpaper.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
```

私钥在 `~/.tauri/zx-wallpaper.key`（每台开发机各自一份即可，客户端只认公钥）。只跑前端 `npm run build` / `npm run tauri:dev` 不受影响。

## 发布

版本号真源是 `package.json`：`tauri.conf.json` 通过 `"version": "../package.json"` 引用它，`Cargo.toml` / `Cargo.lock` 由脚本同步。

```powershell
npm run version:bump 0.3.0   # 同步所有位置的版本号，并打印每处改动
npm run version:check        # 校验一致性（CI 也会跑这一步）
git commit -am "chore: release tauri v0.3.0"
git push origin tauri_master

$version = node -p "require('./package.json').version"
git tag "tauri-v$version"
git push origin "tauri-v$version"
```

推送 `tauri-vX.Y.Z` 标签后，GitHub Actions 会在 Windows 环境打包（`tauri-apps/tauri-action`），把 NSIS 安装器、`.nsis.zip`、`.sig` 与 `latest.json` 一起附加到 GitHub Release。标签名必须与 `package.json` 版本严格一致，且提交必须可达 `tauri_master`（workflow 会校验这两条）。

### 自动更新的密钥约定

客户端固化的更新地址是 `releases/latest/download/latest.json`，因此发布必须是**已发布且非 prerelease** 的 release，否则客户端会拿到 404。

密钥对只生成一次，之后所有版本沿用：

```powershell
npm run tauri signer generate -- -w "$HOME/.tauri/zx-wallpaper.key"
```

- 公钥：写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥：只放在 GitHub Secrets 的 `TAURI_SIGNING_PRIVATE_KEY`，另需离线备份
- **私钥或密码丢失 = 再也无法给已安装用户推送更新**（旧客户端验签必然失败），只能让用户手动重装

首个带 updater 的版本发布时，老用户（≤ 0.2.2）必须手动安装一次，之后才能进入自动更新通道。

## 技术栈

Tauri、Rust、React、TypeScript、Vite。
