import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  statfs,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { LocalizerError } from "./errors.ts";
import { assertPathInside } from "./file-utils.ts";

const BUILD_RESERVE_BYTES = 64 * 1024 * 1024;
const execFile = promisify(execFileCallback);

export interface ShadowCacheFile {
  path: string;
  size: number;
  sha256: string;
  hardlinkTo?: string;
}

export interface ShadowCacheManifest {
  schemaVersion: 1;
  files: ShadowCacheFile[];
}

export interface ShadowCopySpec extends ShadowCacheFile {
  sourcePath?: string;
}

export interface ShadowBuildPlatform {
  copyFile(source: string, destination: string): Promise<void>;
  availableBytes(directory: string): Promise<bigint>;
  assertNoSourceReparsePoints(sourcePaths: string[]): Promise<void>;
  beforePublish?(stagingRoot: string, shadowRoot: string): Promise<void>;
}

export interface CompositeShadowBuildResult {
  manifest: ShadowCacheManifest;
  manifestHash: string;
  fileCount: number;
  contentCopyBytes: number;
  internalHardlinkCount: number;
  availableBytes: bigint;
  requiredTemporaryBytes: bigint;
}

interface CreatedEntry {
  path: string;
  kind: "file" | "directory";
}

function normalizedRoot(value: string, code: string): string {
  if (!value || value === "." || value === "..") throw new LocalizerError(code, "Cache root must be explicit and non-empty");
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved || resolved === path.resolve(process.cwd())) throw new LocalizerError(code, "Cache root cannot be a filesystem or working-directory root");
  return resolved;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelative(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes(":")) throw new LocalizerError("SHADOW_CACHE_PATH_UNSAFE", "Shadow cache manifest paths must be relative and cannot contain alternate data stream separators");
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new LocalizerError("SHADOW_CACHE_PATH_UNSAFE", "Shadow cache manifest path escapes the cache root");
  return normalized;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoReparseComponents(targetPath: string, code: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new LocalizerError(code, "Source and shadow paths cannot contain symlinks, junctions, or other link-like reparse points");
  }
}

export async function hashRegularFile(filePath: string, code = "SHADOW_CACHE_FILE_INVALID"): Promise<{ size: number; sha256: string }> {
  await assertNoReparseComponents(filePath, code);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new LocalizerError(code, "Shadow dependency entries must be regular files, not links or reparse points");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest("hex") };
}

function assertExpected(actual: { size: number; sha256: string }, expected: ShadowCacheFile, code = "SHADOW_CACHE_REBUILD_REQUIRED"): void {
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Shadow cache manifest contains an invalid size or SHA-256");
  }
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new LocalizerError(code, "Shadow dependency content differs from its locked manifest");
  }
}

async function enumerateFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow cache contains a symlink, junction, or link-like reparse point");
    if (info.isDirectory()) result.push(...await enumerateFiles(root, childRelative));
    else if (info.isFile()) result.push(childRelative);
    else throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow cache contains an unsupported filesystem entry");
  }
  return result.sort();
}

function canonicalManifest(manifest: ShadowCacheManifest): string {
  return JSON.stringify({ schemaVersion: 1, files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) });
}

export function assertShadowHardlinkAllowed(source: string, destination: string, shadowRoot: string, appDataModelRoots: string[]): void {
  const shadow = normalizedRoot(shadowRoot, "SHADOW_CACHE_ROOT_UNSAFE");
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  if (!within(shadow, resolvedSource) || !within(shadow, resolvedDestination) || appDataModelRoots.some((root) => within(root, resolvedSource))) {
    throw new LocalizerError("SHADOW_CACHE_CROSS_ROOT_HARDLINK_FORBIDDEN", "Hardlinks are allowed only between two files inside the project-owned shadow cache");
  }
}

export function assertRunCacheLinkTarget(target: string, shadowRoot: string, appDataModelRoots: string[]): string {
  const resolvedTarget = path.resolve(target);
  const shadow = normalizedRoot(shadowRoot, "SHADOW_CACHE_ROOT_UNSAFE");
  if (!samePath(resolvedTarget, shadow)) throw new LocalizerError("RUN_CACHE_LINK_TARGET_INVALID", "Each run may link only to the configured model subtree of the verified composite shadow");
  if (appDataModelRoots.some((root) => within(root, resolvedTarget))) {
    throw new LocalizerError("RUN_CACHE_APPDATA_LINK_FORBIDDEN", "A run cache link cannot target an AppData model cache");
  }
  return resolvedTarget;
}

