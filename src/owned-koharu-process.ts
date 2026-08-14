import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalizerError } from "./errors.ts";
import { assertPathInside } from "./file-utils.ts";

const execFile = promisify(execFileCallback);

export interface OwnedChildHandle {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessIdentityObservation {
  pid: number;
  startTimeMs: number;
  executablePath: string;
}

export interface ListenerObservation {
  localAddress: string;
  localPort: number;
  owningPid: number;
}

export interface OwnedProcessPlatform {
  spawn(executablePath: string, args: string[], options: { env: NodeJS.ProcessEnv }): OwnedChildHandle;
  inspectProcess(pid: number): Promise<ProcessIdentityObservation | undefined>;
  inspectListeners(port: number): Promise<ListenerObservation[]>;
  sha256File(filePath: string): Promise<string>;
  waitForExit(child: OwnedChildHandle, timeoutMs: number): Promise<void>;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function powershellExecutable(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function childHandle(child: ChildProcess): OwnedChildHandle {
  if (!child.pid) throw new LocalizerError("OWNED_KOHARU_START_FAILED", "Owned Koharu child has no PID");
  return child as ChildProcess & OwnedChildHandle;
}

export const windowsOwnedProcessPlatform: OwnedProcessPlatform = {
  spawn(executablePath, args, options) {
    const child = spawn(executablePath, args, {
      env: options.env,
      stdio: "ignore",
      windowsHide: true,
      detached: false,
    });
    child.on("error", () => undefined);
    return childHandle(child);
  },
  async inspectProcess(pid) {
    const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;startTimeMs=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();executablePath=$p.Path}|ConvertTo-Json -Compress`;
    try {
      const { stdout } = await execFile(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      const value = JSON.parse(stdout) as ProcessIdentityObservation;
      return Number.isSafeInteger(value.pid) && Number.isFinite(value.startTimeMs) && typeof value.executablePath === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  },
  async inspectListeners(port) {
    const script = `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|ForEach-Object {[pscustomobject]@{localAddress=$_.LocalAddress;localPort=$_.LocalPort;owningPid=$_.OwningProcess}})|ConvertTo-Json -Compress`;
    const { stdout } = await execFile(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.filter((item): item is ListenerObservation => item && typeof item.localAddress === "string" && Number.isSafeInteger(item.localPort) && Number.isSafeInteger(item.owningPid));
  },
  sha256File,
  async waitForExit(child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    if (child.exitCode === null && child.signalCode === null) throw new LocalizerError("OWNED_KOHARU_STOP_TIMEOUT", "Owned Koharu did not stop within the bounded wait");
  },
};

function normalizeLoopback(address: string): string {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return normalized;
  throw new LocalizerError("OWNED_KOHARU_LOOPBACK_REQUIRED", "Owned Koharu must use a literal loopback address");
}

function sameExecutablePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface OwnedKoharuIdentity {
  schemaVersion: 1;
  pid: number;
  startTimeMs: number;
  executablePath: string;
  executableSha256: string;
  localAddress: string;
  localPort: number;
  dataRoot: string;
}

export class OwnedKoharuProcess {
  readonly identity: OwnedKoharuIdentity;
  private readonly child: OwnedChildHandle;
  private readonly platform: OwnedProcessPlatform;

  private constructor(identity: OwnedKoharuIdentity, child: OwnedChildHandle, platform: OwnedProcessPlatform) {
    this.identity = identity;
    this.child = child;
    this.platform = platform;
  }

  static async start(options: {
    executablePath: string;
    host: "127.0.0.1" | "::1";
    port: number;
    dataRoot: string;
    environment?: NodeJS.ProcessEnv;
    platform?: OwnedProcessPlatform;
    identityAttempts?: number;
    identityDelayMs?: number;
  }): Promise<OwnedKoharuProcess> {
    const platform = options.platform ?? windowsOwnedProcessPlatform;
    const host = normalizeLoopback(options.host);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new LocalizerError("OWNED_KOHARU_PORT_INVALID", "Owned Koharu port must be between 1 and 65535");
    const executablePath = path.resolve(options.executablePath);
    const executableInfo = await lstat(executablePath);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new LocalizerError("OWNED_KOHARU_EXE_INVALID", "Owned Koharu executable must be a regular file, not a link or reparse point");
    const executableSha256 = await platform.sha256File(executablePath);
    const dataRoot = path.resolve(options.dataRoot);
    const child = platform.spawn(executablePath, ["--port", String(options.port), "--headless"], {
      env: { ...process.env, ...options.environment, KOHARU_DATA_ROOT: dataRoot },
    });
    const attempts = options.identityAttempts ?? 40;
    const delayMs = options.identityDelayMs ?? 250;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const observed = await platform.inspectProcess(child.pid);
      const listeners = await platform.inspectListeners(options.port);
      if (observed && listeners.length === 1 && listeners[0].owningPid === child.pid && normalizeLoopback(listeners[0].localAddress) === host) {
        if (!sameExecutablePath(observed.executablePath, executablePath) || await platform.sha256File(executablePath) !== executableSha256) {
          throw new LocalizerError("OWNED_KOHARU_PROCESS_IDENTITY_MISMATCH", "Owned Koharu executable identity changed during startup");
        }
        return new OwnedKoharuProcess({
          schemaVersion: 1,
          pid: child.pid,
          startTimeMs: observed.startTimeMs,
          executablePath,
          executableSha256,
          localAddress: host,
          localPort: options.port,
          dataRoot,
        }, child, platform);
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new LocalizerError("OWNED_KOHARU_START_FAILED", "Owned Koharu exited before its loopback listener was verified");
      if (delayMs > 0) await delay(delayMs);
    }
    throw new LocalizerError("OWNED_KOHARU_IDENTITY_TIMEOUT", "Timed out verifying owned Koharu PID and loopback socket ownership");
  }

  async assertIdentity(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) throw new LocalizerError("OWNED_KOHARU_PROCESS_EXITED", "Owned Koharu child is no longer running");
    const [observed, listeners, executableSha256] = await Promise.all([
      this.platform.inspectProcess(this.identity.pid),
      this.platform.inspectListeners(this.identity.localPort),
      this.platform.sha256File(this.identity.executablePath),
    ]);
    const listener = listeners.length === 1 ? listeners[0] : undefined;
    if (
      !observed
      || observed.pid !== this.identity.pid
      || observed.startTimeMs !== this.identity.startTimeMs
      || !sameExecutablePath(observed.executablePath, this.identity.executablePath)
      || executableSha256 !== this.identity.executableSha256
      || !listener
      || listener.owningPid !== this.identity.pid
      || listener.localPort !== this.identity.localPort
      || normalizeLoopback(listener.localAddress) !== this.identity.localAddress
    ) {
      throw new LocalizerError("OWNED_KOHARU_PROCESS_IDENTITY_DRIFT", "Owned Koharu PID, executable, start time, or socket owner changed");
    }
  }

  async writeIdentity(filePath: string): Promise<void> {
    await writeFile(filePath, `${JSON.stringify(this.identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  async stop(): Promise<void> {
    await this.assertIdentity();
    if (!this.child.kill("SIGTERM")) throw new LocalizerError("OWNED_KOHARU_STOP_FAILED", "Owned Koharu child rejected the stop signal");
    await this.platform.waitForExit(this.child, 5_000);
  }
}

export interface OwnedRunLayout {
  root: string;
  dataRoot: string;
  projects: string;
  runtime: string;
  downloads: string;
  modelLink: string;
}

export async function createOwnedRunLayout(allowedRunRoot: string, runDirectory: string): Promise<OwnedRunLayout> {
  const allowed = await realpath(path.resolve(allowedRunRoot));
  const run = await realpath(path.resolve(runDirectory));
  const runInfo = await lstat(run);
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) throw new LocalizerError("OWNED_RUN_ROOT_UNSAFE", "Owned run directory must be a real directory");
  assertPathInside(allowed, run);
  const root = path.resolve(run, "owned-koharu");
  if (path.parse(allowed).root === allowed || path.parse(root).root === root) throw new LocalizerError("OWNED_RUN_ROOT_UNSAFE", "Owned run roots cannot be filesystem roots");
  assertPathInside(allowed, root);
  const dataRoot = path.join(root, "data");
  const projects = path.join(dataRoot, "projects");
  const runtime = path.join(dataRoot, "runtime");
  const downloads = path.join(dataRoot, "downloads");
  const models = path.join(dataRoot, "models");
  await mkdir(root, { recursive: false, mode: 0o700 });
  await mkdir(dataRoot, { recursive: false, mode: 0o700 });
  await Promise.all([projects, runtime, downloads, models].map((directory) => mkdir(directory, { recursive: false, mode: 0o700 })));
  return { root, dataRoot, projects, runtime, downloads, modelLink: path.join(models, "huggingface") };
}
