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

## 发布

推送与 `package.json` 版本一致的 `vX.Y.Z` 标签后，GitHub Actions 会在 Windows 环境打包，并将 NSIS 安装器附加到 GitHub Release。

```powershell
$version = node -p "require('./package.json').version"
git tag "v$version"
git push origin "v$version"
```

## 技术栈

Tauri、Rust、React、TypeScript、Vite。
