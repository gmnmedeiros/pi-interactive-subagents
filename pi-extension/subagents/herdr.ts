import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERDR_BIN = process.env.HERDR_BIN_PATH?.trim() || "herdr";
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_START_INTERVAL_MS = 50;
const DEFAULT_SURFACE_READY_TIMEOUT_MS = readPositiveInteger(
  "PI_SUBAGENT_SURFACE_READY_TIMEOUT_MS",
  10_000,
);
const MAX_SURFACE_READY_ATTEMPTS = readPositiveInteger(
  "PI_SUBAGENT_SURFACE_READY_ATTEMPTS",
  2,
);
const createdSurfaces = new Set<string>();
let callerSurface: string | null = null;
let isHerdrCommandAvailable: boolean | null = null;

interface HerdrPaneResponse {
  result?: {
    pane?: {
      pane_id?: string;
    };
  };
}

interface HerdrProcessInfoResponse {
  result?: {
    process_info?: {
      foreground_process_group_id?: number;
      shell_pid?: number;
    };
  };
}

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue: string | undefined = process.env[name]?.trim();
  const value: number = rawValue ? Number(rawValue) : Number.NaN;

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

interface SurfaceLeaf {
  kind: "leaf";
  surface: string;
}

interface SurfaceSplit {
  first: SurfaceLayout;
  kind: "split";
  second: SurfaceLayout;
}

type SurfaceLayout = SurfaceLeaf | SurfaceSplit;

interface SurfaceDepth {
  depth: number;
  surface: string;
}

let automaticSurfaceLayout: SurfaceLayout | null = null;

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

function parsePaneId(output: string, operation: string): string {
  let response: HerdrPaneResponse;
  let paneId: string | undefined;

  try {
    response = JSON.parse(output) as HerdrPaneResponse;
  } catch {
    throw new Error(`Herdr returned malformed JSON while ${operation}: ${output}`);
  }

  paneId = response.result?.pane?.pane_id;
  if (!paneId) throw new Error(`Herdr returned no pane ID while ${operation}: ${output}`);
  return paneId;
}

function resolveCallerSurface(): string {
  const inheritedSurface: string | undefined = process.env.HERDR_PANE_ID?.trim();
  let output: string;

  if (callerSurface) return callerSurface;
  if (inheritedSurface) {
    callerSurface = inheritedSurface;
    return callerSurface;
  }

  try {
    output = runHerdr(["pane", "current", "--current"]);
  } catch (error) {
    throw new Error(
      "Failed to resolve the current Herdr caller pane. Start pi inside a Herdr pane.",
      { cause: error },
    );
  }
  callerSurface = parsePaneId(output, "resolving the current caller");
  return callerSurface;
}

function isSurfaceAvailable(surface: string): boolean {
  try {
    runHerdr(["pane", "get", surface]);
    return true;
  } catch {
    return false;
  }
}

function isShellForeground(surface: string): boolean {
  let response: HerdrProcessInfoResponse;
  let output: string;

  try {
    output = runHerdr(["pane", "process-info", "--pane", surface]);
    response = JSON.parse(output) as HerdrProcessInfoResponse;
  } catch {
    return false;
  }
  return (
    typeof response.result?.process_info?.shell_pid === "number" &&
    response.result.process_info.foreground_process_group_id ===
      response.result.process_info.shell_pid
  );
}

async function waitForShellForeground(surface: string, timeout: number): Promise<void> {
  const startedAt: number = Date.now();

  while (Date.now() - startedAt < timeout) {
    if (!isSurfaceAvailable(surface)) {
      throw new Error(`Herdr pane ${surface} closed before its shell became ready`);
    }
    if (isShellForeground(surface)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (isShellForeground(surface)) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_START_INTERVAL_MS));
  }
  throw new Error(`Herdr pane ${surface} shell was not ready within ${timeout}ms`);
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function listSurfaceDepths(
  layout: SurfaceLayout,
  depth: number,
  surfaces: SurfaceDepth[],
): void {
  if (layout.kind === "leaf") {
    surfaces.push({ depth, surface: layout.surface });
    return;
  }
  listSurfaceDepths(layout.first, depth + 1, surfaces);
  listSurfaceDepths(layout.second, depth + 1, surfaces);
}

function replaceSurfaceLeaf(
  layout: SurfaceLayout,
  surface: string,
  replacement: SurfaceLayout,
): SurfaceLayout {
  if (layout.kind === "leaf") return layout.surface === surface ? replacement : layout;
  return {
    kind: "split",
    first: replaceSurfaceLeaf(layout.first, surface, replacement),
    second: replaceSurfaceLeaf(layout.second, surface, replacement),
  };
}

