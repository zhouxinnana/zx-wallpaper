## Agent skills

### 执行纪律（强制）

- **禁止用 `sleep N` 等待**。能阻塞到完成的命令（`cargo test`、`npm run build`）就前台跑完；必须后台时轮询目标条件（进程退出/日志完成标记），间隔 ≤3s 并设上限。单条命令 sleep 一律 ≤5s。
- **全量 `cargo test` 只在收尾跑一次**。开发中用 `cargo check`（约 26s）或 `cargo test --lib <module>` 只测受影响模块。
- **AI 打标模型测试已 `#[ignore]`**（默认 56 passed / 2 ignored）。要验证推理链路时 `CLIP_TEST_MODEL=<path> cargo test -- --ignored`，一次确认即可，别反复跑。
- 详见 `.trellis/spec/frontend/quality-guidelines.md` 的「命令执行纪律」与「构建命令频率」。

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `zhouxinnana/zx-wallpaper`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context domain documentation layout. See `docs/agents/domain.md`.
