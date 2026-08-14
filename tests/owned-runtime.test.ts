import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OwnedKoharuProcess, type ListenerObservation, type OwnedChildHandle, type OwnedProcessPlatform, type ProcessIdentityObservation } from "../src/owned-koharu-process.ts";
import { OwnedProjectGuard } from "../src/run-ownership.ts";
import {
  assertRunCacheLinkTarget,
  assertShadowHardlinkAllowed,
  buildShadowCache,
  cleanupOwnedCacheLinks,
  validateShadowCache,
} from "../src/shadow-model-cache.ts";
import type { KoharuProjectsSnapshot, KoharuSceneSnapshot } from "../src/types.ts";

class FakeProcessPlatform implements OwnedProcessPlatform {
  child: OwnedChildHandle = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => { this.killCalls += 1; this.child.exitCode = 0; return true; },
  };
  process: ProcessIdentityObservation = { pid: 4242, startTimeMs: 123456, executablePath: "" };
  listeners: ListenerObservation[] = [{ localAddress: "127.0.0.1", localPort: 4042, owningPid: 4242 }];
  hash = "e".repeat(64);
  killCalls = 0;
  spawn(_executablePath: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
    assert.deepEqual(args, ["--port", "4042", "--headless"]);
    assert.ok(options.env.KOHARU_DATA_ROOT);
    return this.child;
  }
  async inspectProcess() { return this.process; }
  async inspectListeners() { return this.listeners; }
  async sha256File() { return this.hash; }
  async waitForExit() { assert.equal(this.child.exitCode, 0); }
}

async function startedProcess(): Promise<{ manager: OwnedKoharuProcess; platform: FakeProcessPlatform; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "m3-8-owned-process-"));
  const executable = path.join(root, "koharu.exe");
  await writeFile(executable, "synthetic executable");
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot);
  const platform = new FakeProcessPlatform();
  platform.process.executablePath = executable;
  const manager = await OwnedKoharuProcess.start({
    executablePath: executable, host: "127.0.0.1", port: 4042, dataRoot, platform, identityAttempts: 1, identityDelayMs: 0,
  });
  return { manager, platform, root };
}

test("owned process records and revalidates PID, start time, executable hash, and listener owner", async () => {
  const { manager, platform } = await startedProcess();
  await manager.assertIdentity();
  platform.listeners = [{ localAddress: "127.0.0.1", localPort: 4042, owningPid: 9999 }];
  await assert.rejects(() => manager.stop(), (error: unknown) => (error as { code?: string }).code === "OWNED_KOHARU_PROCESS_IDENTITY_DRIFT");
  assert.equal(platform.killCalls, 0);
});

test("PID reuse and executable identity drift prevent process stop", async (t) => {
  for (const kind of ["start-time", "path", "hash"] as const) await t.test(kind, async () => {
    const { manager, platform, root } = await startedProcess();
    if (kind === "start-time") platform.process.startTimeMs += 1;
    if (kind === "path") platform.process.executablePath = path.join(root, "other.exe");
    if (kind === "hash") platform.hash = "f".repeat(64);
    await assert.rejects(() => manager.stop(), (error: unknown) => (error as { code?: string }).code === "OWNED_KOHARU_PROCESS_IDENTITY_DRIFT");
    assert.equal(platform.killCalls, 0);
  });
});

test("fully matched owned child is the only process that can be stopped", async () => {
  const { manager, platform } = await startedProcess();
  await manager.stop();
  assert.equal(platform.killCalls, 1);
});

function ownedScene(): KoharuSceneSnapshot {
  return {
    epoch: 2,
    scene: {
      project: { id: "owned-project" },
      pages: { p1: { id: "p1", width: 10, height: 20, nodes: { r1: { id: "r1", transform: { x: 1 }, kind: { text: { text: "private" } } } } } },
    },
  };
}

