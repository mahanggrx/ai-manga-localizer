import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

export interface SystemMemorySnapshot {
  totalPhysicalMiB: number;
  availablePhysicalMiB: number;
  committedMiB?: number;
  commitLimitMiB?: number;
  commitHeadroomMiB?: number;
}

export interface ResourceRequirements {
  minAvailablePhysicalMiB: number;
  minCommitHeadroomMiB: number;
}

export interface ResourceAssessment {
  ok: boolean;
  code: "RESOURCE_HEADROOM_OK" | "PHYSICAL_MEMORY_LOW" | "COMMIT_HEADROOM_LOW" | "COMMIT_COUNTER_UNAVAILABLE";
  detail: string;
}

export const DEFAULT_HEAVY_PROCESS_REQUIREMENTS: Readonly<ResourceRequirements> = {
  minAvailablePhysicalMiB: 4_096,
  minCommitHeadroomMiB: 8_192,
};

function roundedMiB(bytes: number): number {
  return Math.round(bytes / MIB);
}

async function windowsCommitMemory(): Promise<{ committedMiB: number; commitLimitMiB: number }> {
  const script = [
    "$samples = (Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit').CounterSamples",
    "if ($samples.Count -lt 2) { throw 'Windows commit counters unavailable' }",
    "$values = @($samples | ForEach-Object { [double]$_.CookedValue })",
    "[pscustomobject]@{ committedBytes = [double](($values | Measure-Object -Minimum).Minimum); commitLimitBytes = [double](($values | Measure-Object -Maximum).Maximum) } | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 10_000,
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout.trim()) as { committedBytes?: number; commitLimitBytes?: number };
  if (!Number.isFinite(parsed.committedBytes) || !Number.isFinite(parsed.commitLimitBytes) || Number(parsed.commitLimitBytes) <= 0) {
    throw new Error("Windows commit counters returned invalid values");
  }
  return {
    committedMiB: roundedMiB(Number(parsed.committedBytes)),
    commitLimitMiB: roundedMiB(Number(parsed.commitLimitBytes)),
  };
}

export async function readSystemMemorySnapshot(): Promise<SystemMemorySnapshot> {
  const snapshot: SystemMemorySnapshot = {
    totalPhysicalMiB: roundedMiB(os.totalmem()),
    availablePhysicalMiB: roundedMiB(os.freemem()),
  };
  if (process.platform !== "win32") return snapshot;
  const commit = await windowsCommitMemory();
  snapshot.committedMiB = commit.committedMiB;
  snapshot.commitLimitMiB = commit.commitLimitMiB;
  snapshot.commitHeadroomMiB = commit.commitLimitMiB - commit.committedMiB;
  return snapshot;
}

export function assessResourceHeadroom(
  snapshot: SystemMemorySnapshot,
  requirements: ResourceRequirements = DEFAULT_HEAVY_PROCESS_REQUIREMENTS,
): ResourceAssessment {
  if (snapshot.availablePhysicalMiB < requirements.minAvailablePhysicalMiB) {
    return {
      ok: false,
      code: "PHYSICAL_MEMORY_LOW",
      detail: `${snapshot.availablePhysicalMiB} MiB available; ${requirements.minAvailablePhysicalMiB} MiB required before starting a heavy process`,
    };
  }
  if (snapshot.commitHeadroomMiB === undefined) {
    return {
      ok: true,
      code: "COMMIT_COUNTER_UNAVAILABLE",
      detail: `${snapshot.availablePhysicalMiB} MiB physical memory available; commit headroom could not be measured on this platform`,
    };
  }
  if (snapshot.commitHeadroomMiB < requirements.minCommitHeadroomMiB) {
    return {
      ok: false,
      code: "COMMIT_HEADROOM_LOW",
      detail: `${snapshot.commitHeadroomMiB} MiB commit headroom; ${requirements.minCommitHeadroomMiB} MiB required before starting a heavy process`,
    };
  }
  return {
    ok: true,
    code: "RESOURCE_HEADROOM_OK",
    detail: `${snapshot.availablePhysicalMiB} MiB physical memory and ${snapshot.commitHeadroomMiB} MiB commit headroom available`,
  };
}
