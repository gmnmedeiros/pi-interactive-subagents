import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";
const RAW_SURFACE_TIMEOUT_MS = Number(process.env.PI_HERDR_RAW_TIMEOUT_MS ?? "10000");
const IS_HERDR_AVAILABLE = isHerdrAvailable();

interface HerdrPane {
  focused?: boolean;
  pane_id: string;
}

interface HerdrPaneResponse {
  result?: {
    pane?: HerdrPane;
  };
}

function isHerdrAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;

  try {
    execFileSync(HERDR_BIN, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runHerdr(args: string[]): string {
  return execFileSync(HERDR_BIN, args, { encoding: "utf8" });
}

function parsePane(output: string): HerdrPane {
  const response: HerdrPaneResponse = JSON.parse(output) as HerdrPaneResponse;
  const pane: HerdrPane | undefined = response.result?.pane;

  if (!pane?.pane_id) throw new Error(`Herdr returned no pane ID: ${output}`);
  return pane;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitForFile(path: string): Promise<string> {
  const startedAt: number = Date.now();

  while (Date.now() - startedAt < RAW_SURFACE_TIMEOUT_MS) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for file: ${path}`);
}

async function waitForPaneOutput(paneId: string, marker: string): Promise<string> {
  const startedAt: number = Date.now();
  let output: string = "";

  while (Date.now() - startedAt < RAW_SURFACE_TIMEOUT_MS) {
    output = runHerdr([
      "pane",
      "read",
      paneId,
      "--source",
      "recent-unwrapped",
      "--lines",
      "50",
    ]);
    if (output.includes(marker)) return output;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${marker} in pane ${paneId}. Last output:\n${output}`);
}

if (!IS_HERDR_AVAILABLE) {
  console.log("Herdr is not available — skipping raw Herdr surface integration tests");
}

if (IS_HERDR_AVAILABLE) {
  describe("raw Herdr pane surface", { timeout: 30_000 }, () => {
    it("starts without focus, exposes output and lifecycle files, and closes safely", async () => {
      const testDir: string = mkdtempSync(join(tmpdir(), "pi-herdr-raw-"));
      const startedFile: string = join(testDir, "started");
      const processExitFile: string = join(testDir, "process-exit");
      const launchScript: string = join(testDir, "launch.sh");
      const token: string = `${process.pid}-${Date.now()}`;
      const marker: string = `HERDR_RAW_MARKER_${token}`;
      let paneId: string | null = null;

      writeFileSync(
        launchScript,
        [
          "#!/bin/bash",
          `printf '%s\\n' ${shellEscape(token)} > ${shellEscape(startedFile)}`,
          `printf '%s\\n' ${shellEscape(marker)}`,
          "process_exit=$?",
          `printf '%s\\n' "$process_exit" > ${shellEscape(processExitFile)}`,
          "exit \"$process_exit\"",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const createdPane: HerdrPane = parsePane(
          runHerdr([
            "pane",
            "split",
            "--current",
            "--direction",
            "right",
            "--ratio",
            "0.5",
            "--cwd",
            testDir,
            "--no-focus",
          ]),
        );
        paneId = createdPane.pane_id;

        const paneAfterCreation: HerdrPane = parsePane(runHerdr(["pane", "get", paneId]));
        assert.equal(paneAfterCreation.focused, false, "new pane must not take focus");

        runHerdr(["pane", "run", paneId, `bash ${shellEscape(launchScript)}`]);

        assert.equal((await waitForFile(startedFile)).trim(), token);
        assert.equal((await waitForFile(processExitFile)).trim(), "0");
        assert.match(await waitForPaneOutput(paneId, marker), new RegExp(marker));
      } finally {
        if (paneId) {
          try {
            runHerdr(["pane", "close", paneId]);
          } catch {}
        }
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
}
