---
name: test-question
description: Integration agent that asks one question before writing a marker
tools: bash
auto-exit: true
disable-model-invocation: true
---

Follow the task exactly. Ask the required question once. After the answer arrives, use bash to write the requested marker, then finish.