export async function validateShadowCache(
  shadowRoot: string,
  manifest: ShadowCacheManifest,
  requiredEmptyDirectories: string[] = [],
): Promise<{ manifestHash: string; fileCount: number }> {
  const requestedRoot = normalizedRoot(shadowRoot, "SHADOW_CACHE_ROOT_UNSAFE");
  await assertNoReparseComponents(requestedRoot, "SHADOW_CACHE_REBUILD_REQUIRED");
  const root = await realpath(requestedRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow cache root must be a real directory");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Unsupported shadow cache manifest");
  const expectedPaths = new Set<string>();
  for (const entry of manifest.files) {
    const relative = safeRelative(entry.path);
    if (expectedPaths.has(relative)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Shadow cache manifest contains duplicate paths");
    expectedPaths.add(relative);
    const actual = await hashRegularFile(path.join(root, relative), "SHADOW_CACHE_REBUILD_REQUIRED");
    assertExpected(actual, entry);
    if (entry.hardlinkTo !== undefined) {
      const targetRelative = safeRelative(entry.hardlinkTo);
      if (!expectedPaths.has(targetRelative)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Internal hardlink target must appear earlier in the manifest");
      const targetPath = path.join(root, targetRelative);
      assertShadowHardlinkAllowed(targetPath, path.join(root, relative), root, []);
      const [targetInfo, entryInfo] = await Promise.all([stat(targetPath), stat(path.join(root, relative))]);
      if (
        targetInfo.ino === 0
        || entryInfo.ino === 0
        || targetInfo.nlink < 2
        || entryInfo.nlink < 2
        || targetInfo.dev !== entryInfo.dev
        || targetInfo.ino !== entryInfo.ino
      ) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Declared internal hardlink identity cannot be proven against its shadow target");
    }
  }
  const requiredDirectories = new Set<string>();
  for (const item of requiredEmptyDirectories) {
    const relative = safeRelative(item);
    if (requiredDirectories.has(relative)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Required directory paths must be unique");
    requiredDirectories.add(relative);
    const directory = path.join(root, relative);
    await assertNoReparseComponents(directory, "SHADOW_CACHE_REBUILD_REQUIRED");
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "A required shadow directory is missing or linked");
    }
  }
  const actualPaths = await enumerateFiles(root);
  if (actualPaths.length !== expectedPaths.size || actualPaths.some((item) => !expectedPaths.has(item))) {
    throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Composite shadow population changed; it must be rebuilt from locked sources");
  }
  return { manifestHash: createHash("sha256").update(canonicalManifest(manifest)).digest("hex"), fileCount: manifest.files.length };
}

async function defaultAvailableBytes(directory: string): Promise<bigint> {
  const value = await statfs(directory, { bigint: true });
  return value.bavail * value.bsize;
}

async function assertNoSourceReparsePoints(sourcePaths: string[]): Promise<void> {
  if (process.platform !== "win32") {
    for (const sourcePath of sourcePaths) await assertNoReparseComponents(sourcePath, "SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN");
    return;
  }
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$paths=@(ConvertFrom-Json $env:AML_SHADOW_REPARSE_PATHS);$r=@();foreach($p in $paths){$i=Get-Item -LiteralPath $p -Force -ErrorAction Stop;$r+=[pscustomobject]@{path=$i.FullName;isReparsePoint=(($i.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0)}};$r|ConvertTo-Json -Compress";
  for (let index = 0; index < sourcePaths.length; index += 24) {
    const batch = sourcePaths.slice(index, index + 24);
    let parsed: unknown;
    try {
      const { stdout } = await execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        env: { ...process.env, AML_SHADOW_REPARSE_PATHS: JSON.stringify(batch) },
      });
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new LocalizerError("SHADOW_CACHE_SOURCE_REPARSE_CHECK_FAILED", "Windows reparse-point inspection failed closed", { cause: error });
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    if (records.length !== batch.length) throw new LocalizerError("SHADOW_CACHE_SOURCE_REPARSE_CHECK_FAILED", "Windows reparse-point inspection returned an incomplete source population");
    for (let offset = 0; offset < batch.length; offset += 1) {
      const record = records[offset] as { path?: unknown; isReparsePoint?: unknown };
      if (typeof record?.path !== "string" || record.isReparsePoint !== false || !samePath(record.path, batch[offset])) {
        throw new LocalizerError("SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN", "Locked source is a reparse point or changed identity during Windows inspection");
      }
    }
  }
}

const defaultBuildPlatform: ShadowBuildPlatform = { copyFile, availableBytes: defaultAvailableBytes, assertNoSourceReparsePoints };

async function makeDirectoryTracked(directory: string, stagingRoot: string, created: CreatedEntry[]): Promise<void> {
  assertPathInside(stagingRoot, directory);
  const relative = path.relative(stagingRoot, directory);
  if (!relative) return;
  let current = stagingRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (await pathExists(current)) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_DESTINATION_UNSAFE", "Shadow staging parents must be real directories");
      continue;
    }
    await mkdir(current, { recursive: false, mode: 0o700 });
    created.push({ path: current, kind: "directory" });
  }
}

