<div align="center">
  <a href="https://github.com/weivwang/agentmop">
    <img src="assets/logo.svg" width="104" alt="AgentMop 标志">
  </a>

  <h1>AgentMop</h1>

  <p><strong>你的编程 Agent 已经下班了，它留下的 202 GB 还在。</strong></p>
  <p>专为 AI 编程 Agent 打造的 <code>ncdu + lsof + git doctor</code>。</p>

  <p>
    <a href="https://github.com/weivwang/agentmop/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/weivwang/agentmop/actions/workflows/ci.yml/badge.svg"></a>
    <a href="https://github.com/weivwang/agentmop/releases"><img alt="版本" src="https://img.shields.io/github/v/release/weivwang/agentmop?sort=semver&display_name=tag"></a>
    <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/github/license/weivwang/agentmop"></a>
    <img alt="Node.js 20 或更高版本" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
    <img alt="零运行时依赖" src="https://img.shields.io/badge/runtime_dependencies-0-70f2a1">
  </p>

  <p>
    <a href="https://weivwang.github.io/agentmop/">在线演示</a> ·
    <a href="README.md">English</a> · 简体中文 ·
    <a href="docs/WHY.md">为什么做 AgentMop？</a> ·
    <a href="CONTRIBUTING.md">参与贡献</a>
  </p>
</div>

![AgentMop 仪表盘：展示 Agent 占用空间、所有权证据和安全结论](assets/agentmop-dashboard.png)