test("owned project guard fails on process, project, active-project, and scene population drift", async () => {
  let processValid = true;
  let projects: KoharuProjectsSnapshot = { projects: [{ id: "owned-project" }] };
  const client = { async listProjects() { return projects; } };
  const guard = new OwnedProjectGuard({
    client,
    project: { id: "owned-project" },
    projectsRoot: path.join(os.tmpdir(), "projects"),
    assertProcess: async () => { if (!processValid) throw Object.assign(new Error("pid drift"), { code: "OWNED_KOHARU_PROCESS_IDENTITY_DRIFT" }); },
  });
  const baseline = ownedScene();
  await guard.establishSceneIdentity(baseline);
  const sourceOnly = structuredClone(baseline);
  ((((sourceOnly.scene.pages as Record<string, unknown>).p1 as Record<string, unknown>).nodes as Record<string, unknown>).r1 as Record<string, unknown>);
  const node = ((((sourceOnly.scene.pages as Record<string, unknown>).p1 as Record<string, unknown>).nodes as Record<string, unknown>).r1 as Record<string, unknown>);
  (((node.kind as Record<string, unknown>).text as Record<string, unknown>).text) = "selected";
  await guard.assertProjectIdentity(sourceOnly);
  const geometryDrift = structuredClone(sourceOnly);
  const driftNode = ((((geometryDrift.scene.pages as Record<string, unknown>).p1 as Record<string, unknown>).nodes as Record<string, unknown>).r1 as Record<string, unknown>);
  (driftNode.transform as Record<string, unknown>).x = 9;
  await assert.rejects(() => guard.assertProjectIdentity(geometryDrift), (error: unknown) => (error as { code?: string }).code === "OWNED_KOHARU_SCENE_IDENTITY_DRIFT");
  const activeDrift = structuredClone(sourceOnly);
  (activeDrift.scene.project as Record<string, unknown>).id = "other";
  await assert.rejects(() => guard.assertProjectIdentity(activeDrift), (error: unknown) => (error as { code?: string }).code === "OWNED_KOHARU_ACTIVE_PROJECT_DRIFT");
  projects = { projects: [{ id: "owned-project" }, { id: "extra" }] };
  await assert.rejects(() => guard.assertProjectIdentity(), (error: unknown) => (error as { code?: string }).code === "OWNED_KOHARU_PROJECT_DRIFT");
  projects = { projects: [{ id: "owned-project" }] };
  processValid = false;
  await assert.rejects(() => guard.assertIdentity(), (error: unknown) => (error as { code?: string }).code === "OWNED_KOHARU_PROCESS_IDENTITY_DRIFT");
});

test("shadow cache copies locked bytes, permits only internal hardlinks, and detects mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m3-8-shadow-"));
  const sourceRoot = path.join(root, "AppData-model-cache");
  const shadowRoot = path.join(root, "project-shadow");
  await mkdir(sourceRoot);
  const bytes = Buffer.from("small synthetic locked model fixture");
  const source = path.join(sourceRoot, "blob.bin");
  await writeFile(source, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = await buildShadowCache({
    sourceRoot,
    shadowRoot,
    allowedBoundary: root,
    appDataModelRoots: [sourceRoot],
    manifestPath: path.join(root, "shadow-manifest.json"),
    files: [
      { path: path.join("blobs", "model.bin"), sourcePath: source, size: bytes.length, sha256 },
      { path: path.join("snapshots", "locked", "model.bin"), size: bytes.length, sha256, hardlinkTo: path.join("blobs", "model.bin") },
    ],
  });
  await assert.doesNotReject(() => validateShadowCache(shadowRoot, manifest));
  assert.throws(() => assertShadowHardlinkAllowed(source, path.join(shadowRoot, "bad.bin"), shadowRoot, [sourceRoot]), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_CROSS_ROOT_HARDLINK_FORBIDDEN");
  assert.throws(() => assertRunCacheLinkTarget(sourceRoot, sourceRoot, [sourceRoot]), (error: unknown) => (error as { code?: string }).code === "RUN_CACHE_APPDATA_LINK_FORBIDDEN");
  await writeFile(path.join(shadowRoot, "new-file.bin"), "mutation");
  await assert.rejects(() => validateShadowCache(shadowRoot, manifest), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_REBUILD_REQUIRED");
});

test("owned link cleanup verifies one exact link and performs no recursive traversal", async () => {
  const root = path.join(os.tmpdir(), "m3-8-cleanup-root");
  const linkPath = path.join(root, "data", "models", "huggingface");
  const targetPath = path.join(os.tmpdir(), "m3-8-shadow-target");
  const calls: string[] = [];
  await cleanupOwnedCacheLinks(root, [{ linkPath, targetPath }], {
    async lstat(value) { calls.push(`lstat:${value}`); return { isSymbolicLink: () => true }; },
    async readlink(value) { calls.push(`readlink:${value}`); return targetPath; },
    async unlink(value) { calls.push(`unlink:${value}`); },
  });
  assert.deepEqual(calls.map((item) => item.split(":")[0]), ["lstat", "readlink", "unlink"]);
});
