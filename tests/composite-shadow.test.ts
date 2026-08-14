import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOwnedRunLayout } from "../src/owned-koharu-process.ts";
import { stageOwnedRuntime } from "../src/owned-runtime-staging.ts";
import {
  buildCompositeShadowCache,
  validateShadowCache,
  type ShadowBuildPlatform,
  type ShadowCopySpec,
} from "../src/shadow-model-cache.ts";
import type { LocalizerConfig } from "../src/types.ts";

interface MicroFixture {
  root: string;
  sourceRoot: string;
  shadowRoot: string;
  files: ShadowCopySpec[];
  executable: ShadowCopySpec;
  config: ShadowCopySpec;
  font: ShadowCopySpec;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function microFixture(label: string): Promise<MicroFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `m3-9-${label}-`));
  const sourceRoot = path.join(root, "AppData-sources");
  await mkdir(sourceRoot);
  const items = [
    { source: "koharu.exe", target: "bin/koharu.exe", bytes: Buffer.from("synthetic executable") },
    { source: "runtime.dll", target: "runtime/runtime.dll", bytes: Buffer.from("synthetic runtime") },
    { source: "owned.toml", target: "config/owned.toml", bytes: Buffer.from("[data]\npath = '__OWNED_DATA_ROOT__'\n[http]\nmax_retries = 0\n") },
    { source: "font.ttf", target: "fonts/SyntheticSans.ttf", bytes: Buffer.from("synthetic font") },
    { source: "model.bin", target: "models/huggingface/blobs/model.bin", bytes: Buffer.from("synthetic model") },
  ];
  const files: ShadowCopySpec[] = [];
  for (const item of items) {
    const sourcePath = path.join(sourceRoot, item.source);
    await writeFile(sourcePath, item.bytes);
    files.push({ path: item.target, sourcePath, size: item.bytes.length, sha256: digest(item.bytes) });
  }
  const model = files.at(-1)!;
  files.push({
    path: "models/huggingface/snapshots/revision/model.bin",
    size: model.size,
    sha256: model.sha256,
    hardlinkTo: model.path,
  });
  return {
    root,
    sourceRoot,
    shadowRoot: path.join(root, "composite-shadow"),
    files,
    executable: files[0],
    config: files[2],
    font: files[3],
  };
}

function platform(overrides: Partial<ShadowBuildPlatform> = {}): ShadowBuildPlatform {
  return {
    copyFile,
    availableBytes: async () => 1024n * 1024n * 1024n,
    assertNoSourceReparsePoints: async () => undefined,
    ...overrides,
  };
}

async function build(fixture: MicroFixture, buildPlatform = platform()) {
  return buildCompositeShadowCache({
    sourceRoot: fixture.sourceRoot,
    shadowRoot: fixture.shadowRoot,
    allowedBoundary: fixture.root,
    appDataModelRoots: [fixture.sourceRoot],
    files: fixture.files,
    requiredEmptyDirectories: ["models/huggingface/snapshots/revision"],
    platform: buildPlatform,
  });
}

function ownedConfig(fixture: MicroFixture): NonNullable<LocalizerConfig["koharu"]["ownedProcess"]> {
  return {
    host: "127.0.0.1",
    port: 4042,
    allowedRunRoot: fixture.root,
    shadowCacheRoot: fixture.shadowRoot,
    shadowCacheManifest: path.join(fixture.root, "manifest.json"),
    appDataModelRoots: [fixture.sourceRoot],
    dataRootRelativePath: "owned-koharu/data",
    executable: {
      shadowRelativePath: fixture.executable.path,
      dataRelativePath: "runtime/bin/koharu.exe",
      size: fixture.executable.size,
      sha256: fixture.executable.sha256,
    },
    runtime: { shadowRelativePath: "runtime", dataRelativePath: "runtime" },
    config: {
      shadowRelativePath: fixture.config.path,
      dataRelativePath: "config.toml",
      size: fixture.config.size,
      sha256: fixture.config.sha256,
    },
    modelCache: { shadowRelativePath: "models/huggingface", dataRelativePath: "models/huggingface" },
    offline: { enabled: true, allowDownloads: false },
    rendererDefaultFont: {
      requestValue: "Synthetic Sans",
      shadowRelativePath: fixture.font.path,
      dataRelativePath: "fonts/SyntheticSans.ttf",
      size: fixture.font.size,
      sha256: fixture.font.sha256,
    },
  };
}

