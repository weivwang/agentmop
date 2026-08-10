# Why AgentMop

> Product and market notes from the 2026-08-10 GitHub Trending review. This is a dated research record, not a claim that AgentMop can guarantee a Trending rank.

AgentMop started with a simple mismatch: coding agents finish their visible task, but the local resources created around that task often have no reliable end-of-life story. A developer can see that a disk is full, but not which agent owns the bytes, whether a worktree contains unfinished work, whether a session is still resumable, or whether a process still has the path open.

The product thesis is:

> Make agent-created local resources observable, attribute them with evidence, and make the safe subset reversible before it can become permanent.

That is the meaning of the shorthand **“`ncdu + lsof + git doctor` for AI coding agents.”** It is a product analogy, not a claim that AgentMop wraps those three programs. AgentMop combines allocated-size inventory, process/path observation, and Git/worktree health into one agent-aware report.

## Research method

The initial review was performed on 2026-08-10 in the Asia/Shanghai timezone.

1. Capture the public [GitHub Trending repositories page](https://github.com/trending) for “today / any language.”
2. Record the visible ordering and daily-star counter as a point-in-time snapshot.
3. Group the leading projects by the user promise on their public README, not merely by language.
4. Search public GitHub issues for repeated, measurable problems around AI coding-agent storage, worktrees, sessions, and orphan processes.
5. Review adjacent open-source tools to identify what was already solved and what remained fragmented.
6. Prefer a problem that can be demonstrated locally in one command and whose safety properties can be tested without an account or paid API.

Trending changes throughout the day, and GitHub does not publish a promise that a captured order will remain stable. The numbers below are research evidence from that retrieval, not evergreen repository statistics.

## GitHub Trending snapshot — 2026-08-10

| Rank | Repository | Stars today in snapshot | Public promise, condensed |
| ---: | --- | ---: | --- |
| 1 | [`semantica-agi/semantica`](https://github.com/semantica-agi/semantica) | 967 | Graph-native context and accountable AI infrastructure |
| 2 | [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents) | 1,352 | Packaged specialist agents for an AI agency |
| 3 | [`NanmiCoder/MediaCrawler`](https://github.com/NanmiCoder/MediaCrawler) | 215 | Multi-platform social-media content and comment crawler |
| 4 | [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) | 659 | Production-oriented engineering skills for coding agents |
| 5 | [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip) | 167 | Open-source management app for agents at work |
| 6 | [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent) | 2,655 | Self-improving coding agent for long-running work |
| 7 | [`LadybirdBrowser/ladybird`](https://github.com/LadybirdBrowser/ladybird) | 190 | Independent web browser engine |
| 8 | [`ruvnet/RuView`](https://github.com/ruvnet/RuView) | 156 | Spatial and vital-sign sensing from commodity Wi-Fi |
| 9 | [`danielmiessler/LifeOS`](https://github.com/danielmiessler/LifeOS) | 143 | General AI harness for improving life and work states |
| 10 | [`firecrawl/firecrawl`](https://github.com/firecrawl/firecrawl) | 815 | API for searching, scraping, and interacting with the web |
| 11 | [`TauricResearch/TradingAgents`](https://github.com/TauricResearch/TradingAgents) | 598 | Multi-agent financial trading framework |
| 12 | [`google-deepmind/weathernext`](https://github.com/google-deepmind/weathernext) | 327 | Weather forecasting research and tooling |
| 13 | [`vitali87/code-graph-rag`](https://github.com/vitali87/code-graph-rag) | 682 | AI/RAG understanding for multi-language monorepos |
| 14 | [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) | 388 | Coding-tool project with a highly visual, compact launch surface |
| 15 | [`Comfy-Org/ComfyUI`](https://github.com/Comfy-Org/ComfyUI) | 921 | Node-based generative-media GUI and backend |
| 16 | [`opa334/Dopamine`](https://github.com/opa334/Dopamine) | 95 | iOS jailbreak tooling |

### What the snapshot suggested

The useful signal was not “copy whatever is already trending.” It was the shape of the successful promise:

- **AI and agent workflows were the dominant context.** More than half of the visible list put AI, agents, context, or generative workflows at the center of the README promise.
- **The promise fit in one sentence.** The strongest landing surfaces made the user, job, and result legible before the first scroll.
- **Visible output mattered.** Tools with a dashboard, graph, browser, node canvas, or other inspectable artifact could communicate value without a long conceptual setup.
- **A narrow entry point could front a deeper system.** “Install this skill,” “run this agent,” or “open this app” was easier to try than a broad platform migration.
- **Trust was part of utility.** Context, long-running agents, and autonomous tools increase the need for accountability, local control, and reversible actions.

Those observations favored a focused local utility with a screenshot-level demo and a one-command read-only first run. They did not justify another general-purpose agent framework.

## The problem was already measurable

Three public Codex issues made the resource-lifecycle gap unusually concrete:

| Evidence | What happened | Product implication |
| --- | --- | --- |
| [openai/codex#35383](https://github.com/openai/codex/issues/35383) | 118 full repository run copies accumulated under `/private/tmp`, consuming 202 GB over roughly three days; almost all were invisible to `git worktree list`. | Git worktree state alone cannot explain agent-created storage. Temp copies need agent ownership evidence and an inventory surface. |
| [openai/codex#34061](https://github.com/openai/codex/issues/34061) | Session storage reached about 760 GiB, about 755 GiB of it JSONL. The report also notes that deleting those files would likely remove resumable history. | Size and age are not deletion permission. Session/history data must be visible but never automatically `SAFE`. Allocated bytes and logical bytes should be distinguished for sparse files. |
| [openai/codex#11090](https://github.com/openai/codex/issues/11090) | Multiple older `codex app-server` processes remained alive with `PPID=1` while newer processes ran, and several opened the same rollout file. | Storage ownership needs process evidence. Process handling is high-risk, so v0.1 observes and protects referenced resources instead of killing anything. |

These are individual reports, not prevalence estimates. They are enough to prove that the failure mode exists, can be severe, and crosses storage, session, Git, and process boundaries.

## Existing tools and the remaining gap

The market is not empty. The useful distinction is scope and mutation policy, not whether another project has the word “janitor” in its name.

| Project | What its public documentation focuses on | Gap AgentMop targets |
| --- | --- | --- |
| [`theQuert/cc-reaper`](https://github.com/theQuert/cc-reaper) | Monitoring and reaping orphaned Claude-related process groups, MCP servers, browsers, and some Codex stragglers using process ancestry and resource rules | Process cleanup does not provide a unified, reversible inventory of agent home data, session stores, caches, temp copies, and Git state |
| [`yanqr213/agent-worktree-janitor`](https://github.com/yanqr213/agent-worktree-janitor) | Offline workspace and Git cleanup plans, CI gates, and commented review scripts; it deliberately never deletes | It analyzes a selected workspace rather than correlating the canonical local stores and live processes of multiple installed coding agents |
| [`WillieCubed/disk-janitor`](https://github.com/WillieCubed/disk-janitor) | Preventing repeated Cargo/pnpm build data and scheduling cleanup of regenerable build artifacts and abandoned worktrees | Age/config-based build hygiene is different from proving agent ownership and protecting session history across providers |
| [`jamesrochabrun/AgentHub`](https://github.com/jamesrochabrun/AgentHub) | A native macOS environment for launching, monitoring, reviewing, and managing Claude Code/Codex sessions and worktrees | A full agent workspace is not a small cross-agent diagnostic CLI, and its goal is session operation rather than an evidence-first disk triage layer |

AgentMop should coexist with these tools. For example, a developer could use AgentMop to explain disk ownership, `cc-reaper` to handle a confirmed process leak, and a build deduplication tool to prevent future `node_modules` or Cargo duplication.

## Why this idea instead of the obvious alternatives

Several directions fit the Trending snapshot but were rejected for the first release:

### Another agent orchestrator

Agent managers and long-running orchestration were already prominent in the snapshot. A new orchestrator would require users to move their workflow and would compete on provider integrations before proving a unique result. AgentMop works after any supported agent and asks for no workflow migration.

### Another skills collection

Skills are easy to distribute and were visibly popular, but a prompt-based cleanup recipe cannot reliably establish filesystem identity, Git state, symlink boundaries, or reversible mutation. The safety contract needs executable, testable code.

### A generic disk cleaner

Generic cleaners understand file patterns and age. They do not know that a 755 GiB directory may be resumable user history, that a clean worktree may still be live, or that a temp directory may be a full agent run copy with no Git registration. Agent ownership is the differentiator.

### An automatic process killer

Orphan processes are real, but ownership mistakes can terminate active tools or shared servers. v0.1 uses process data only as protective evidence: a matching path can make a resource `LIVE`, while incomplete process evidence blocks `SAFE`. It never sends a signal. Better observation is a prerequisite for any future process action.

## Product decisions derived from the research

### 1. Read-only is the first-run contract

`agentmop` with no subcommand scans and reports. A user can try the one-line command without granting permission to delete data. HTML and JSON are outputs, not cloud uploads.

### 2. Ownership must be positive evidence

An old directory in `/tmp` is not automatically agent-owned. For `SAFE`, v0.1 requires a canonical agent root or a positive association from bounded `session_meta` working-directory data; a worktree must also have complete registered Git identity. A basename such as `codex-*` or `claude-*` is discovery evidence only and can never authorize `SAFE`; without another protective state it falls back to `REVIEW`. Process path references are liveness evidence, not sufficient ownership evidence for `SAFE`. Generic `project-*`, `repo-*`, and `workspace-*` names never gain cleanup ownership from a session reference alone. Standalone and bare Git repositories anywhere inside a temporary candidate never become `SAFE`: dirty worktree state is `DIRTY`, active references are `LIVE`, while clean unreferenced and bare repositories are `REVIEW` because they can still contain unique commits or refs.

### 3. Session data is user data

Session and history stores are unconditionally `REVIEW` with cleanup disabled. AgentMop reads only a bounded JSONL prefix and accepts a small metadata allowlist: absolute `cwd` plus length- and character-constrained `id`, `source`, and `parent` tokens. Prompt, message, model-reasoning, tool-output, secret, and source-content fields are not read into the report. Local paths can still be sensitive, so every report must be reviewed before sharing.

### 4. `SAFE` is a conjunction, not a vibe

For a cache or temp artifact, `SAFE` requires strong agent ownership, a passed staleness threshold, a successful fresh process scan, no matching live reference, complete filesystem inspection, and an implemented move strategy. If a matched process working directory cannot be observed, `SAFE` is disabled for that agent. A worktree additionally needs clean Git state, linked-worktree registration, a main repository, common Git directory, branch, and HEAD.

If any required evidence is missing, the result falls to `REVIEW` or `UNKNOWN` rather than guessing.

### 5. Allocated bytes are the primary footprint

Sparse JSONL files can have a very large logical length without occupying the same amount of physical disk. On filesystems that expose block counts, AgentMop reports `st_blocks × 512` as the footprint and keeps logical bytes as metadata. This makes the top-line number closer to the disk problem the user is trying to solve.

### 6. Cleanup is a transaction boundary

`clean --safe` performs a fresh scan. The mutation layer accepts only cleanup-eligible `SAFE` items from a report less than five minutes old, rejects broad roots and symlinked path components, compares the recorded filesystem snapshot, and repeats process-reference checks across all supported agents immediately before mutation. It atomically records the recovery mapping before moving anything. Cache/temp data is renamed into a private quarantine. After a second dirty/HEAD check, a linked worktree is moved there whole with `git worktree move`, preserving ignored local files. Restore refuses collisions, validates the original object's identity before accepting an already-restored shortcut, and verifies a worktree's repository and HEAD. Purge records each planned deletion before the permanent operation. If recursive deletion begins and then fails, remaining data can be restored but the item permanently retains a partial-integrity result; already-purged or uncertain items can never make restore claim whole-batch success. Partial CLI outcomes exit non-zero.

### 7. The demo must be honest

The 202.4 GB demo makes the value visible, but every page and terminal rendering labels it as fictional sample data. Marketing imagery must never imply that a user's real machine was scanned when it was not.

## v0.1.0 boundary

The first release implements:

- explicit adapters for Codex, Claude Code, Cursor, and OpenCode data roots;
- allocated-size inventory without following symlinks;
- bounded session metadata, read-only process observation, and Git worktree inspection;
- deterministic `DIRTY`, `LIVE`, `SAFE`, `REVIEW`, and `UNKNOWN` verdicts;
- terminal, JSON, and self-contained HTML reports;
- fresh `SAFE` planning, recoverable file and whole-worktree quarantine, validated restore, and explicit purge;
- zero third-party npm runtime dependencies on Node.js 20 or newer.

It does **not** implement:

- automatic deletion of session or history stores;
- process termination;
- a background cleanup daemon or schedule;
- an exhaustive scan of every desktop-app or extension cache;
- cloud upload, telemetry, accounts, or fleet management;
- a promise that every old artifact is valueless;
- an npm release yet—the launch path is currently `npx github:weivwang/agentmop`.

## About the Trending goal

Reaching GitHub Trending—especially rank #1—is an external outcome. It depends on timing, authentic community interest, competing launches, GitHub's ranking system, and factors the repository cannot control. No README, feature set, or launch plan can guarantee it, and AgentMop should not manufacture stars, spam communities, or misrepresent demo data to chase the ranking.

What the project can control is the quality of the launch surface:

- a problem statement backed by public, measurable incidents;
- a memorable but accurate one-line position;
- a 30-second, read-only first run;
- a visual demo that is explicitly sample data;
- bilingual documentation;
- a small, dependency-free package;
- visible safety invariants and tests;
- clear adapter contribution seams.

Trending is therefore an aspiration and a distribution experiment, not a completion criterion for the software.

## Success measures that remain useful after launch day

The project should prefer product evidence over a single popularity rank:

- time from command to first useful report;
- bytes attributed to a specific agent and resource class;
- proportion of artifacts with human-verifiable ownership evidence;
- zero false-positive deletion of live, dirty, session, history, or ambiguous data;
- successful quarantine/restore round trips and collision refusal;
- adapter issues that include safe, redacted fixtures;
- users who return because AgentMop found a real resource-lifecycle problem.

If those measures improve, a strong launch can follow. If they do not, a Trending badge would not make the cleanup policy trustworthy.
