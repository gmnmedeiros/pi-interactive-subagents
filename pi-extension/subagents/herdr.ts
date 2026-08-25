import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERDR_BIN = process.env.HERDR_BIN_PATH?.trim() || "herdr";
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_START_INTERVAL_MS = 50;
const createdSurfaces = new Set<string>();
let isHerdrCommandAvailable: boolean | null = null;

interface HerdrPaneResponse {
  result?: {
    pane?: {
      pane_id?: string;
    };
  };
}

export interface PollResult {
  reason: "done" | "error" | "process-exit" | "sentinel";
  exitCode: number;
  errorMessage?: string;
}

export function isHerdrAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;
  if (isHerdrCommandAvailable !== null) return isHerdrCommandAvailable;

  try {
    execFileSync(HERDR_BIN, ["--version"], { stdio: "ignore" });
    isHerdrCommandAvailable = true;
  } catch {
    isHerdrCommandAvailable = false;
  }

  return isHerdrCommandAvailable;
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside Herdr.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

function runHerdr(args: string[]): string {
  requireHerdr();
  return execFileSync(HERDR_BIN, args, { encoding: "utf8" });
}

function parsePaneId(output: string): string {
  let response: HerdrPaneResponse;
  let paneId: string | undefined;

  try {
    response = JSON.parse(output) as HerdrPaneResponse;
  } catch {
    throw new Error(`Herdr returned malformed JSON while creating a pane: ${output}`);
  }

  paneId = response.result?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr returned no pane ID: ${output}`);
  return paneId;
}

function isSurfaceAvailable(surface: string): boolean {
  try {
    runHerdr(["pane", "get", surface]);
    return true;
  } catch {
    return false;
  }
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right");
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const args: string[] = ["pane", "split"];
  let output: string;
  let paneId: string;

  void name;
  requireHerdr();
  if (direction !== "right" && direction !== "down") {
    throw new Error(`Herdr only supports right and down pane splits, not ${direction}`);
  }

  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }
  args.push(
    "--direction",
    direction,
    "--ratio",
    "0.5",
    "--cwd",
    process.cwd(),
    "--no-focus",
  );

  try {
    output = runHerdr(args);
  } catch (error) {
    throw new Error(
      "Failed to create a Herdr pane from the current caller. Start pi inside a Herdr pane.",
      { cause: error },
    );
  }

  paneId = parsePaneId(output);
  createdSurfaces.add(paneId);
  return paneId;
}

export function sendCommand(surface: string, command: string): void {
  runHerdr(["pane", "run", surface, command]);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath: string =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  const scriptParts: string[] = ["#!/bin/bash"];

  mkdirSync(dirname(scriptPath), { recursive: true });
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, `${scriptParts.join("\n")}\n`, { mode: 0o755 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export async function waitForStart(
  startedFile: string,
  options?: { interval?: number; signal?: AbortSignal; timeout?: number },
): Promise<void> {
  const interval: number = options?.interval ?? DEFAULT_START_INTERVAL_MS;
  const timeout: number = options?.timeout ?? DEFAULT_START_TIMEOUT_MS;
  const startedAt: number = Date.now();

  while (Date.now() - startedAt < timeout) {
    if (options?.signal?.aborted) throw new Error("Aborted while waiting for subagent startup");
    if (existsSync(startedFile)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Subagent did not write its startup signal within ${timeout}ms: ${startedFile}`);
}

export function readScreen(surface: string, lines = 50): string {
  return runHerdr([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  let stdout: string;

  requireHerdr();
  ({ stdout } = await execFileAsync(
    HERDR_BIN,
    [
      "pane",
      "read",
      surface,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(Math.max(1, lines)),
    ],
    { encoding: "utf8" },
  ));
  return stdout;
}

export function closeSurface(surface: string): void {
  if (!createdSurfaces.has(surface)) {
    throw new Error(`Refusing to close pane not created by this extension: ${surface}`);
  }
  if (!isSurfaceAvailable(surface)) {
    createdSurfaces.delete(surface);
    return;
  }

  try {
    runHerdr(["pane", "close", surface]);
  } catch (error) {
    if (isSurfaceAvailable(surface)) throw error;
  } finally {
    createdSurfaces.delete(surface);
  }
}

function interpretExitSidecar(data: unknown): PollResult {
  const payload = data as { errorMessage?: unknown; type?: unknown } | null;
  const errorMessage: string =
    typeof payload?.errorMessage === "string" && payload.errorMessage.trim() !== ""
      ? payload.errorMessage
      : "Subagent exited with stopReason=error (no errorMessage in sidecar).";

  if (payload?.type === "error") return { reason: "error", exitCode: 1, errorMessage };
  return { reason: "done", exitCode: 0 };
}

function readProcessExitCode(processExitFile?: string): number | null {
  let value: string;
  let exitCode: number;

  if (!processExitFile || !existsSync(processExitFile)) return null;
  value = readFileSync(processExitFile, "utf8").trim();
  if (!/^-?\d+$/.test(value)) return null;
  exitCode = Number(value);
  return Number.isSafeInteger(exitCode) ? exitCode : null;
}

function readExitSidecar(sessionFile?: string): PollResult | null {
  const exitFile: string | undefined = sessionFile ? `${sessionFile}.exit` : undefined;
  let data: unknown;

  if (!exitFile || !existsSync(exitFile)) return null;

  try {
    data = JSON.parse(readFileSync(exitFile, "utf8")) as unknown;
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

export const __pollForExitTest__ = {
  interpretExitSidecar,
  parsePaneId,
  readProcessExitCode,
};

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    onTick?: (elapsed: number) => void;
    processExitFile?: string;
    sentinelFile?: string;
    sessionFile?: string;
  },
): Promise<PollResult> {
  const startedAt: number = Date.now();

  for (;;) {
    const sidecarResult: PollResult | null = readExitSidecar(options.sessionFile);
    const processExitCode: number | null = readProcessExitCode(options.processExitFile);

    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");
    if (sidecarResult) return sidecarResult;
    if (processExitCode !== null) {
      return { reason: "process-exit", exitCode: processExitCode };
    }
    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const screen: string = await readScreenAsync(surface, 5);
      const match: RegExpMatchArray | null = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: Number(match[1]) };
    } catch {
      const finalSidecarResult: PollResult | null = readExitSidecar(options.sessionFile);
      const finalProcessExitCode: number | null = readProcessExitCode(options.processExitFile);

      if (finalSidecarResult) return finalSidecarResult;
      if (finalProcessExitCode !== null) {
        return { reason: "process-exit", exitCode: finalProcessExitCode };
      }
      if (!isSurfaceAvailable(surface)) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent pane closed before the process wrote its exit signal.",
        };
      }
    }

    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await new Promise<void>((resolve, reject) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);

      function onAbort(): void {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }

      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
