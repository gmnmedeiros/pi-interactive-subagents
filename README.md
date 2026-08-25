# pi-interactive-subagents

Interactive, asynchronous subagents for [Earendil Pi](https://github.com/earendil-works/pi), running in [Herdr](https://herdr.dev/) panes.

Spawn a restricted agent, continue working in the parent session, interact with the child when needed, and receive its result when it finishes. The original status widget stays above the parent editor, so child traffic does not clutter the parent transcript.

## Installation

Install the immutable Git release:

```bash
pi install git:github.com/gmnmedeiros/pi-interactive-subagents@v4.0.1
```

Start Pi inside a Herdr-managed pane. The extension detects Herdr automatically after Pi loads the package.

To update to a later release, install its explicit tag:

```bash
pi install git:github.com/gmnmedeiros/pi-interactive-subagents@<new-tag>
```

## Requirements

- Herdr `0.8.2` or later (`0.8.2` is the tested port target)
- `@earendil-works/pi-coding-agent` `0.84.3` or later (`0.84.3` is the tested Pi target)
- Pi must run inside a Herdr pane with `HERDR_ENV=1`

This release does not support tmux.

## How it works

`subagent()` returns after the child has started. The child then runs independently and sends its final result back to the parent as a steer message.

The extension targets the Pi process's inherited Herdr pane explicitly and requests `--no-focus`. Before it launches Pi or Claude Code in a new pane, it sends a harmless shell bootstrap command and waits for a readiness file. If the shell does not accept that command, the extension closes the unused pane and retries. The real agent command is never sent to an unverified shell.

Each launch script writes:

1. a started file before starting the agent process;
2. a process-exit file containing the final exit code.

Terminal sentinels remain a fallback, not the primary lifecycle signal.

### Layout

The first top-level child opens in a right split. Later children split down the shallowest tracked child pane, which keeps the parent width stable and balances a right-side agent column. A nested agent's first child splits down from that agent.

Closing children in any order collapses the extension's layout model. The extension tracks panes it created and refuses to close the parent pane.

```text
┌──────────────────── parent ────────────────────┬──── child 1 ────┐
│                                               ├─────────────────┤
│                                               │    child 2      │
│                                               ├─────────────────┤
│                                               │    child 3      │
└───────────────────────────────────────────────┴─────────────────┘
```

### Widget

The original widget tracks all running children:

```text
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

It shows startup, active work, waiting, and stalled/recovered transitions. Completion removes the child and delivers its result to the parent.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn an agent in a dedicated Herdr pane |
| `subagent_message` | Steer a running agent or resume a finished agent by name |
| `subagents_list` | List available agent definitions |
| `ask_question` | Let a child ask its orchestrator one question and wait for the reply |

There is also a `/subagent <agent> <task>` command.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | string | required | Known and permitted agent definition |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Pane and widget label; duplicates get numeric suffixes |
| `model` | string | agent model | Model override for this spawn |
| `cwd` | string | agent `cwd` | Working directory |

### Messaging and resume

Address agents by their unique names:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running agent:** the message is typed into its pane and becomes steering input.
- **Finished agent:** the saved session resumes autonomously with the message as its next task.

Every spawn records its name and session in `artifacts/<sessionId>/subagent-registry.json`. The resolved sandbox is saved beside the session as `<session>.loadout.json`. Resume restores the same model, thinking level, prompt mode, tool allowlist, backing extensions, spawn allowlist, working directory, and agent configuration. Resume is refused when that snapshot is missing.

### `ask_question`

A child can call `ask_question` when it needs a decision. It remains open in `waiting` state. The parent receives the question and replies with:

```typescript
subagent_message({ name: "worker", message: "Use the existing schema." });
```

Parallel questions are supported because every child has a unique name and sidecar file.

## Bundled agents

| Agent | Model | Tools | Role |
| --- | --- | --- | --- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Read-only codebase reconnaissance |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Sourced web research |
| **worker** | `openrouter/z-ai/glm-5.3` | file and shell tools, web tools, child spawning | General implementation; may spawn `scout` and `researcher` |

All bundled agents use `auto-exit: true`.

## Custom agents

Place agent definitions in:

- `.pi/agents/*.md` for a project;
- `~/.pi/agent/agents/*.md` globally;
- `agents/*.md` in this package.

Discovery precedence is project, then global, then package. A project definition can override a bundled definition with the same name.

```markdown
---
name: code-scout
description: Read-only code investigation
model: openai-codex/gpt-5.6-sol
thinking: low
tools: read, grep, find, ls
session-mode: standalone
auto-exit: true
---

Investigate the requested code and return exact file references.
```

### Frontmatter reference

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Agent name used by `subagent` |
| `description` | string | Text shown by `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | Thinking level passed to Pi |
| `tools` | string | Comma-separated strict tool allowlist |
| `subagent_agents` | string | Permitted child agent names; presence grants spawning tools |
| `skills` | string | Comma-separated skills loaded for the child |
| `session-mode` | string | `standalone`, `lineage-only`, or `fork` |
| `system-prompt` | string | `append` or `replace` for the Markdown body |
| `auto-exit` | boolean | Exit after normal completion |
| `interactive` | boolean | Whether status transitions wake the parent |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from discovery while retaining direct invocation |
| `cli` | string | Use `claude` to launch Claude Code instead of Pi |

### Restricting tools and child agents

Set `tools` to enable the default-deny sandbox. Pi starts with extension discovery disabled and receives only the listed tools, their reviewed backing extensions, and the child control tool `ask_question`.

```markdown
---
name: restricted-worker
tools: read, write, edit, bash
subagent_agents: scout, researcher
---
```

Rules:

- omit `subagent_agents` to prevent this agent from spawning children;
- list names in `subagent_agents` to permit only those child types;
- every nested spawn must name a permitted agent;
- resumed sessions replay the original restrictions;
- omit `tools` and `subagent_agents` only when the child is intentionally allowed to keep Pi's default tools and extensions.

Additional extension-backed tools can register through `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

### Session modes

- `standalone`: fresh session without a parent lineage link;
- `lineage-only`: fresh session with `parentSession` linkage but no copied turns;
- `fork`: child session seeded with the caller's conversation context.

### Auto-exit and interaction

With `auto-exit: true`, a normal final turn closes the agent. Auto-exit pauses while the child has unanswered questions or running child agents.

`interactive` controls whether stalled/recovered transitions wake the parent. By default, autonomous agents send status transitions and user-driven agents remain quiet. The widget updates in both modes.

## Role-specific working directories

Set `cwd` in frontmatter or at spawn time to load configuration from a role folder:

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

The child starts in that directory and can load its local context, skills, and approved extensions.

## Configuration

Status notifications use `config.json` in the package directory. Copy `config.json.example` to enable or disable them:

```json
{
  "status": { "enabled": true }
}
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_BIN_PATH` | `herdr` | Override the Herdr executable |
| `PI_SUBAGENT_SURFACE_READY_TIMEOUT_MS` | `10000` | Maximum wait for the shell and bootstrap in one attempt |
| `PI_SUBAGENT_SURFACE_READY_ATTEMPTS` | `2` | Maximum shell bootstrap attempts |

## Development and testing

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
```

The default integration command is safe: it creates no panes and makes no LLM calls.

Real Herdr tests are explicitly opt-in because they manipulate the active Herdr session:

```bash
PI_RUN_HERDR_INTEGRATION=1 npm run test:integration
```

LLM lifecycle tests require both gates:

```bash
PI_RUN_HERDR_INTEGRATION=1 \
PI_RUN_LLM_INTEGRATION=1 \
PI_TEST_MODEL=openai-codex/gpt-5.6-sol \
npm run test:integration
```

Run live tests only in a disposable, focused Herdr test session. They can create multiple visible panes. If a run is interrupted, clean only the pane IDs recorded by the test harness:

```bash
npm run test:cleanup-herdr
```

## Acknowledgements

This Herdr port is based on [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), which is based on [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The original projects created the interactive subagent architecture and status widget.

## License

MIT
