import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
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

const backends: string[] = process.env.PI_RUN_HERDR_INTEGRATION === "1"
  ? getAvailableBackends()
  : [];
const HERDR_BIN: string = process.env.HERDR_BIN_PATH ?? "herdr";

interface HerdrLayout {
  panes: Array<{
    focused?: boolean;
    pane_id: string;
    rect: { height: number; width: number; x: number; y: number };
  }>;
  tab_id: string;
  zoomed: boolean;
}

if (backends.length === 0) {
  console.log("Herdr surface tests are disabled — set PI_RUN_HERDR_INTEGRATION=1 inside Herdr");
}

for (const backend of backends) {
  describe(`Herdr surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    it("creates an unfocused surface from the caller", async () => {
      const focusedBefore: string | null = getFocusedSurface();
      const surface: string = createTrackedSurface(env, "focus-test");

      await sleep(100);
      assert.equal(getFocusedSurface(), focusedBefore);
      assert.equal(getPaneFocus(surface), false);
    });

    it("keeps the parent width stable while balancing the right column", () => {
      const parentSurface: string = getCurrentPaneId();
      const firstSurface: string = createTrackedSurface(env, "column-1");
      const firstLayout: HerdrLayout = getPaneLayout(parentSurface);
      const parentWidthAfterFirst: number = getPaneRect(firstLayout, parentSurface).width;
      const childSurfaces: string[] = [
        firstSurface,
        createTrackedSurface(env, "column-2"),
        createTrackedSurface(env, "column-3"),
        createTrackedSurface(env, "column-4"),
      ];
      const finalLayout: HerdrLayout = getPaneLayout(parentSurface);
      const childRects = childSurfaces.map((surface) => getPaneRect(finalLayout, surface));
      const childHeights: number[] = childRects.map((rect) => rect.height);

      assert.equal(getPaneRect(finalLayout, parentSurface).width, parentWidthAfterFirst);
      assert.equal(new Set(childRects.map((rect) => rect.x)).size, 1);
      assert.equal(new Set(childRects.map((rect) => rect.width)).size, 1);
      assert.ok(Math.max(...childHeights) - Math.min(...childHeights) <= 1);
      assert.ok(childSurfaces.every((surface) => getPaneFocus(surface) === false));
    });

    it("uses a down split for a nested subagent", async () => {
      const originalSubagentId: string | undefined = process.env.PI_SUBAGENT_ID;
      const parentSurface: string = getCurrentPaneId();
      const parentRectBefore = getPaneRect(getPaneLayout(parentSurface), parentSurface);
      let nestedSurface: string | null = null;

      process.env.PI_SUBAGENT_ID = "nested-layout-test";
      try {
        const herdr = await import(`../../pi-extension/subagents/herdr.ts?nested=${Date.now()}`);
        nestedSurface = herdr.createSurface("nested-child");
        assert.ok(nestedSurface);
        const layoutAfter: HerdrLayout = getPaneLayout(parentSurface);
        const parentRectAfter = getPaneRect(layoutAfter, parentSurface);
        const childRect = getPaneRect(layoutAfter, nestedSurface);

        assert.equal(parentRectAfter.width, parentRectBefore.width);
        assert.equal(childRect.width, parentRectBefore.width);
        assert.ok(parentRectAfter.height < parentRectBefore.height);
        assert.ok(childRect.height < parentRectBefore.height);
        herdr.closeSurface(nestedSurface);
        nestedSurface = null;
      } finally {
        if (nestedSurface) execFileSync(HERDR_BIN, ["pane", "close", nestedSurface]);
        restoreEnvVar("PI_SUBAGENT_ID", originalSubagentId);
      }
    });

    it("preserves output through zoom and unzoom", async () => {
      const firstSurface: string = createTrackedSurface(env, "zoom-1");
      const secondSurface: string = createTrackedSurface(env, "zoom-2");
      const firstMarker: string = `ZOOM_FIRST_${uniqueId()}`;
      const secondMarker: string = `ZOOM_SECOND_${uniqueId()}`;

      sendCommand(firstSurface, `printf '%s\\n' ${shellEscape(firstMarker)}`);
      sendCommand(secondSurface, `printf '%s\\n' ${shellEscape(secondMarker)}`);
      await Promise.all([
        waitForScreen(firstSurface, new RegExp(firstMarker), 10_000, 50),
        waitForScreen(secondSurface, new RegExp(secondMarker), 10_000, 50),
      ]);

      execFileSync(HERDR_BIN, ["pane", "zoom", "--pane", secondSurface, "--on"]);
      assert.equal(getPaneLayout(secondSurface).zoomed, true);
      assert.match(readScreen(firstSurface, 50), new RegExp(firstMarker));
      assert.match(readScreen(secondSurface, 50), new RegExp(secondMarker));

      execFileSync(HERDR_BIN, ["pane", "zoom", "--pane", secondSurface, "--off"]);
      assert.equal(getPaneLayout(secondSurface).zoomed, false);
      assert.match(readScreen(firstSurface, 50), new RegExp(firstMarker));
      assert.match(readScreen(secondSurface, 50), new RegExp(secondMarker));
    });

    it("closes children in any order without closing the parent", () => {
      const parentSurface: string = getCurrentPaneId();
      const surfaces: string[] = [
        createTrackedSurface(env, "close-1"),
        createTrackedSurface(env, "close-2"),
        createTrackedSurface(env, "close-3"),
        createTrackedSurface(env, "close-4"),
      ];
      const closeOrder: string[] = [surfaces[1], surfaces[0], surfaces[3], surfaces[2]];

      for (const surface of closeOrder) {
        closeSurface(surface);
        untrackSurface(env, surface);
      }

      assert.equal(getPaneLayout(parentSurface).panes.some((pane) => pane.pane_id === parentSurface), true);
      assert.throws(() => closeSurface(parentSurface), /Refusing to close pane/);
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

function getCurrentPaneId(): string {
  const output: string = execFileSync(HERDR_BIN, ["pane", "current"], { encoding: "utf8" });
  const response = JSON.parse(output) as { result?: { pane?: { pane_id?: string } } };
  const paneId: string | undefined = response.result?.pane?.pane_id;

  if (!paneId) throw new Error(`Herdr returned no current pane: ${output}`);
  return paneId;
}

function getPaneLayout(surface: string): HerdrLayout {
  const output: string = execFileSync(
    HERDR_BIN,
    ["pane", "layout", "--pane", surface],
    { encoding: "utf8" },
  );
  const response = JSON.parse(output) as { result?: { layout?: HerdrLayout } };
  const layout: HerdrLayout | undefined = response.result?.layout;

  if (!layout) throw new Error(`Herdr returned no layout for pane ${surface}: ${output}`);
  return layout;
}

function getPaneRect(
  layout: HerdrLayout,
  surface: string,
): { height: number; width: number; x: number; y: number } {
  const rect = layout.panes.find((pane) => pane.pane_id === surface)?.rect;

  if (!rect) throw new Error(`Pane ${surface} is absent from layout ${layout.tab_id}`);
  return rect;
}

function getPaneFocus(surface: string): boolean | undefined {
  const output: string = execFileSync(HERDR_BIN, ["pane", "get", surface], { encoding: "utf8" });
  const response = JSON.parse(output) as { result?: { pane?: { focused?: boolean } } };

  return response.result?.pane?.focused;
}

function restoreEnvVar(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}

function restoreHerdrBinPath(originalBinPath: string | undefined): void {
  if (originalBinPath === undefined) {
    delete process.env.HERDR_BIN_PATH;
  } else {
    process.env.HERDR_BIN_PATH = originalBinPath;
  }
}