AI 编程 Agent 留下的不只是代码，还有 linked worktree、完整仓库副本、缓存、日志、可恢复的会话，以及父进程退出后仍在运行的进程。一份公开的 Codex 报告发现了[占用 202 GB 的 118 份运行副本](https://github.com/openai/codex/issues/35383)；另一份报告测得[约 755 GiB 的 session JSONL](https://github.com/openai/codex/issues/34061)；还有一份报告记录了[`PPID=1` 的孤儿 `app-server` 进程](https://github.com/openai/codex/issues/11090)。

AgentMop 把这些散落的数据整理成一份可解释的清单，目前支持 **Codex、Claude Code、Cursor 和 OpenCode**。它会统计已知本地存储、观察匹配进程、检查 Git 状态、记录所有权证据，并给出五种刻意保守的结论：`LIVE`、`DIRTY`、`SAFE`、`REVIEW` 或 `UNKNOWN`。

默认命令只读。AgentMop 没有遥测、账号、API Key、模型或第三方 npm 运行时依赖。可选清理只接受刚刚重新扫描过、同时属于 `SAFE` 且具备已实现清理策略的项目；在你明确执行 purge 之前，默认可恢复。

## 30 秒开始使用

需要 Node.js 20 或更高版本，并确保 `PATH` 中可用 Git。

```bash
npx github:weivwang/agentmop
```

目前 npm 包**尚未发布**，因此当前优先使用上面的 GitHub package spec，无需全局安装。npm 首次发布后可改用：

```bash
npx agentmop
```

只想先看完整效果、不扫描自己的电脑：

```bash
npx github:weivwang/agentmop demo --no-open
```

`demo` 会生成一个自包含 HTML 报告，同时打印可复现的终端仪表盘。演示模式里的路径、大小、进程和结论全部是虚构样例，并会被醒目标记为 sample data。

<details>
<summary><strong>v0.1.0 的真实 demo 命令输出节选</strong>（数据为虚构样例；此处缩写了长路径和中间 breakdown）</summary>

```text
╭──────────────────────────────────────────────────────────────────────────────╮
  AGENTMOP  Agent workspace hygiene report
  See the mess. Keep the work. · 2026-08-10T09:30:00Z
  ◆ SAMPLE DATA — no files were scanned or changed
╰──────────────────────────────────────────────────────────────────────────────╯

OVERVIEW
  202.4 GB observed  ·  54.4 GB proven safe  ·  33.6 GB needs review
  8 artifacts  ·  3 live agent processes  ·  read-only scan

STATUS LEGEND
  [DIRTY] uncommitted work    [LIVE] actively owned    [REVIEW] decide manually
  [UNKNOWN] proof incomplete    [SAFE] positive evidence; eligible for quarantine

ARTIFACTS · HIGHEST RISK FIRST
  RISK       AGENT       RESOURCE          SIZE AGE        LOCATION
  [DIRTY]    Claude Code worktree       71.6 GB today      ~/.claude/worktrees/checkout-api-v2
  [LIVE]     Codex       worktree       42.8 GB today      ~/.codex/worktrees/desktop-sync
  [REVIEW]   Claude Code history        22.7 GB 1 month    ~/.claude/projects
  [UNKNOWN]  OpenCode    temp            8.9 GB 1 month    ~/.local/share/opencode/tmp
  [SAFE]     Cursor      cache          31.4 GB 3 months   ~/.cursor/cache

NEXT STEPS
  Preview only     agentmop clean --safe --dry-run
  Quarantine safe  agentmop clean --safe
  Visual report    agentmop scan --html agentmop-report.html
```

</details>

## 它会查找什么

AgentMop v0.1.0 只扫描一组小而明确的 Agent 所有目录。不存在的目录会被忽略，它不会在整个 home 目录里猜测文件归属。

| Agent | 检查的存储 | Worktree 根目录 |
| --- | --- | --- |
| Codex | `~/.codex/sessions`、`archived_sessions`、历史、日志、缓存、`tmp` 和 `.tmp` 数据 | `~/.codex/worktrees` |
| Claude Code | `~/.claude/projects`、历史、文件历史、shell/session 状态、todos、日志、缓存和临时数据 | `~/.claude/worktrees` |
| Cursor | `~/.cursor/projects`、chats、历史、日志、缓存、cached data 和临时数据 | `~/.cursor/worktrees` |
| OpenCode | `~/.local/share/opencode` 下的 storage、snapshot、日志、缓存和临时数据，以及配置缓存 | OpenCode 数据目录下的 `worktree` / `worktrees` |

它还会检查：

- 默认检查系统临时目录的直接子项，也可以用可重复的 `--tmp-root` 额外加入一个或多个精确根目录；
- 供人工检查的 Agent 风格临时目录名，以及由有限 session metadata 明确关联的临时位置；
- 已知 Agent 根目录下注册过的 linked Git worktree；
- 匹配 Codex、Claude Code、Cursor、OpenCode 的进程，并使用脱敏后的命令和路径引用做关联。

任何临时目录 basename——包括 `codex-*`、`claude-*`、`cursor-*` 或 `opencode-*`——本身都不能证明所有权或授权 `SAFE`。没有更强证据时，只有名称的候选回退到 `REVIEW`；保护性证据也可能使它成为 `LIVE`、`DIRTY` 或 `UNKNOWN`。`project-*`、`repo-*`、`workspace-*` 等通用名称不会仅因 session 引用就获得清理所有权。进程扫描仅用于观察，AgentMop 不会终止进程。

如果临时路径内含 standalone 或 bare Git 仓库，也永远不会自动清理：有修改的 worktree 标为 `DIRTY`，活跃引用标为 `LIVE`，干净且无引用或 bare 的仓库则是 `REVIEW`，因为它可能包含尚未推送的唯一提交或 refs。只有已注册的 linked worktree 才会进入更严格的 worktree 安全路径。

## 工作原理

```text
已知 Agent 目录 ─┐
临时目录 ────────┼─> lstat 清点 ─┐
有限 metadata ───┤               ├─> 证据分类器 ─> Terminal / HTML / JSON
进程表 ──────────┤               │                    │
Git worktree ────┘               └────────────────────┴─> 最新 SAFE 计划
                                                               │
                                            quarantine <─ restore / purge
```

1. **窄范围发现。** Adapter 只枚举已知位置；临时目录扫描只看显式 temp root 的直接子项；worktree 搜索有深度上限。
2. **观察但不追随链接。** 文件系统遍历使用 `lstat`，并在不追随链接的前提下检查可信 HOME 或 temp-root 边界之下的每个候选路径组件。在文件系统提供 block count 时，占用按 allocated bytes（`st_blocks × 512`）计算，并把 logical bytes 留在 metadata 中，避免把 sparse JSONL 当成全部已分配。Session reader 只读取 JSONL 的有限前缀，只允许返回受约束的标识符和绝对工作目录，不读取 prompt、消息、工具输出或源码内容字段。
3. **关联证据。** 报告会保留 Agent 路径、session 工作目录引用、进程路径、Git 注册信息、branch/HEAD、修改时间和检查错误。
4. **证据不足就保守。** 分类是确定性的；进程证据缺失、文件系统访问不完整、所有权弱或 Git 状态含糊，都会阻止 `SAFE`。
5. **本地渲染。** 终端和 JSON 走 stdout；`--html` 生成单个自包含文件，不加载外部脚本、样式或网络资源。
6. **只有明确请求才修改。** `clean --safe` 会重新扫描，只选择同时可清理的 `SAFE` 项，再次校验后记录可恢复批次。

### 五种结论

| 结论 | 含义 | 清理行为 |
| --- | --- | --- |
| `DIRTY` | Git 发现已修改或未跟踪内容。对 worktree 而言它优先展示，避免未完成工作被掩盖。 | 永不自动选择 |
| `LIVE` | 正在运行的 Agent 进程引用了此路径。 | 永不自动选择 |
| `SAFE` | 同时存在明确的 Agent 所有权、足够的陈旧时间、成功且无匹配引用的进程检查，以及已实现的清理策略。Linked worktree 还必须干净、已注册，并保留 branch 与 HEAD。 | 可进入最新清理计划 |
| `REVIEW` | 数据可能有价值、过新、所有权证据弱，或扫描时没有进程证据。 | 永不自动选择 |
| `UNKNOWN` | 检查或身份信息不完整，例如非 history symlink、不可读的非 history 路径或无法确认的 Git 身份。Session/history policy 优先，始终把这些存储留在 `REVIEW`。 | 永不自动选择 |

**Session 和 history 无论多旧、多大，都永远不会是 `SAFE`。** 删除 session JSONL 可能破坏 resume/history；[755 GiB 事件报告明确说明了这一数据损失成本](https://github.com/openai/codex/issues/34061)。AgentMop 会把它们计入 `REVIEW`，让你看见占用，但不会把“旧”偷换成“可以删”。

## 安全模型

`SAFE` 的准确含义是“当前实现的证据策略允许使用这一清理方案”，而不是“这些数据绝无任何价值”。请审阅每一份计划，并为重要工作保留备份。

### 扫描边界

- `agentmop` 和 `agentmop scan` 都不会修改被扫描的 Agent 资源；`--html` 只会写入你明确请求的报告文件。
- `--no-processes` 可以用于清点，但会刻意阻止所有项目变成 `SAFE`。
- 进程表探针失败时不会产生任何 `SAFE`；如果某个匹配进程的工作目录无法观察，只会禁用该 Agent 的 `SAFE`。
- 候选 symlink 和路径祖先中的 symlink 永不追随、永不清理。
- 报告可能含本地路径、仓库名和脱敏命令，分享前请先检查。

### 清理边界

- `clean` 缺少 `--safe` 时直接拒绝，并且会自行发起一次新扫描。
- 修改层只接受五分钟内报告中的 `SAFE` 且 cleanup-eligible 项目。
- 指定 `--id` 后，如果 id 不存在、不再安全或不支持清理，命令会失败。
- 过宽根目录、不支持的资源类型、缺失或已变化的快照，以及路径组件中的 symlink 会被修改层独立拒绝。
- 每个项目在修改前都会重新检查所有受支持 Agent 的进程引用；此时任何 cwd 证据缺口都会停止清理。干净 linked worktree 还会再次检查 Git status 和 HEAD。
- 缓存和临时数据会被 rename 到 `~/.agentmop/quarantine/<batch-id>/`；linked worktree 使用 `git worktree move` 整体进入同一个私有批次，而不是直接 remove。
- 整体移动会同时保留 tracked 内容和 ignored 本地文件。私有 manifest 记录原路径、仓库、branch、HEAD、文件系统身份和已完成操作。
- 每次修改前都会先原子记录 original→quarantine 映射，因此移动后的进程中断仍可恢复；捕获到失败时还会停止后续操作并记录 partial 结果。它不承诺断电级持久性。

### Restore 与 purge 边界

- `restore <batch-id>` 会逆序恢复，并拒绝覆盖后来重新创建的路径。对 worktree，它会先核验隔离中的 HEAD 和仓库，再把同一个完整 worktree 移回。
- `quarantine list` 展示可恢复和 partial 批次。
- `purge <batch-id> --yes` 是独立的永久操作。每项删除都会预先记账；后续失败会产生 `purge-partial`。Restore 会尽力搬回残留内容，但只要 purge 已开始却未确认完成，就必须返回 `restore-partial`，因为无法排除已有内容缺失。
- cleanup、restore 或 purge 的 partial 结果都会返回非零 CLI 退出码，避免自动化误判成功。

先 dry run：

```bash
npx github:weivwang/agentmop clean --safe --dry-run
```

## CLI

| 命令 | 作用 |
| --- | --- |
| `agentmop` / `agentmop scan` | 只读扫描并打印终端报告 |
| `agentmop scan --json` | 输出机器可读报告 |
| `agentmop scan --html report.html --no-open` | 生成自包含可视化报告，不自动打开浏览器 |
| `agentmop scan --deep` | 在仍受限的前提下检查更多 session metadata 文件，并搜索更深的已知 worktree 根目录 |
| `agentmop scan --older-than 14d` | 修改陈旧阈值，支持 `m`、`h`、`d`、`w` |
| `agentmop scan --tmp-root /path` | 在系统默认目录之外加入精确 temp root；可重复指定多个根目录 |
| `agentmop scan --no-processes` | 跳过进程观察；不会有项目变成 `SAFE` |
| `agentmop clean --safe --dry-run` | 重新扫描并预览可清理的 `SAFE` 项 |
| `agentmop clean --safe [--id ID]` | 隔离所有符合项，或用可重复的精确 id 缩小范围 |
| `agentmop quarantine list` | 列出清理批次及状态 |
| `agentmop restore BATCH_ID` | 恢复可恢复批次 |
| `agentmop purge BATCH_ID --yes` | 永久删除隔离载荷 |
| `agentmop demo --no-open` | 渲染带有清晰样例标记的确定性演示报告 |

交互式清理会要求输入根据当前计划生成的确认 token。脚本或 CI 中优先用 `--dry-run`；只有看过精确计划后才应使用 `--yes`。

## 支持矩阵

### Agent adapter

| 能力 | Codex | Claude Code | Cursor | OpenCode |
| --- | :---: | :---: | :---: | :---: |
| 已知 home 数据清点 | ✅ | ✅ | ✅ | ✅ |
| Session/history 可见性（仅 `REVIEW`） | ✅ | ✅ | ✅ | ✅ |
| 缓存/日志/临时数据清点 | ✅ | ✅ | ✅ | ✅ |
| 已知 linked worktree 发现 | ✅ | ✅ | ✅ | ✅ |
| 匹配进程观察 | ✅ | ✅ | ✅ | ✅ |

Agent 的存储布局会随版本变化。这个表只表示上文列出的 v0.1.0 明确路径已实现，并不表示所有桌面 App 缓存或第三方扩展目录都已覆盖。如果当前布局缺失，请提交一份路径已脱敏的 [adapter request](https://github.com/weivwang/agentmop/issues/new?template=adapter.yml)。

### 平台

| 平台 | 当前行为 |
| --- | --- |
| macOS | 文件系统、Git 和基于 `ps` 的进程观察；对每个匹配的 Agent 进程只读查询一次 `lsof` cwd，同时关联命令中出现的绝对路径。 |
| Linux | 文件系统、Git、`ps`，并通过 `/proc/<pid>/cwd` 获取进程工作目录证据。 |
| Windows | 实验性文件系统/Git 清点。如果 Unix 风格进程探针不可用，会给出警告且不产生 `SAFE`。 |

CI 在 Ubuntu、macOS、Windows 上使用 Node 20、22、24 运行零依赖测试。不同操作系统上的真实存储 fixture 与进程语义仍有差异，因此 CI 绿色不等于所有 Agent 版本的磁盘布局都相同。

## 与现有项目的区别

这些项目解决同一类卫生问题的不同部分，很多时候可以互补使用。

| 项目 | 主要任务 | 证据 / 决策模型 | 修改模型 |
| --- | --- | --- | --- |
| **AgentMop** | 多 Agent 存储、worktree、session、temp 和进程清单 | 五种 fail-closed 结论；逐项展示所有权和安全证据 | 最新 `SAFE` 计划 → 可恢复的文件或完整 worktree 隔离 → 显式 restore 或 purge |
| [`cc-reaper`](https://github.com/theQuert/cc-reaper) | 诊断并清理 Claude/Codex 相关孤儿进程树 | 进程祖先、PGID、年龄/CPU/FD 规则和保护模式 | 发送进程信号；提供 dry-run/监控路径，重点是实时系统资源 |
| [`agent-worktree-janitor`](https://github.com/yanqr213/agent-worktree-janitor) | 离线 workspace 清理计划与 CI hygiene gate | 把 workspace/Git 文本解析为风险评分报告 | 自身永不删除，只输出供人工审阅的注释 Bash/PowerShell 计划 |
| [`disk-janitor`](https://github.com/WillieCubed/disk-janitor) | 防止 Cargo/pnpm 构建数据重复，并定期清理陈旧构建/worktree | 配置项目根目录和时间阈值，支持 dry run | 直接或定时清理可再生构建产物与废弃 worktree |
| [`AgentHub`](https://github.com/jamesrochabrun/AgentHub) | 原生 macOS Claude Code/Codex session 运行与监控界面 | Session 所有权与 App 管理的 worktree 上下文 | 在完整 Agent 工作台中交互管理 worktree/session |

AgentMop 的核心主张很窄：**只有工具能解释“谁拥有它、为什么它不再 live、如何把它找回来”，本地存储才应该进入删除流程。** 它不会终止进程、改写 Agent 配置、安排后台删除，也不会把旧 session history 当成垃圾。

## 路线图

- [x] Codex、Claude Code、Cursor、OpenCode 只读扫描器
- [x] 基于证据的五状态分类
- [x] Terminal、JSON 和自包含 HTML 报告
- [x] 最新扫描清理、隔离批次、restore 与显式 purge
- [ ] 发布 npm 包，并为 release 附加可验证产物
- [ ] 用脱敏真实 fixture 扩充 Agent 布局，尤其是桌面 App 缓存
- [ ] 在没有 `/proc` 的平台补充更多进程所有权证据
- [ ] 通过同一 fail-closed 合约支持更多编程 Agent
- [ ] 稳定用于策略和 fleet 工具的版本化 JSON schema

路线图只表达方向，不承诺日期。安全回归的优先级高于增加更多删除目标。

## 开发与贡献

AgentMop 的运行时只使用 Node.js 标准库。

```bash
git clone https://github.com/weivwang/agentmop.git
cd agentmop
npm install
npm run check
npm test
node bin/agentmop.js demo --html /tmp/agentmop-demo.html --no-open
```

新 adapter 必须使用隔离 fixture home，只读取有限 metadata，避开 prompt/源码，不追随 symlink，不把 session/history 放入 `SAFE`，并给出人类可核验的理由。修改清理行为前请阅读完整的[贡献指南](CONTRIBUTING.md)、[架构说明](docs/ARCHITECTURE.md)和[安全策略](SECURITY.md)。

## 许可证

[MIT](LICENSE) © weiwei Wang