function removeSurfaceLeaf(layout: SurfaceLayout, surface: string): SurfaceLayout | null {
  let first: SurfaceLayout | null;
  let second: SurfaceLayout | null;

  if (layout.kind === "leaf") return layout.surface === surface ? null : layout;
  first = removeSurfaceLeaf(layout.first, surface);
  second = removeSurfaceLeaf(layout.second, surface);
  if (!first) return second;
  if (!second) return first;
  return { kind: "split", first, second };
}

function pruneUnavailableSurfaces(): void {
  let surfaces: SurfaceDepth[];

  if (!automaticSurfaceLayout) return;
  surfaces = [];
  listSurfaceDepths(automaticSurfaceLayout, 0, surfaces);
  for (const candidate of surfaces) {
    if (!isSurfaceAvailable(candidate.surface)) {
      automaticSurfaceLayout = removeSurfaceLeaf(automaticSurfaceLayout, candidate.surface);
      createdSurfaces.delete(candidate.surface);
      if (!automaticSurfaceLayout) return;
    }
  }
}

export function createSurface(name: string): string {
  const surfaces: SurfaceDepth[] = [];
  let direction: "right" | "down";
  let newSurface: string;
  let target: SurfaceDepth;

  pruneUnavailableSurfaces();
  if (!automaticSurfaceLayout) {
    direction = process.env.PI_SUBAGENT_ID ? "down" : "right";
    newSurface = createSurfaceSplit(name, direction);
    automaticSurfaceLayout = { kind: "leaf", surface: newSurface };
    return newSurface;
  }

  listSurfaceDepths(automaticSurfaceLayout, 0, surfaces);
  target = surfaces.reduce((best, candidate) =>
    candidate.depth < best.depth ? candidate : best,
  );
  newSurface = createSurfaceSplit(name, "down", target.surface);
  automaticSurfaceLayout = replaceSurfaceLeaf(
    automaticSurfaceLayout,
    target.surface,
    {
      kind: "split",
      first: { kind: "leaf", surface: target.surface },
      second: { kind: "leaf", surface: newSurface },
    },
  );
  return newSurface;
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

  args.push("--pane", fromSurface ?? resolveCallerSurface());
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

  paneId = parsePaneId(output, "creating a pane");
  createdSurfaces.add(paneId);
  return paneId;
}

export function sendCommand(surface: string, command: string): void {
  runHerdr(["pane", "run", surface, command]);
}

export async function createReadySurface(name: string): Promise<string> {
  const readyDir: string = join(tmpdir(), "pi-subagent-surface-ready");
  let lastError: unknown = null;

  mkdirSync(readyDir, { recursive: true });
  for (let attempt = 1; attempt <= MAX_SURFACE_READY_ATTEMPTS; attempt += 1) {
    const surface: string = createSurface(name);
    const token: string = `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}`;
    const readyFile: string = join(readyDir, `${token}.ready`);

    try {
      await waitForShellForeground(surface, DEFAULT_SURFACE_READY_TIMEOUT_MS);
      sendCommand(surface, `printf '%s\\n' ${shellEscape(token)} > ${shellEscape(readyFile)}`);
      await waitForStart(readyFile, { timeout: DEFAULT_SURFACE_READY_TIMEOUT_MS });
      if (readFileSync(readyFile, "utf8").trim() !== token) {
        throw new Error(`Herdr pane ${surface} wrote an invalid shell-readiness token`);
      }
      rmSync(readyFile, { force: true });
      return surface;
    } catch (error) {
      lastError = error;
      try {
        closeSurface(surface);
      } catch {}
      rmSync(readyFile, { force: true });
    }
  }

  throw new Error(
    `Herdr did not provide a command-ready shell after ${MAX_SURFACE_READY_ATTEMPTS} attempts`,
    { cause: lastError },
  );
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
    if (automaticSurfaceLayout) {
      automaticSurfaceLayout = removeSurfaceLeaf(automaticSurfaceLayout, surface);
    }
    return;
  }

  try {
    runHerdr(["pane", "close", surface]);
  } catch (error) {
    if (isSurfaceAvailable(surface)) throw error;
  } finally {
    createdSurfaces.delete(surface);
    if (automaticSurfaceLayout) {
      automaticSurfaceLayout = removeSurfaceLeaf(automaticSurfaceLayout, surface);
    }
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
  resolveCallerSurface,
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
