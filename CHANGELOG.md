# Changelog

## 5.0.0 — 2026-08-25

### Changed

- Canonized `worker` as the only bundled agent type.
- Set the worker model to `openai-codex/gpt-5.6-sol` with medium thinking.
- Restricted the worker to `read`, `write`, and `edit`.
- Removed bundled worker child-spawning permission.
- Removed the bundled `scout` and `researcher` definitions.

## 4.0.1 — 2026-08-25

### Fixed

- Wait until the pane shell owns the foreground process group before sending the readiness bootstrap. This supports shells that run slow initialization commands such as `pyenv rehash`.

## 4.0.0 — 2026-08-25

### Changed

- Replaced tmux panes with explicit, no-focus Herdr panes.
- Migrated extension APIs to `@earendil-works/pi` 0.84.3.
- Kept the original subagent status widget and agent-definition behavior.
- Added a balanced right-side column for concurrent and nested children.

### Reliability

- Added shell-readiness bootstrapping before agent launch.
- Added causal started and process-exit files.
- Added bounded startup retries that close unused panes before retrying.
- Protected the parent pane from extension cleanup.

### Testing

- Added 155 unit and fault-injection tests.
- Made live Herdr and LLM integration suites explicitly opt-in.
- Added interruption cleanup and a stale test-pane manifest.
