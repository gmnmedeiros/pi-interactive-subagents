# Changelog

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
