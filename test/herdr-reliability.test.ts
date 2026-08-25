import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

interface FakeHerdr {
  binPath: string;
  countFile: string;
  logFile: string;
  root: string;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createFakeHerdr(executeAttempt: number): FakeHerdr {
  const root: string = mkdtempSync(join(tmpdir(), "pi-fake-herdr-"));
  const binPath: string = join(root, "herdr");
  const countFile: string = join(root, "split-count");
  const logFile: string = join(root, "calls.log");
  const script: string = [
    "#!/bin/sh",
    "set -eu",
    `count_file=${shellEscape(countFile)}`,
    `log_file=${shellEscape(logFile)}`,
    `execute_attempt=${executeAttempt}`,
    "printf '%s\\n' \"$*\" >> \"$log_file\"",
    "if [ \"${1:-}\" = \"--version\" ]; then printf 'herdr-test\\n'; exit 0; fi",
    "if [ \"${1:-}\" != \"pane\" ]; then exit 1; fi",
    "case \"${2:-}\" in",
    "  current)",
    "    printf '{\"result\":{\"pane\":{\"pane_id\":\"wtest:p0\"}}}\\n'",
    "    ;;",
    "  split)",
    "    count=0",
    "    if [ -f \"$count_file\" ]; then count=$(cat \"$count_file\"); fi",
    "    count=$((count + 1))",
    "    printf '%s\\n' \"$count\" > \"$count_file\"",
    "    printf '{\"result\":{\"pane\":{\"pane_id\":\"wtest:p%s\"}}}\\n' \"$count\"",
    "    ;;",
    "  process-info)",
    "    printf '{\"result\":{\"process_info\":{\"foreground_process_group_id\":100,\"shell_pid\":100}}}\\n'",
    "    ;;",
    "  run)",
    "    attempt=${3##*:p}",
    "    if [ \"$attempt\" -ge \"$execute_attempt\" ]; then /bin/sh -c \"$4\"; fi",
    "    ;;",
    "  get)",
    "    printf '{\"result\":{\"pane\":{\"pane_id\":\"%s\"}}}\\n' \"$3\"",
    "    ;;",
    "  close)",
    "    ;;",
    "  *)",
    "    exit 1",
    "    ;;",
    "esac",
    "",
  ].join("\n");

  writeFileSync(binPath, script, { mode: 0o755 });
  return { binPath, countFile, logFile, root };
}

async function importHerdr(fake: FakeHerdr): Promise<typeof import("../pi-extension/subagents/herdr.ts")> {
  process.env.HERDR_BIN_PATH = fake.binPath;
  process.env.HERDR_ENV = "1";
  process.env.PI_SUBAGENT_SURFACE_READY_TIMEOUT_MS = "20";
  process.env.PI_SUBAGENT_SURFACE_READY_ATTEMPTS = "2";
  return import(`../pi-extension/subagents/herdr.ts?reliability=${Date.now()}-${Math.random()}`);
}

function restoreEnvironment(originalEnvironment: NodeJS.ProcessEnv): void {
  for (const name of [
    "HERDR_BIN_PATH",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_SURFACE_READY_ATTEMPTS",
    "PI_SUBAGENT_SURFACE_READY_TIMEOUT_MS",
  ]) {
    const value: string | undefined = originalEnvironment[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

describe("Herdr startup reliability", () => {
  it("targets the inherited caller pane explicitly", async () => {
    const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };
    const fake: FakeHerdr = createFakeHerdr(1);

    process.env.HERDR_PANE_ID = "wtest:parent";
    try {
      const herdr = await importHerdr(fake);
      const surface: string = herdr.createSurface("explicit-parent");
      const calls: string = readFileSync(fake.logFile, "utf8");

      assert.match(calls, /pane split --pane wtest:parent/);
      assert.doesNotMatch(calls, /pane split --current/);
      herdr.closeSurface(surface);
    } finally {
      restoreEnvironment(originalEnvironment);
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  it("closes an unready pane and succeeds on a fresh pane", async () => {
    const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };
    const fake: FakeHerdr = createFakeHerdr(2);

    delete process.env.HERDR_PANE_ID;
    try {
      const herdr = await importHerdr(fake);
      const surface: string = await herdr.createReadySurface("retry-ready");
      const calls: string = readFileSync(fake.logFile, "utf8");

      assert.equal(surface, "wtest:p2");
      assert.match(calls, /pane current --current/);
      assert.match(calls, /pane close wtest:p1/);
      assert.equal(readFileSync(fake.countFile, "utf8").trim(), "2");
      herdr.closeSurface(surface);
    } finally {
      restoreEnvironment(originalEnvironment);
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  it("balances later children down the right-side column", async () => {
    const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };
    const fake: FakeHerdr = createFakeHerdr(1);

    delete process.env.HERDR_PANE_ID;
    delete process.env.PI_SUBAGENT_ID;
    try {
      const herdr = await importHerdr(fake);
      const surfaces: string[] = [];

      surfaces.push(await herdr.createReadySurface("column-1"));
      surfaces.push(await herdr.createReadySurface("column-2"));
      surfaces.push(await herdr.createReadySurface("column-3"));
      surfaces.push(await herdr.createReadySurface("column-4"));
      const splitCalls: string[] = readFileSync(fake.logFile, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("pane split"));

      assert.match(splitCalls[0], /--pane wtest:p0 --direction right/);
      assert.match(splitCalls[1], /--pane wtest:p1 --direction down/);
      assert.match(splitCalls[2], /--pane wtest:p1 --direction down/);
      assert.match(splitCalls[3], /--pane wtest:p2 --direction down/);
      for (const surface of surfaces) herdr.closeSurface(surface);
    } finally {
      restoreEnvironment(originalEnvironment);
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  it("places the first nested child below its caller", async () => {
    const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };
    const fake: FakeHerdr = createFakeHerdr(1);

    delete process.env.HERDR_PANE_ID;
    process.env.PI_SUBAGENT_ID = "nested-parent";
    try {
      const herdr = await importHerdr(fake);
      const surface: string = await herdr.createReadySurface("nested-child");
      const calls: string = readFileSync(fake.logFile, "utf8");

      assert.match(calls, /pane split --pane wtest:p0 --direction down/);
      herdr.closeSurface(surface);
    } finally {
      restoreEnvironment(originalEnvironment);
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  it("rebalances its layout model after children close out of order", async () => {
    const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };
    const fake: FakeHerdr = createFakeHerdr(1);

    delete process.env.HERDR_PANE_ID;
    delete process.env.PI_SUBAGENT_ID;
    try {
      const herdr = await importHerdr(fake);
      const surfaces: string[] = [];

      for (let index = 1; index <= 4; index += 1) {
        surfaces.push(await herdr.createReadySurface(`close-${index}`));
      }
      herdr.closeSurface(surfaces[2]);
      const replacementSurface: string = await herdr.createReadySurface("replacement");
      const splitCalls: string[] = readFileSync(fake.logFile, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("pane split"));

      assert.match(splitCalls[4], /--pane wtest:p1 --direction down/);
      for (const surface of [surfaces[0], surfaces[1], surfaces[3], replacementSurface]) {
        herdr.closeSurface(surface);
      }
    } finally {
      restoreEnvironment(originalEnvironment);
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  it("fails after bounded bootstrap attempts and closes every pane", async () => {
    const originalEnvironment: NodeJS.ProcessEnv = { ...process.env };
    const fake: FakeHerdr = createFakeHerdr(99);

    delete process.env.HERDR_PANE_ID;
    try {
      const herdr = await importHerdr(fake);
      await assert.rejects(
        herdr.createReadySurface("never-ready"),
        /did not provide a command-ready shell after 2 attempts/,
      );
      const calls: string = readFileSync(fake.logFile, "utf8");

      assert.match(calls, /pane close wtest:p1/);
      assert.match(calls, /pane close wtest:p2/);
      assert.equal(readFileSync(fake.countFile, "utf8").trim(), "2");
    } finally {
      restoreEnvironment(originalEnvironment);
      rmSync(fake.root, { recursive: true, force: true });
    }
  });
});
