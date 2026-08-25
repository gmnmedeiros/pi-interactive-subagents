/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls (haiku by default).
 * Each test creates a Herdr pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Costs: ~$0.01-0.05 per test run (haiku).
 * Duration: ~30-90s per test.
 *
 * Set PI_RUN_HERDR_INTEGRATION=1 and PI_RUN_LLM_INTEGRATION=1 to enable these tests inside Herdr.
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: anthropic/claude-haiku-4-5)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurfaceSplit,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  PI_TIMEOUT,
  TEST_MODEL,
  type TestEnv,
} from "./harness.ts";

const shouldRunLlmIntegration: boolean =
  process.env.PI_RUN_HERDR_INTEGRATION === "1" &&
  process.env.PI_RUN_LLM_INTEGRATION === "1";
const backends: string[] = shouldRunLlmIntegration ? getAvailableBackends() : [];

if (backends.length === 0) {
  console.log(
    "LLM integration tests are disabled — set PI_RUN_HERDR_INTEGRATION=1 and PI_RUN_LLM_INTEGRATION=1 inside Herdr",
  );
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurfaceSplit(env, `echo-${id}`, "down");

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run this bash command: sleep 5; echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const widgetScreen = await waitForScreen(surface, /Subagents[\s\S]*Echo-/i, PI_TIMEOUT, 300);
      assert.match(widgetScreen, /Subagents/i, "Original widget should show the running subagent");

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    it("resumes a completed subagent with its saved sandbox", async () => {
      const id = uniqueId();
      const firstFile = `/tmp/pi-integ-resume-first-${id}.txt`;
      const secondFile = `/tmp/pi-integ-resume-second-${id}.txt`;
      const surface = createTrackedSurfaceSplit(env, `resume-${id}`, "down");
      const task = [
        `First call subagent with these EXACT parameters:`,
        `  name: "Resume-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run: echo 'FIRST_${id}' > '${firstFile}'"`,
        `Wait for its completed result.`,
        `Then call subagent_message with name Resume-${id} and message: Run echo 'SECOND_${id}' > '${secondFile}'.`,
        `After the resumed result arrives, say RESUME_INTEGRATION_COMPLETE.`,
      ].join("\n");

      trackTempFile(env, firstFile);
      trackTempFile(env, secondFile);
      startPi(surface, env.dir, task);

      assert.match(await waitForFile(firstFile, PI_TIMEOUT, /FIRST_/), new RegExp(id));
      assert.match(await waitForFile(secondFile, PI_TIMEOUT, /SECOND_/), new RegExp(id));
      assert.match(
        await waitForScreen(surface, /RESUME_INTEGRATION_COMPLETE|Resume-.*completed/i, PI_TIMEOUT, 300),
        /RESUME_INTEGRATION_COMPLETE|completed/i,
      );
    });

    it("runs a permitted nested subagent in the same tab", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-nested-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-nested-${id}.txt`;
      const surface = createTrackedSurfaceSplit(env, `nested-${id}`, "down");
      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Delegator-${id}"`,
        `  agent: "test-delegator"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Call subagent with agent test-echo, name Nested-${id}, model ${TEST_MODEL}, and task: Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 5; echo 'NESTED_PASS_${id}' > '${markerFile}'. Wait for its result, then finish."`,
        `Do not do anything else before calling the delegator.`,
        `After the delegator result arrives, say NESTED_INTEGRATION_COMPLETE.`,
      ].join("\n");

      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);
      startPi(surface, env.dir, task);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.ok(getLayoutPaneIds(surface).length >= 4, "nested child should stay in the parent tab");
      assert.match(await waitForFile(markerFile, PI_TIMEOUT, /NESTED_PASS_/), new RegExp(id));
      assert.match(
        await waitForScreen(surface, /NESTED_INTEGRATION_COMPLETE|Delegator-.*completed/i, PI_TIMEOUT, 300),
        /NESTED_INTEGRATION_COMPLETE|completed/i,
      );
    });

    it("delivers a question and steers the answer back to the child", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-question-${id}.txt`;
      const surface = createTrackedSurfaceSplit(env, `question-${id}`, "down");
      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Question-${id}"`,
        `  agent: "test-question"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Call ask_question once with the question TOKEN_${id}. After the answer arrives, run: echo 'QUESTION_PASS_${id}' > '${markerFile}'. Then finish."`,
        `When Question-${id} asks its question, call subagent_message with name Question-${id} and message ANSWER_${id}.`,
        `After its final result arrives, say QUESTION_INTEGRATION_COMPLETE.`,
      ].join("\n");

      trackTempFile(env, markerFile);
      startPi(surface, env.dir, task);

      assert.match(
        await waitForScreen(surface, /Question-.*asks|TOKEN_/i, PI_TIMEOUT, 300),
        /asks|TOKEN_/i,
      );
      assert.match(await waitForFile(markerFile, PI_TIMEOUT, /QUESTION_PASS_/), new RegExp(id));
      assert.match(
        await waitForScreen(surface, /QUESTION_INTEGRATION_COMPLETE|Question-.*completed/i, PI_TIMEOUT, 300),
        /QUESTION_INTEGRATION_COMPLETE|completed/i,
      );
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurfaceSplit(env, `status-${id}`, "down");

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const startA = `/tmp/pi-integ-para-${id}-start-a.txt`;
      const startB = `/tmp/pi-integ-para-${id}-start-b.txt`;
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, startA);
      trackTempFile(env, startB);
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurfaceSplit(env, `parallel-${id}`, "down");

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run: echo 'START_A_${id}' > '${startA}'; sleep 5; echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run: echo 'START_B_${id}' > '${startB}'; sleep 5; echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      await Promise.all([
        waitForFile(startA, PI_TIMEOUT, /START_A/),
        waitForFile(startB, PI_TIMEOUT, /START_B/),
      ]);
      assert.ok(getLayoutPaneIds(surface).length >= 4, "parallel children should share the parent tab");

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurfaceSplit(env, `discovery-${id}`, "down");

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  model: "${TEST_MODEL}"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });
  });
}

function getLayoutPaneIds(surface: string): string[] {
  const output: string = execFileSync(
    process.env.HERDR_BIN_PATH ?? "herdr",
    ["pane", "layout", "--pane", surface],
    { encoding: "utf8" },
  );
  const response = JSON.parse(output) as {
    result?: { layout?: { panes?: Array<{ pane_id?: string }> } };
  };

  return response.result?.layout?.panes
    ?.map((pane) => pane.pane_id)
    .filter((paneId): paneId is string => typeof paneId === "string") ?? [];
}