async function stagingRoots(fixture: MicroFixture): Promise<string[]> {
  return (await readdir(fixture.root)).filter((name) => name.startsWith(".composite-shadow.staging-"));
}

test("composite shadow succeeds atomically with copied runtime/config/font/model bytes and one internal hardlink", async () => {
  const fixture = await microFixture("success");
  const result = await build(fixture);
  assert.equal(result.fileCount, 6);
  assert.equal(result.internalHardlinkCount, 1);
  assert.equal(result.contentCopyBytes, fixture.files.slice(0, 5).reduce((sum, item) => sum + item.size, 0));
  assert.ok(result.manifest.files.every((entry) => !("sourcePath" in entry)));
  await assert.doesNotReject(() => validateShadowCache(fixture.shadowRoot, result.manifest, ["models/huggingface/snapshots/revision"]));
  const [sourceInfo, copiedInfo, blobInfo, snapshotInfo] = await Promise.all([
    stat(fixture.files[0].sourcePath!),
    stat(path.join(fixture.shadowRoot, fixture.files[0].path)),
    stat(path.join(fixture.shadowRoot, fixture.files[4].path)),
    stat(path.join(fixture.shadowRoot, fixture.files[5].path)),
  ]);
  assert.notDeepEqual([sourceInfo.dev, sourceInfo.ino], [copiedInfo.dev, copiedInfo.ino]);
  assert.deepEqual([blobInfo.dev, blobInfo.ino], [snapshotInfo.dev, snapshotInfo.ino]);
  assert.deepEqual(await stagingRoots(fixture), []);

  const runDirectory = path.join(fixture.root, "run");
  await mkdir(runDirectory);
  const layout = await createOwnedRunLayout(fixture.root, runDirectory);
  const staged = await stageOwnedRuntime({ owned: ownedConfig(fixture), layout, manifest: result.manifest });
  assert.equal(staged.defaultFont.requestValue, "Synthetic Sans");
  assert.equal(staged.defaultFont.sha256, fixture.font.sha256);
  assert.equal(staged.offlineEnvironment.HF_HUB_OFFLINE, "1");
  assert.match(await readFile(staged.configPath, "utf8"), /owned-koharu\/data/);
  assert.equal((await readFile(staged.executablePath)).toString(), "synthetic executable");
  assert.equal((await readFile(path.join(staged.runtimePath, "runtime.dll"))).toString(), "synthetic runtime");
});

