import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  cleanupTestEnv,
  closeSurface,
  createTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  getAvailableBackends,
  getFocusedSurface,
  pollForExit,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendLongCommand,
  shellEscape,
  sleep,
  trackTempFile,
  uniqueId,
  untrackSurface,
  waitForFile,
  waitForScreen,
  waitForStart,
  type TestEnv,
} from "./harness.ts";

const backends: string[] = getAvailableBackends();
const HERDR_BIN: string = process.env.HERDR_BIN_PATH ?? "herdr";

if (backends.length === 0) {
  console.log("Herdr is not available — skipping Herdr surface integration tests");
}

for (const backend of backends) {
  describe(`Herdr surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("creates an unfocused surface from the caller", async () => {
      const focusedBefore: string | null = getFocusedSurface();
      const surface: string = createTrackedSurface(env, "focus-test");

      await sleep(100);
      assert.equal(getFocusedSurface(), focusedBefore);
      assert.equal(getPaneFocus(surface), false);
    });

    it("sends a command, reads output, and closes the child", async () => {
      const surface: string = createTrackedSurface(env, "echo-test");
      const marker: string = `MARKER_${uniqueId()}`;

      sendCommand(surface, `printf '%s\\n' ${shellEscape(marker)}`);
      assert.match(await waitForScreen(surface, new RegExp(marker), 10_000, 50), new RegExp(marker));

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters", async () => {
      const surface: string = createTrackedSurface(env, "escape-test");
      const marker: string = uniqueId();

      sendCommand(surface, `printf '%s\\n' 'SPEC_${marker}_$HOME_"quotes"_done'`);
      assert.match(await waitForScreen(surface, new RegExp(`SPEC_${marker}`), 10_000, 50), /\$HOME/);
    });

    it("sends a long command through a script", async () => {
      const surface: string = createTrackedSurface(env, "long-command-test");
      const marker: string = uniqueId();
      const command: string = `printf '%s\\n' 'LONG_${marker}_${"X".repeat(500)}_END'`;

      sendLongCommand(surface, command);
      const output: string = await waitForScreen(surface, new RegExp(`LONG_${marker}`), 10_000, 50);
      assert.match(output, /_END/);
    });

    it("reads output asynchronously", async () => {
      const surface: string = createTrackedSurface(env, "async-read-test");
      const marker: string = `ASYNC_${uniqueId()}`;

      sendCommand(surface, `printf '%s\\n' ${shellEscape(marker)}`);
      await waitForScreen(surface, new RegExp(marker), 10_000, 50);
      assert.match(await readScreenAsync(surface, 50), new RegExp(marker));
    });

    it("supports right and down splits", async () => {
      const rightSurface: string = createTrackedSurfaceSplit(env, "right-test", "right");
      const downSurface: string = createTrackedSurfaceSplit(env, "down-test", "down", rightSurface);
      const rightMarker: string = `RIGHT_${uniqueId()}`;
      const downMarker: string = `DOWN_${uniqueId()}`;

      sendCommand(rightSurface, `printf '%s\\n' ${shellEscape(rightMarker)}`);
      sendCommand(downSurface, `printf '%s\\n' ${shellEscape(downMarker)}`);
      await Promise.all([
        waitForScreen(rightSurface, new RegExp(rightMarker), 10_000, 50),
        waitForScreen(downSurface, new RegExp(downMarker), 10_000, 50),
      ]);
    });

    it("rejects unsupported split directions", () => {
      assert.throws(
        () => createTrackedSurfaceSplit(env, "left-test", "left"),
        /only supports right and down/,
      );
    });

    it("uses started and process-exit files as causal signals", async () => {
      const surface: string = createTrackedSurface(env, "supervision-test");
      const token: string = uniqueId();
      const startedFile: string = `${env.dir}/supervision-${token}.started`;
      const processExitFile: string = `${env.dir}/supervision-${token}.process-exit`;
      const scriptPath: string = `${env.dir}/supervision-${token}.sh`;
      const command: string = [
        `printf '%s\\n' 'started' > ${shellEscape(startedFile)}`,
        `printf '%s\\n' 'SUPERVISED_${token}'`,
        "process_exit=$?",
        `printf '%s\\n' "$process_exit" > ${shellEscape(processExitFile)}`,
        "exit \"$process_exit\"",
      ].join("\n");

      trackTempFile(env, startedFile);
      trackTempFile(env, processExitFile);
      trackTempFile(env, scriptPath);
      sendLongCommand(surface, command, { scriptPath });
      await waitForStart(startedFile);

      assert.equal((await waitForFile(startedFile, 10_000)).trim(), "started");
      assert.deepEqual(
        await pollForExit(surface, new AbortController().signal, {
          interval: 50,
          processExitFile,
        }),
        { reason: "process-exit", exitCode: 0 },
      );
      assert.match(readScreen(surface, 50), new RegExp(`SUPERVISED_${token}`));
    });

    it("reports manual pane termination", async () => {
      const surface: string = createTrackedSurface(env, "manual-close-test");

      execFileSync(HERDR_BIN, ["pane", "close", surface], { encoding: "utf8" });
      const result = await pollForExit(surface, new AbortController().signal, { interval: 50 });

      assert.equal(result.reason, "error");
      assert.equal(result.exitCode, 1);
      assert.match(result.errorMessage ?? "", /pane closed before/);
      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("refuses to close panes it did not create", () => {
      assert.throws(() => closeSurface("not-a-created-pane"), /Refusing to close pane/);
    });

    it("times out when no startup signal appears", async () => {
      await assert.rejects(
        waitForStart(`${env.dir}/missing-started-file`, { interval: 5, timeout: 20 }),
        /did not write its startup signal/,
      );
    });

    it("reports a missing Herdr executable", async () => {
      const originalBinPath: string | undefined = process.env.HERDR_BIN_PATH;
      const missingBinPath: string = `${env.dir}/missing-herdr`;

      process.env.HERDR_BIN_PATH = missingBinPath;
      try {
        const herdr = await import(`../../pi-extension/subagents/herdr.ts?missing=${Date.now()}`);
        assert.equal(herdr.isMuxAvailable(), false);
        assert.throws(() => herdr.createSurface("missing"), /Herdr is required/);
      } finally {
        restoreHerdrBinPath(originalBinPath);
      }
    });

    it("reports malformed pane creation output", async () => {
      const originalBinPath: string | undefined = process.env.HERDR_BIN_PATH;
      const fakeBinPath: string = `${env.dir}/malformed-herdr`;

      writeFileSync(
        fakeBinPath,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nprintf 'not-json'\n",
        { mode: 0o755 },
      );
      process.env.HERDR_BIN_PATH = fakeBinPath;
      try {
        const herdr = await import(`../../pi-extension/subagents/herdr.ts?malformed=${Date.now()}`);
        assert.throws(() => herdr.createSurface("malformed"), /malformed JSON/);
      } finally {
        restoreHerdrBinPath(originalBinPath);
      }
    });

    it("reports missing inherited caller context", async () => {
      const originalBinPath: string | undefined = process.env.HERDR_BIN_PATH;
      const fakeBinPath: string = `${env.dir}/no-caller-herdr`;

      writeFileSync(
        fakeBinPath,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nexit 1\n",
        { mode: 0o755 },
      );
      process.env.HERDR_BIN_PATH = fakeBinPath;
      try {
        const herdr = await import(`../../pi-extension/subagents/herdr.ts?caller=${Date.now()}`);
        assert.throws(() => herdr.createSurface("no-caller"), /current caller/);
      } finally {
        restoreHerdrBinPath(originalBinPath);
      }
    });
  });
}

function getPaneFocus(surface: string): boolean | undefined {
  const output: string = execFileSync(HERDR_BIN, ["pane", "get", surface], { encoding: "utf8" });
  const response = JSON.parse(output) as { result?: { pane?: { focused?: boolean } } };

  return response.result?.pane?.focused;
}

function restoreHerdrBinPath(originalBinPath: string | undefined): void {
  if (originalBinPath === undefined) {
    delete process.env.HERDR_BIN_PATH;
  } else {
    process.env.HERDR_BIN_PATH = originalBinPath;
  }
}
