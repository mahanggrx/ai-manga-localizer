import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalizerError } from "./errors.ts";
import { assertPathInside } from "./file-utils.ts";
import type { OwnedRunLayout } from "./owned-koharu-process.ts";
import { hashRegularFile, type ShadowCacheFile, type ShadowCacheManifest } from "./shadow-model-cache.ts";
import type { LocalizerConfig } from "./types.ts";

const DATA_ROOT_PLACEHOLDER = "__OWNED_DATA_ROOT__";

interface CreatedEntry {
  path: string;
  kind: "file" | "directory";
}

export interface OwnedRuntimeStageRecord {
  schemaVersion: 1;
  dataRoot: string;
  executablePath: string;
  runtimePath: string;
  configPath: string;
  configSha256: string;
  defaultFont: {
    requestValue: string;
    path: string;
    size: number;
    sha256: string;
  };
  offlineEnvironment: NodeJS.ProcessEnv;
}

function relativePath(value: string, code: string): string {
  if (!value || path.isAbsolute(value) || value.includes(":")) throw new LocalizerError(code, "Owned staging paths must be non-empty relative paths without alternate-data-stream separators");
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new LocalizerError(code, "Owned staging path escapes its root");
  return normalized;
}

function sameRelative(left: string, right: string): boolean {
  const a = relativePath(left, "OWNED_STAGING_PATH_UNSAFE");
  const b = relativePath(right, "OWNED_STAGING_PATH_UNSAFE");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isUnderRelative(parent: string, child: string): boolean {
  const relative = path.relative(relativePath(parent, "OWNED_STAGING_PATH_UNSAFE"), relativePath(child, "OWNED_STAGING_PATH_UNSAFE"));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function manifestMap(manifest: ShadowCacheManifest): Map<string, ShadowCacheFile> {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Unsupported composite shadow manifest");
  const result = new Map<string, ShadowCacheFile>();
  for (const entry of manifest.files) {
    const normalized = relativePath(entry.path, "SHADOW_CACHE_MANIFEST_INVALID");
    if (result.has(normalized)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Composite shadow manifest contains duplicate paths");
    result.set(normalized, entry);
  }
  return result;
}

function exactEntry(entries: Map<string, ShadowCacheFile>, relative: string, expected: { size: number; sha256: string }, purpose: string): ShadowCacheFile {
  const normalized = relativePath(relative, "OWNED_STAGING_PATH_UNSAFE");
  const entry = entries.get(normalized);
  if (!entry || entry.size !== expected.size || entry.sha256 !== expected.sha256) {
    throw new LocalizerError("OWNED_STAGING_MANIFEST_MISMATCH", `${purpose} is absent from the composite manifest or differs from its explicit size/SHA-256 pin`);
  }
  return entry;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureParentDirectories(directory: string, dataRoot: string, created: CreatedEntry[]): Promise<void> {
  assertPathInside(dataRoot, directory);
  const relative = path.relative(dataRoot, directory);
  if (!relative) return;
  let current = dataRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (await exists(current)) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new LocalizerError("OWNED_STAGING_DESTINATION_UNSAFE", "Owned staging parents must be real directories");
      continue;
    }
    await mkdir(current, { recursive: false, mode: 0o700 });
    created.push({ path: current, kind: "directory" });
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyPinned(source: string, destination: string, entry: ShadowCacheFile, dataRoot: string, created: CreatedEntry[]): Promise<void> {
  await ensureParentDirectories(path.dirname(destination), dataRoot, created);
  if (await exists(destination)) throw new LocalizerError("OWNED_STAGING_DESTINATION_EXISTS", "Owned runtime staging never overwrites an existing path");
  const before = await hashRegularFile(source, "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN");
  if (before.size !== entry.size || before.sha256 !== entry.sha256) throw new LocalizerError("OWNED_STAGING_SOURCE_DRIFT", "Owned staging source differs from the verified composite manifest");
  created.push({ path: destination, kind: "file" });
  await copyFile(source, destination);
  const [afterSource, afterDestination] = await Promise.all([
    hashRegularFile(source, "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN"),
    hashRegularFile(destination, "OWNED_STAGING_DESTINATION_UNSAFE"),
  ]);
  if (
    afterSource.size !== entry.size
    || afterSource.sha256 !== entry.sha256
    || afterDestination.size !== entry.size
    || afterDestination.sha256 !== entry.sha256
  ) throw new LocalizerError("OWNED_STAGING_SOURCE_DRIFT", "Owned staging source or destination drifted while copying");
}

async function cleanup(created: CreatedEntry[], dataRoot: string): Promise<void> {
  const failures: unknown[] = [];
  for (const entry of [...created].reverse()) {
    try {
      assertPathInside(dataRoot, entry.path);
      const info = await lstat(entry.path);
      if (info.isSymbolicLink()) throw new LocalizerError("OWNED_STAGING_CLEANUP_UNSAFE", "Owned staging cleanup refuses a reparse point");
      if (entry.kind === "file") {
        if (!info.isFile()) throw new LocalizerError("OWNED_STAGING_CLEANUP_UNSAFE", "Owned staging cleanup file changed identity");
        await unlink(entry.path);
      } else {
        if (!info.isDirectory()) throw new LocalizerError("OWNED_STAGING_CLEANUP_UNSAFE", "Owned staging cleanup directory changed identity");
        await rmdir(entry.path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) throw new LocalizerError("OWNED_STAGING_CLEANUP_FAILED", "Exact cleanup of owned runtime staging failed", { cause: failures[0] });
}

export function ownedOfflineEnvironment(): NodeJS.ProcessEnv {
  return {
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    NO_PROXY: "127.0.0.1,::1,localhost",
    no_proxy: "127.0.0.1,::1,localhost",
  };
}

export async function stageOwnedRuntime(options: {
  owned: NonNullable<LocalizerConfig["koharu"]["ownedProcess"]>;
  layout: OwnedRunLayout;
  manifest: ShadowCacheManifest;
}): Promise<OwnedRuntimeStageRecord> {
  const { owned, layout, manifest } = options;
  if (!owned.offline.enabled || owned.offline.allowDownloads) throw new LocalizerError("OWNED_OFFLINE_POLICY_INVALID", "Owned execution requires offline mode with downloads explicitly disabled");
  if (owned.dataRootRelativePath !== "owned-koharu/data" || !sameRelative(path.relative(path.dirname(layout.root), layout.dataRoot), "owned-koharu/data")) {
    throw new LocalizerError("OWNED_DATA_ROOT_MISMATCH", "Owned data root does not match the explicit run-relative path frozen in config");
  }
  if (!sameRelative(owned.runtime.dataRelativePath, "runtime") || !sameRelative(owned.config.dataRelativePath, "config.toml") || !sameRelative(owned.modelCache.dataRelativePath, "models/huggingface")) {
    throw new LocalizerError("OWNED_STAGING_LAYOUT_INVALID", "Owned runtime, config, and model-cache destinations must use the isolated data-root layout");
  }

  const shadowRoot = path.resolve(owned.shadowCacheRoot);
  const entries = manifestMap(manifest);
  const executableEntry = exactEntry(entries, owned.executable.shadowRelativePath, owned.executable, "Owned executable");
  const configEntry = exactEntry(entries, owned.config.shadowRelativePath, owned.config, "Owned config template");
  const fontEntry = exactEntry(entries, owned.rendererDefaultFont.shadowRelativePath, owned.rendererDefaultFont, "Renderer default font");
  const runtimePrefix = relativePath(owned.runtime.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE");
  const modelPrefix = relativePath(owned.modelCache.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE");
  const runtimeEntries = [...entries.entries()].filter(([entryPath]) => isUnderRelative(runtimePrefix, entryPath));
  const modelEntries = [...entries.keys()].filter((entryPath) => isUnderRelative(modelPrefix, entryPath));
  if (runtimeEntries.length === 0) throw new LocalizerError("OWNED_RUNTIME_MANIFEST_EMPTY", "Composite manifest contains no files under the configured runtime subtree");
  if (modelEntries.length === 0) throw new LocalizerError("OWNED_MODEL_MANIFEST_EMPTY", "Composite manifest contains no files under the configured model-cache subtree");

  const [actualExecutable, actualConfig, actualFont] = await Promise.all([
    hashRegularFile(path.join(shadowRoot, relativePath(owned.executable.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE")), "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN"),
    hashRegularFile(path.join(shadowRoot, relativePath(owned.config.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE")), "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN"),
    hashRegularFile(path.join(shadowRoot, relativePath(owned.rendererDefaultFont.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE")), "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN"),
  ]);
  if (actualExecutable.size !== executableEntry.size || actualExecutable.sha256 !== executableEntry.sha256) throw new LocalizerError("OWNED_EXECUTABLE_DRIFT", "Owned executable differs from its explicit composite-manifest pin");
  if (actualConfig.size !== configEntry.size || actualConfig.sha256 !== configEntry.sha256) throw new LocalizerError("OWNED_CONFIG_DRIFT", "Owned config template differs from its explicit composite-manifest pin");
  if (actualFont.size !== fontEntry.size || actualFont.sha256 !== fontEntry.sha256) throw new LocalizerError("OWNED_DEFAULT_FONT_DRIFT", "Renderer default font differs from its explicit composite-manifest pin");

  const created: CreatedEntry[] = [];
  try {
    const executablePath = path.join(layout.dataRoot, relativePath(owned.executable.dataRelativePath, "OWNED_STAGING_PATH_UNSAFE"));
    await copyPinned(path.join(shadowRoot, relativePath(owned.executable.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE")), executablePath, executableEntry, layout.dataRoot, created);

    const runtimeDestination = path.join(layout.dataRoot, relativePath(owned.runtime.dataRelativePath, "OWNED_STAGING_PATH_UNSAFE"));
    for (const [entryPath, entry] of runtimeEntries) {
      const suffix = path.relative(runtimePrefix, entryPath);
      await copyPinned(path.join(shadowRoot, entryPath), path.join(runtimeDestination, suffix), entry, layout.dataRoot, created);
    }

    const configSource = path.join(shadowRoot, relativePath(owned.config.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE"));
    const configBefore = await hashRegularFile(configSource, "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN");
    if (configBefore.size !== configEntry.size || configBefore.sha256 !== configEntry.sha256) throw new LocalizerError("OWNED_CONFIG_DRIFT", "Owned config template differs from its explicit manifest pin");
    const template = await readFile(configSource, "utf8");
    if (template.split(DATA_ROOT_PLACEHOLDER).length !== 2) throw new LocalizerError("OWNED_CONFIG_TEMPLATE_INVALID", "Owned config template must contain exactly one data-root placeholder");
    const portableDataRoot = layout.dataRoot.replaceAll("\\", "/");
    if (portableDataRoot.includes("'")) throw new LocalizerError("OWNED_DATA_ROOT_UNSAFE", "Owned data root cannot be represented safely in the frozen TOML template");
    const configPath = path.join(layout.dataRoot, relativePath(owned.config.dataRelativePath, "OWNED_STAGING_PATH_UNSAFE"));
    await ensureParentDirectories(path.dirname(configPath), layout.dataRoot, created);
    if (await exists(configPath)) throw new LocalizerError("OWNED_STAGING_DESTINATION_EXISTS", "Owned config staging never overwrites an existing path");
    created.push({ path: configPath, kind: "file" });
    await writeFile(configPath, template.replace(DATA_ROOT_PLACEHOLDER, portableDataRoot), { flag: "wx", mode: 0o600 });
    const configAfter = await hashRegularFile(configSource, "OWNED_STAGING_SOURCE_REPARSE_FORBIDDEN");
    if (configAfter.size !== configEntry.size || configAfter.sha256 !== configEntry.sha256) throw new LocalizerError("OWNED_CONFIG_DRIFT", "Owned config template drifted during staging");

    const defaultFontPath = path.join(layout.dataRoot, relativePath(owned.rendererDefaultFont.dataRelativePath, "OWNED_STAGING_PATH_UNSAFE"));
    await copyPinned(path.join(shadowRoot, relativePath(owned.rendererDefaultFont.shadowRelativePath, "OWNED_STAGING_PATH_UNSAFE")), defaultFontPath, fontEntry, layout.dataRoot, created);
    const stagedFont = await hashRegularFile(defaultFontPath, "OWNED_STAGING_DESTINATION_UNSAFE");
    if (stagedFont.size !== owned.rendererDefaultFont.size || stagedFont.sha256 !== owned.rendererDefaultFont.sha256) throw new LocalizerError("OWNED_DEFAULT_FONT_DRIFT", "Staged renderer default font differs from its explicit size/SHA-256 pin");

    return {
      schemaVersion: 1,
      dataRoot: layout.dataRoot,
      executablePath,
      runtimePath: runtimeDestination,
      configPath,
      configSha256: await hashFile(configPath),
      defaultFont: {
        requestValue: owned.rendererDefaultFont.requestValue,
        path: defaultFontPath,
        size: stagedFont.size,
        sha256: stagedFont.sha256,
      },
      offlineEnvironment: ownedOfflineEnvironment(),
    };
  } catch (error) {
    try {
      await cleanup(created, layout.dataRoot);
    } catch (cleanupError) {
      throw new LocalizerError("OWNED_STAGING_CLEANUP_FAILED", "Owned runtime staging failed and exact cleanup also failed", { cause: cleanupError });
    }
    throw error;
  }
}