test("composite shadow fails closed when a locked source drifts after copy", async () => {
  const fixture = await microFixture("source-drift");
  const driftSource = fixture.files[0].sourcePath!;
  await assert.rejects(() => build(fixture, platform({
    async copyFile(source, destination) {
      await copyFile(source, destination);
      if (source === driftSource) await writeFile(source, "source drift");
    },
  })), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_SOURCE_DRIFT");
  await assert.rejects(() => lstat(fixture.shadowRoot), { code: "ENOENT" });
  assert.deepEqual(await stagingRoots(fixture), []);
});

test("partial copy is never published", async () => {
  const fixture = await microFixture("partial-copy");
  await assert.rejects(() => build(fixture, platform({
    async copyFile(_source, destination) {
      await writeFile(destination, "partial");
      throw new Error("synthetic partial copy failure");
    },
  })), /synthetic partial copy failure/);
  await assert.rejects(() => lstat(fixture.shadowRoot), { code: "ENOENT" });
  assert.deepEqual(await stagingRoots(fixture), []);
});

test("disk-space gate stops before allocating staging", async () => {
  const fixture = await microFixture("disk-space");
  await assert.rejects(() => build(fixture, platform({ availableBytes: async () => 1n })), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_DISK_SPACE_INSUFFICIENT");
  await assert.rejects(() => lstat(fixture.shadowRoot), { code: "ENOENT" });
  assert.deepEqual(await stagingRoots(fixture), []);
});

test("source reparse inspection fails before staging without creating a link fixture", async () => {
  const fixture = await microFixture("reparse-source");
  await assert.rejects(() => build(fixture, platform({
    async assertNoSourceReparsePoints() { throw Object.assign(new Error("synthetic reparse source"), { code: "SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN" }); },
  })), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN");
  await assert.rejects(() => lstat(fixture.shadowRoot), { code: "ENOENT" });
  assert.deepEqual(await stagingRoots(fixture), []);
});

test("destination traversal is rejected before staging", async () => {
  const fixture = await microFixture("path-escape");
  fixture.files[0] = { ...fixture.files[0], path: "../outside.bin" };
  await assert.rejects(() => build(fixture), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_PATH_UNSAFE");
  await assert.rejects(() => lstat(path.join(fixture.root, "outside.bin")), { code: "ENOENT" });
  assert.deepEqual(await stagingRoots(fixture), []);
});

test("owned staging rejects renderer font drift against its explicit path/size/SHA pin", async () => {
  const fixture = await microFixture("font-drift");
  const result = await build(fixture);
  await writeFile(path.join(fixture.shadowRoot, fixture.font.path), "changed font");
  const runDirectory = path.join(fixture.root, "run");
  await mkdir(runDirectory);
  const layout = await createOwnedRunLayout(fixture.root, runDirectory);
  await assert.rejects(() => stageOwnedRuntime({ owned: ownedConfig(fixture), layout, manifest: result.manifest }), (error: unknown) => (error as { code?: string }).code === "OWNED_DEFAULT_FONT_DRIFT");
  assert.deepEqual(await readdir(layout.runtime), []);
});

test("owned staging rejects config-template drift against its explicit path/size/SHA pin", async () => {
  const fixture = await microFixture("config-drift");
  const result = await build(fixture);
  await writeFile(path.join(fixture.shadowRoot, fixture.config.path), "changed config");
  const runDirectory = path.join(fixture.root, "run");
  await mkdir(runDirectory);
  const layout = await createOwnedRunLayout(fixture.root, runDirectory);
  await assert.rejects(() => stageOwnedRuntime({ owned: ownedConfig(fixture), layout, manifest: result.manifest }), (error: unknown) => (error as { code?: string }).code === "OWNED_CONFIG_DRIFT");
  assert.deepEqual(await readdir(layout.runtime), []);
});

test("atomic publish conflict preserves the competing target and removes only this build staging", async () => {
  const fixture = await microFixture("publish-conflict");
  await assert.rejects(() => build(fixture, platform({
    async beforePublish(_stagingRoot, shadowRoot) { await mkdir(shadowRoot); },
  })), (error: unknown) => (error as { code?: string }).code === "SHADOW_CACHE_PUBLISH_CONFLICT");
  assert.deepEqual(await readdir(fixture.shadowRoot), []);
  assert.deepEqual(await stagingRoots(fixture), []);
});

test("failure after an earlier successful copy cleans exactly the recorded staging files and directories", async () => {
  const fixture = await microFixture("exact-cleanup");
  let calls = 0;
  await assert.rejects(() => build(fixture, platform({
    async copyFile(source, destination) {
      calls += 1;
      if (calls === 1) return copyFile(source, destination);
      await writeFile(destination, "second partial");
      throw new Error("synthetic second-copy failure");
    },
  })), /synthetic second-copy failure/);
  assert.equal(calls, 2);
  assert.deepEqual(await stagingRoots(fixture), []);
  assert.deepEqual((await readdir(fixture.root)).sort(), ["AppData-sources"]);
});