async function cleanupCreatedEntries(created: CreatedEntry[], boundary: string): Promise<void> {
  const failures: unknown[] = [];
  for (const entry of [...created].reverse()) {
    try {
      assertPathInside(boundary, entry.path);
      const info = await lstat(entry.path);
      if (info.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_BUILD_CLEANUP_UNSAFE", "Cleanup refuses to enter or unlink a reparse point");
      if (entry.kind === "file") {
        if (!info.isFile()) throw new LocalizerError("SHADOW_CACHE_BUILD_CLEANUP_UNSAFE", "Recorded cleanup file changed identity");
        await unlink(entry.path);
      } else {
        if (!info.isDirectory()) throw new LocalizerError("SHADOW_CACHE_BUILD_CLEANUP_UNSAFE", "Recorded cleanup directory changed identity");
        await rmdir(entry.path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) throw new LocalizerError("SHADOW_CACHE_BUILD_CLEANUP_FAILED", "Exact cleanup of this build's recorded staging entries failed", { cause: failures[0] });
}

export async function buildCompositeShadowCache(options: {
  sourceRoot?: string;
  shadowRoot: string;
  allowedBoundary: string;
  appDataModelRoots: string[];
  files: ShadowCopySpec[];
  requiredEmptyDirectories?: string[];
  platform?: ShadowBuildPlatform;
}): Promise<CompositeShadowBuildResult> {
  const platform = options.platform ?? defaultBuildPlatform;
  const requestedShadow = normalizedRoot(options.shadowRoot, "SHADOW_CACHE_ROOT_UNSAFE");
  const requestedParent = path.dirname(requestedShadow);
  await assertNoReparseComponents(requestedParent, "SHADOW_CACHE_BOUNDARY_UNSAFE");
  const shadowParent = await realpath(requestedParent);
  const shadowRoot = path.join(shadowParent, path.basename(requestedShadow));
  const boundary = await realpath(normalizedRoot(options.allowedBoundary, "SHADOW_CACHE_BOUNDARY_UNSAFE"));
  await assertNoReparseComponents(boundary, "SHADOW_CACHE_BOUNDARY_UNSAFE");
  assertPathInside(boundary, shadowRoot);
  const appDataModelRoots = await Promise.all(options.appDataModelRoots.map(async (root) => {
    await assertNoReparseComponents(path.resolve(root), "MODEL_SOURCE_ROOT_UNSAFE");
    return realpath(path.resolve(root));
  }));
  if (appDataModelRoots.some((root) => within(root, shadowRoot))) throw new LocalizerError("SHADOW_CACHE_ROOT_IN_APPDATA", "Project-owned shadow cache must not live inside an AppData model cache");
  if (await pathExists(shadowRoot)) throw new LocalizerError("SHADOW_CACHE_ALREADY_EXISTS", "Composite shadow build target must not already exist");

  let sourceRoot: string | undefined;
  if (options.sourceRoot !== undefined) {
    const requestedSourceRoot = normalizedRoot(options.sourceRoot, "MODEL_SOURCE_ROOT_UNSAFE");
    await assertNoReparseComponents(requestedSourceRoot, "MODEL_SOURCE_ROOT_UNSAFE");
    sourceRoot = await realpath(requestedSourceRoot);
    if (within(sourceRoot, shadowRoot) || within(shadowRoot, sourceRoot)) throw new LocalizerError("SHADOW_CACHE_SOURCE_TARGET_OVERLAP", "Composite shadow and locked source roots must be independent trees");
  }

  const seen = new Set<string>();
  const normalizedFiles = options.files.map((spec) => {
    const relative = safeRelative(spec.path);
    if (seen.has(relative)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Shadow copy plan contains duplicate paths");
    seen.add(relative);
    assertExpected({ size: spec.size, sha256: spec.sha256 }, spec, "SHADOW_CACHE_MANIFEST_INVALID");
    if (spec.hardlinkTo !== undefined) {
      const hardlinkTo = safeRelative(spec.hardlinkTo);
      if (!seen.has(hardlinkTo)) throw new LocalizerError("SHADOW_CACHE_HARDLINK_ORDER_INVALID", "Internal hardlink target must be copied earlier in the build plan");
      return { ...spec, path: relative, hardlinkTo };
    }
    if (!spec.sourcePath || !path.isAbsolute(spec.sourcePath)) throw new LocalizerError("SHADOW_CACHE_SOURCE_MISSING", "Copied composite shadow entries require an explicit absolute locked source path");
    return { ...spec, path: relative, sourcePath: path.resolve(spec.sourcePath) };
  });
  const requiredEmptyDirectories = (options.requiredEmptyDirectories ?? []).map(safeRelative);
  await platform.assertNoSourceReparsePoints(normalizedFiles.filter((item) => item.hardlinkTo === undefined).map((item) => item.sourcePath!));
  const contentCopyBytes = normalizedFiles.reduce((sum, item) => sum + (item.hardlinkTo === undefined ? item.size : 0), 0);
  const largestCopyBytes = normalizedFiles.reduce((largest, item) => item.hardlinkTo === undefined ? Math.max(largest, item.size) : largest, 0);
  if (!Number.isSafeInteger(contentCopyBytes)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Composite copy-byte total exceeds safe integer range");
  const requiredTemporaryBytes = BigInt(contentCopyBytes) + BigInt(largestCopyBytes) + BigInt(BUILD_RESERVE_BYTES);
  const availableBytes = await platform.availableBytes(shadowParent);
  if (availableBytes < requiredTemporaryBytes) throw new LocalizerError("SHADOW_CACHE_DISK_SPACE_INSUFFICIENT", "Target volume does not have enough free space for the composite shadow and worst-case partial copy");

  const stagingRoot = path.join(shadowParent, `.${path.basename(shadowRoot)}.staging-${randomUUID()}`);
  assertPathInside(boundary, stagingRoot);
  if (!samePath(path.parse(stagingRoot).root, path.parse(shadowRoot).root)) throw new LocalizerError("SHADOW_CACHE_STAGING_VOLUME_MISMATCH", "Composite shadow staging and final roots must be on the same volume");
  const created: CreatedEntry[] = [];
  let published = false;
  try {
    await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    created.push({ path: stagingRoot, kind: "directory" });
    for (const relative of requiredEmptyDirectories) await makeDirectoryTracked(path.join(stagingRoot, relative), stagingRoot, created);

    const manifest: ShadowCacheManifest = { schemaVersion: 1, files: [] };
    const built = new Set<string>();
    for (const spec of normalizedFiles) {
      const destination = path.join(stagingRoot, spec.path);
      await makeDirectoryTracked(path.dirname(destination), stagingRoot, created);
      created.push({ path: destination, kind: "file" });
      if (spec.hardlinkTo !== undefined) {
        const target = path.join(stagingRoot, spec.hardlinkTo);
        if (!built.has(spec.hardlinkTo)) throw new LocalizerError("SHADOW_CACHE_HARDLINK_ORDER_INVALID", "Internal hardlink target must be materialized earlier in the build plan");
        assertShadowHardlinkAllowed(target, destination, stagingRoot, appDataModelRoots);
        await link(target, destination);
      } else {
        const requestedSource = spec.sourcePath!;
        await assertNoReparseComponents(requestedSource, "SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN");
        const source = await realpath(requestedSource);
        if (!samePath(source, requestedSource)) throw new LocalizerError("SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN", "Locked source resolved through an alias or reparse point");
        if (sourceRoot) assertPathInside(sourceRoot, source);
        const before = await hashRegularFile(source, "SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN");
        assertExpected(before, spec);
        await platform.copyFile(source, destination);
        const afterSource = await hashRegularFile(source, "SHADOW_CACHE_SOURCE_REPARSE_FORBIDDEN");
        assertExpected(afterSource, spec, "SHADOW_CACHE_SOURCE_DRIFT");
      }
      const copied = await hashRegularFile(destination);
      assertExpected(copied, spec);
      built.add(spec.path);
      manifest.files.push({ path: spec.path, size: spec.size, sha256: spec.sha256, ...(spec.hardlinkTo ? { hardlinkTo: spec.hardlinkTo } : {}) });
    }
    const staged = await validateShadowCache(stagingRoot, manifest, requiredEmptyDirectories);
    await platform.beforePublish?.(stagingRoot, shadowRoot);
    if (await pathExists(shadowRoot)) throw new LocalizerError("SHADOW_CACHE_PUBLISH_CONFLICT", "Composite shadow target appeared before atomic publish");
    try {
      await rename(stagingRoot, shadowRoot);
    } catch (error) {
      throw new LocalizerError("SHADOW_CACHE_PUBLISH_CONFLICT", "Atomic composite shadow publish failed; the final path was not accepted", { cause: error });
    }
    published = true;
    const final = await validateShadowCache(shadowRoot, manifest, requiredEmptyDirectories);
    if (final.manifestHash !== staged.manifestHash) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Composite shadow identity changed during atomic publish");
    return {
      manifest,
      ...final,
      contentCopyBytes,
      internalHardlinkCount: normalizedFiles.length - normalizedFiles.filter((item) => item.hardlinkTo === undefined).length,
      availableBytes,
      requiredTemporaryBytes,
    };
  } catch (error) {
    if (!published) {
      try {
        await cleanupCreatedEntries(created, boundary);
      } catch (cleanupError) {
        throw new LocalizerError("SHADOW_CACHE_BUILD_CLEANUP_FAILED", "Composite shadow build failed and its exact staging cleanup also failed", { cause: cleanupError });
      }
    }
    throw error;
  }
}

export async function buildShadowCache(options: {
  sourceRoot?: string;
  shadowRoot: string;
  allowedBoundary: string;
  appDataModelRoots: string[];
  files: ShadowCopySpec[];
  requiredEmptyDirectories?: string[];
  platform?: ShadowBuildPlatform;
}): Promise<ShadowCacheManifest> {
  return (await buildCompositeShadowCache(options)).manifest;
}

export async function loadAndValidateShadowCache(shadowRoot: string, manifestPath: string): Promise<{ manifest: ShadowCacheManifest; manifestHash: string; fileCount: number }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ShadowCacheManifest;
  return { manifest, ...await validateShadowCache(shadowRoot, manifest) };
}

export interface OwnedCacheLink {
  linkPath: string;
  targetPath: string;
}

export interface OwnedLinkCleanupFileSystem {
  lstat(filePath: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(filePath: string): Promise<string>;
  unlink(filePath: string): Promise<void>;
}

export async function createOwnedRunCacheLink(options: {
  runRoot: string;
  linkPath: string;
  shadowRoot: string;
  appDataModelRoots: string[];
}): Promise<OwnedCacheLink> {
  assertRunCacheLinkTarget(options.shadowRoot, options.shadowRoot, options.appDataModelRoots);
  await assertNoReparseComponents(path.resolve(options.shadowRoot), "RUN_CACHE_LINK_TARGET_INVALID");
  const targetPath = await realpath(path.resolve(options.shadowRoot));
  const appDataRoots = await Promise.all(options.appDataModelRoots.map((root) => realpath(path.resolve(root))));
  if (appDataRoots.some((root) => within(root, targetPath))) throw new LocalizerError("RUN_CACHE_APPDATA_LINK_FORBIDDEN", "A run cache link cannot target an AppData model cache through an alias");
  const linkPath = path.resolve(options.linkPath);
  assertPathInside(normalizedRoot(options.runRoot, "OWNED_RUN_ROOT_UNSAFE"), linkPath);
  await symlink(targetPath, linkPath, "junction");
  return { linkPath, targetPath };
}

export async function cleanupOwnedCacheLinks(
  runRoot: string,
  links: OwnedCacheLink[],
  fileSystem: OwnedLinkCleanupFileSystem = { lstat, readlink, unlink },
): Promise<void> {
  const root = normalizedRoot(runRoot, "OWNED_RUN_ROOT_UNSAFE");
  for (const record of links) {
    const linkPath = path.resolve(record.linkPath);
    assertPathInside(root, linkPath);
    const info = await fileSystem.lstat(linkPath);
    if (!info.isSymbolicLink()) throw new LocalizerError("OWNED_LINK_IDENTITY_MISMATCH", "Cleanup target is no longer the link created by this run");
    const actualTarget = path.resolve(path.dirname(linkPath), await fileSystem.readlink(linkPath));
    if (!samePath(actualTarget, record.targetPath)) throw new LocalizerError("OWNED_LINK_IDENTITY_MISMATCH", "Cleanup link target changed; refusing to unlink it");
    await fileSystem.unlink(linkPath);
  }
}
