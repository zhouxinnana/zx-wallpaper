# 修复已跳过图片全部删除卡死与占位图残留

## Goal

1) delete_all_skipped/delete_skipped 为同步 tauri command，在主线程执行 trash 删除 + 循环内每张图 rescan_config 全库扫描（O(N*M)）导致 UI 卡死；2) 删除中途失败时 ? 短路使整个 mutate 不提交状态，但文件已进回收站，磁盘/配置分裂；3) skipped_paths 从不 prune 缺失文件，死路径在 SkippedCard 中静默降级为硬编码 Unsplash 占位图。修复：命令改 async + spawn_blocking；全删改为尽力而为（失败项保留记录并报告）；rescan 移出循环；增加 prune_missing_skipped_paths；SkippedCard 对文件缺失显示明确状态而非远程占位图。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
