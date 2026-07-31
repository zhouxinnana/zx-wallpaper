# Domain Docs

How the engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repository root. It points at one `CONTEXT.md` per context.
- The `CONTEXT.md` file for each context relevant to the work.
- **`docs/adr/`** for system-wide decisions, plus `packages/<context>/docs/adr/` for context-scoped decisions.

If any of these files do not exist, proceed silently. Do not suggest creating them upfront. The `/domain-modeling` skill, reached through `/grill-with-docs` and `/improve-codebase-architecture`, creates them when terms or decisions are resolved.

## File structure

This repository uses a multi-context layout:

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          <- system-wide decisions
└── packages/
    ├── <context-a>/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  <- context-scoped decisions
    └── <context-b>/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in the relevant `CONTEXT.md`. If the concept is not defined, reconsider whether it is new language or a genuine gap to record through `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
