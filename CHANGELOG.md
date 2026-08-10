# Changelog

All notable changes to AgentMop are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No user-facing changes yet.

## [0.1.0] - 2026-08-10

### Added

- Dependency-free Node.js CLI with a read-only default scan and Node.js 20+ support.
- Explicit local-storage adapters for Codex, Claude Code, Cursor, and OpenCode.
- Inventory of known session/history stores, caches, logs, temporary data, and managed linked worktrees.
- Bounded `session_meta` extraction that accepts only absolute working-directory metadata plus length- and character-constrained identifier/source/parent tokens; prompt, message, tool-output, and source-content fields are excluded.
- Allocated-byte measurement using filesystem block counts when available, with logical bytes retained as metadata for sparse-file diagnostics.
- Read-only process observation for supported agents, including sanitized commands, absolute argument paths, Linux `/proc/<pid>/cwd`, and macOS `lsof` cwd evidence.
- Git worktree inspection covering registration, linked-worktree identity, dirty state, branch, HEAD, common directory, and main worktree.
- Deterministic `DIRTY`, `LIVE`, `SAFE`, `REVIEW`, and `UNKNOWN` classification with per-artifact reasons, evidence, ownership, confidence, and cleanup eligibility.
- Fail-closed policy: session/history data is always `REVIEW`; skipped or failed process-table inspection prevents all `SAFE` verdicts; incomplete cwd evidence prevents `SAFE` for the affected agent; candidate symlinks and symlinked path ancestors are never followed or cleaned.
- Agent-aware temporary-directory discovery where a basename alone never authorizes `SAFE`; absent another protective state, agent-looking and generic name-only candidates fall back to `REVIEW`.
- Standalone and bare Git repositories anywhere inside temporary candidates are never auto-cleaned: dirty worktrees become `DIRTY`, active references become `LIVE`, while clean unreferenced and bare repositories remain `REVIEW` to protect unique commits and refs.
- Risk-sorted terminal dashboard, machine-readable JSON, and a self-contained interactive HTML report with no external assets or network requests.
- Deterministic `demo` report, clearly marked as fictional sample data, for screenshots and evaluation without scanning local files.
- `clean --safe --dry-run` planning and optional exact artifact-id filters.
- Fresh-scan cleanup boundary that rechecks every supported agent process and rejects incomplete cwd evidence, stale reports, broad roots, unsupported artifact types, symlinked path components, changed filesystem snapshots, and worktrees whose Git state changed.
- Private quarantine batches for cache/temp artifacts and whole linked worktrees, with original→quarantine mappings atomically recorded before mutation and caught partial failures retained.
- Git-native `worktree move` quarantine that preserves ignored local files, validates repository/HEAD on restore, and performs removal only during explicit purge.
- `quarantine list`, identity-checked and collision-safe `restore`, and separate permanent `purge <batch-id> --yes` commands with pre-recorded deletion intent, intra-item partial-deletion accounting, best-effort remnant recovery, and non-zero partial-result exit codes.
- Cross-platform Node test matrix, package smoke test, CodeQL analysis, Dependabot configuration, and tag-driven GitHub release workflow.
- English and Simplified Chinese launch documentation, architecture notes, security policy, contributor guide, issue templates, code of conduct, and MIT license.

### Security

- Filesystem traversal uses `lstat`, checks ancestor components, and never follows symbolic links.
- Cleanup requires a newly generated safety report and rechecks the target snapshot plus live process references before mutation.
- Restore refuses to overwrite a path recreated after quarantine and validates identity before accepting an already-restored path.
- HTML report content and embedded JSON are escaped against markup and closing-script injection.
- HTML reports use private permissions, random automatic names, atomic replacement, and symlink-destination refusal; terminal output strips control characters.
- Repository-configured Git fsmonitor commands are disabled during inspection and cleanup validation.

[Unreleased]: https://github.com/weivwang/agentmop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/weivwang/agentmop/releases/tag/v0.1.0
