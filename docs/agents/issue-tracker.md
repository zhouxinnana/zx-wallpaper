# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues in `zhouxinnana/zx-wallpaper`. Use the `gh` CLI for all operations and pass `--repo zhouxinnana/zx-wallpaper`, because this directory does not yet have a Git remote.

## Conventions

- **Create an issue**: `gh issue create --repo zhouxinnana/zx-wallpaper --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo zhouxinnana/zx-wallpaper --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo zhouxinnana/zx-wallpaper --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo zhouxinnana/zx-wallpaper --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --repo zhouxinnana/zx-wallpaper --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --repo zhouxinnana/zx-wallpaper --comment "..."`.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` only if external PRs should enter the triage queue.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `zhouxinnana/zx-wallpaper`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo zhouxinnana/zx-wallpaper --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with child issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels use `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`).
- **Blocking**: use GitHub native issue dependencies. When unavailable, add a `Blocked by: #<n>, #<n>` line at the top of the child body.
- **Claim**: `gh issue edit <n> --repo zhouxinnana/zx-wallpaper --add-assignee @me`.
- **Resolve**: comment on the ticket, close it, then append a context pointer to the map's Decisions-so-far section.
