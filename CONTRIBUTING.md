# Contributing to AgentMop

AgentMop should be conservative, explainable, and useful without an account or API key.

## Development

Requirements: Node.js 20 or newer and Git.

```bash
npm install
npm test
npm run check
node bin/agentmop.js demo --no-open --html /tmp/agentmop-demo.html
```

The project intentionally has zero runtime dependencies. A dependency proposal should explain why the same safety property cannot be achieved with Node's standard library.

## Adapter rules

Each agent adapter must:

1. Work against an isolated fixture HOME in tests.
2. Read only bounded metadata needed to prove ownership or liveness.
3. Never parse or emit prompt text, model reasoning, tool output, secrets, or source content.
4. Treat session/history data as `REVIEW`, never `SAFE`.
5. Require positive evidence before returning `SAFE`; absence of evidence means `UNKNOWN`.
6. Avoid following symlinks.
7. Include a reason a human can verify from the report.

## Pull requests

Keep changes focused. Add tests for safety decisions, including the failure mode. For cleanup changes, include a round-trip test showing that quarantine and restore preserve the original bytes and that collision handling refuses to overwrite files.

By participating, you agree to follow the [Contributor Covenant](CODE_OF_CONDUCT.md).
