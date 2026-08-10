# Security policy

AgentMop inspects and can eventually remove local data, so safety bugs are security bugs.

## Supported versions

Security fixes are released for the latest tagged version on `main`.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** for path traversal, unsafe classification, symlink handling, command injection, cleanup boundary bypasses, or privacy leaks. Do not open a public issue until a fix is available.

Include a minimal fixture that contains no real prompts, credentials, source code, usernames, or proprietary paths. You should receive an acknowledgement within 72 hours.

## Safety boundaries

- Scanning is read-only.
- Symlinks are measured as links; components below trusted scan roots are never traversed.
- Session bodies are not analyzed; adapters read only bounded metadata records with constrained token values.
- `LIVE` and `DIRTY` artifacts are never eligible for cleanup.
- Session history is classified `REVIEW`, never `SAFE`.
- Incomplete process-cwd evidence disables `SAFE` for the affected agent.
- Cleanup requires a fresh scan, then repeats all-agent process, snapshot, and symlink checks immediately before mutation; incomplete cwd evidence stops the operation.
- The recovery mapping is written before mutation; whole worktrees and ignored files remain quarantined until a separate, explicit purge. Purge intent is recorded per item before deletion. If recursive deletion fails after removing children, restore recovers remnants but keeps an explicit partial-integrity state and non-zero exit code.
- HTML reports are local, self-contained, atomically written with private permissions, and may still contain sensitive paths.
- AgentMop is a best-effort tool, not a guarantee that an artifact has no value.

Please review the cleanup plan before confirming it, and keep backups of important work.
