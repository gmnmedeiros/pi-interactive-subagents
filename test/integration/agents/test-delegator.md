---
name: test-delegator
description: Integration agent that delegates only to test-echo
model: anthropic/claude-haiku-4-5
tools: read
subagent_agents: test-echo
auto-exit: true
disable-model-invocation: true
---

Delegate exactly as instructed. Wait for the child result, then summarize it briefly.
