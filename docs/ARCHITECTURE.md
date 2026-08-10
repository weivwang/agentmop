# Architecture

AgentMop separates observation, classification, presentation, and mutation so a rendering bug cannot silently become a cleanup decision.

```text
agent adapters ─┐
process probe ──┼─> evidence model ─> fail-closed classifier ─> terminal / HTML / JSON
git probe ──────┘                                  │
                                                   └─> fresh plan ─> quarantine ─> restore / purge
```

## Observation

Adapters know where a coding agent stores local resources. They inventory bounded metadata, sizes, modification times, Git state, process working directories, and exact path references. Filesystem traversal uses `lstat` and rejects symlinked components below each trusted scan boundary. Session readers stop after a small prefix and return constrained identifier tokens plus absolute working directories; prompt and tool-output fields cannot enter the report model. Git observation disables repository-configured `core.fsmonitor` commands.

## Classification

Classification is deterministic and evidence-based:

- `LIVE`: an active agent process references the resource.
- `DIRTY`: Git reports tracked or untracked changes.
- `SAFE`: the adapter has positive ownership and staleness evidence, no live reference, and an implemented cleanup strategy.
- `REVIEW`: the resource may be stale but deleting it can remove user history or other valuable state.
- `UNKNOWN`: ownership or lifecycle cannot be proved.

Missing evidence never upgrades an artifact to `SAFE`. Session and history stores are always `REVIEW`, regardless of age.

Temp-directory names are discovery hints, not ownership proof, so a name alone never authorizes `SAFE`; other protective evidence can still yield `LIVE`, `DIRTY`, or `UNKNOWN`. Standalone and bare Git repositories anywhere inside a temp candidate are never `SAFE`: dirty worktrees are `DIRTY`, active references are `LIVE`, and clean unreferenced or bare repositories are `REVIEW` because their commits and refs may not exist elsewhere.

## Mutation boundary

The cleanup layer accepts only artifacts that are both `SAFE` and cleanup-eligible in a scan less than five minutes old. Immediately before each mutation it repeats filesystem-snapshot checks and observes references across every supported agent; any incomplete cwd evidence at that boundary stops cleanup. It independently rejects broad roots, unsupported types, and symlinked path components. The original→quarantine mapping is atomically recorded before mutation. Cache/temp artifacts are renamed; clean managed worktrees use `git worktree move`, preserving the complete directory including ignored files.

Restore refuses to overwrite a recreated path, validates filesystem identity on recovery shortcuts, and verifies a quarantined worktree's repository and HEAD before moving it back. Purge is the only removal step and requires an exact batch id plus `--yes`; it records each planned deletion before mutation and retains `purge-partial` state if deletion is not confirmed. Because recursive removal can fail after deleting some children, restore returns recovered remnants but permanently retains `restore-partial` for every item whose purge began with an uncertain outcome.

## Privacy

All analysis is local and deterministic. AgentMop has no telemetry, network client, account, API key, or model dependency. HTML reports are self-contained; users should still review them before sharing because local paths and repository names can be sensitive.
