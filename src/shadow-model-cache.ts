import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalizerError } from "./errors.ts";
import { assertPathInside } from "./file-utils.ts";

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

function normalizedRoot(value: string, code: string): string {
  if (!value || value === "." || value === "..") throw new LocalizerError(code, "Cache root must be explicit and non-empty");
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved || resolved === path.resolve(process.cwd())) throw new LocalizerError(code, "Cache root cannot be a filesystem or working-directory root");
  return resolved;
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

async function hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_FILE_INVALID", "Model cache entries must be regular files, not links or reparse points");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest("hex") };
}

function assertExpected(actual: { size: number; sha256: string }, expected: ShadowCacheFile): void {
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Shadow cache manifest contains an invalid size or SHA-256");
  }
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow model cache content differs from its locked manifest");
  }
}

async function enumerateFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow model cache contains a symlink or junction");
    if (info.isDirectory()) result.push(...await enumerateFiles(root, childRelative));
    else if (info.isFile()) result.push(childRelative);
    else throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow model cache contains an unsupported filesystem entry");
  }
  return result.sort();
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
  if (resolvedTarget !== shadow) throw new LocalizerError("RUN_CACHE_LINK_TARGET_INVALID", "Each run may link only to the verified shadow cache root");
  if (appDataModelRoots.some((root) => within(root, resolvedTarget))) {
    throw new LocalizerError("RUN_CACHE_APPDATA_LINK_FORBIDDEN", "A run cache link cannot target an AppData model cache");
  }
  return resolvedTarget;
}

export async function validateShadowCache(shadowRoot: string, manifest: ShadowCacheManifest): Promise<{ manifestHash: string; fileCount: number }> {
  const root = await realpath(normalizedRoot(shadowRoot, "SHADOW_CACHE_ROOT_UNSAFE"));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow cache root must be a real directory");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Unsupported shadow cache manifest");
  const expectedPaths = new Set<string>();
  for (const entry of manifest.files) {
    const relative = safeRelative(entry.path);
    if (expectedPaths.has(relative)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Shadow cache manifest contains duplicate paths");
    expectedPaths.add(relative);
    const actual = await hashFile(path.join(root, relative));
    assertExpected(actual, entry);
    if (entry.hardlinkTo !== undefined) {
      const targetRelative = safeRelative(entry.hardlinkTo);
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
  const actualPaths = await enumerateFiles(root);
  if (actualPaths.length !== expectedPaths.size || actualPaths.some((item) => !expectedPaths.has(item))) {
    throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow model cache population changed; it must be rebuilt from locked sources");
  }
  const canonical = JSON.stringify({ schemaVersion: 1, files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) });
  return { manifestHash: createHash("sha256").update(canonical).digest("hex"), fileCount: manifest.files.length };
}

export async function buildShadowCache(options: {
  sourceRoot: string;
  shadowRoot: string;
  allowedBoundary: string;
  appDataModelRoots: string[];
  files: ShadowCopySpec[];
  manifestPath: string;
}): Promise<ShadowCacheManifest> {
  const sourceRoot = await realpath(normalizedRoot(options.sourceRoot, "MODEL_SOURCE_ROOT_UNSAFE"));
  const requestedShadow = normalizedRoot(options.shadowRoot, "SHADOW_CACHE_ROOT_UNSAFE");
  const shadowParent = await realpath(path.dirname(requestedShadow));
  const shadowRoot = path.join(shadowParent, path.basename(requestedShadow));
  const boundary = await realpath(normalizedRoot(options.allowedBoundary, "SHADOW_CACHE_BOUNDARY_UNSAFE"));
  const appDataModelRoots = await Promise.all(options.appDataModelRoots.map((root) => realpath(path.resolve(root))));
  assertPathInside(boundary, shadowRoot);
  if (appDataModelRoots.some((root) => within(root, shadowRoot))) throw new LocalizerError("SHADOW_CACHE_ROOT_IN_APPDATA", "Project-owned shadow cache must not live inside an AppData model cache");
  try {
    await lstat(shadowRoot);
    throw new LocalizerError("SHADOW_CACHE_ALREADY_EXISTS", "Shadow cache build target must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(shadowRoot, { recursive: false, mode: 0o700 });
  const manifest: ShadowCacheManifest = { schemaVersion: 1, files: [] };
  const seen = new Set<string>();
  for (const spec of options.files) {
    const relative = safeRelative(spec.path);
    if (seen.has(relative)) throw new LocalizerError("SHADOW_CACHE_MANIFEST_INVALID", "Shadow copy plan contains duplicate paths");
    seen.add(relative);
    const destination = path.join(shadowRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (spec.hardlinkTo !== undefined) {
      const targetRelative = safeRelative(spec.hardlinkTo);
      const target = path.join(shadowRoot, targetRelative);
      if (!seen.has(targetRelative)) throw new LocalizerError("SHADOW_CACHE_HARDLINK_ORDER_INVALID", "Internal hardlink target must be copied earlier in the build plan");
      assertShadowHardlinkAllowed(target, destination, shadowRoot, options.appDataModelRoots);
      await link(target, destination);
    } else {
      if (!spec.sourcePath) throw new LocalizerError("SHADOW_CACHE_SOURCE_MISSING", "Copied shadow cache entry requires a locked source path");
      const source = await realpath(path.resolve(spec.sourcePath));
      assertPathInside(sourceRoot, source);
      const before = await hashFile(source);
      assertExpected(before, spec);
      await copyFile(source, destination);
      const afterSource = await hashFile(source);
      assertExpected(afterSource, spec);
    }
    const copied = await hashFile(destination);
    assertExpected(copied, spec);
    manifest.files.push({ path: relative, size: spec.size, sha256: spec.sha256, ...(spec.hardlinkTo ? { hardlinkTo: safeRelative(spec.hardlinkTo) } : {}) });
  }
  await validateShadowCache(shadowRoot, manifest);
  const manifestResolved = path.resolve(options.manifestPath);
  assertPathInside(boundary, manifestResolved);
  await writeFile(manifestResolved, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
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
    if (actualTarget !== path.resolve(record.targetPath)) throw new LocalizerError("OWNED_LINK_IDENTITY_MISMATCH", "Cleanup link target changed; refusing to unlink it");
    await fileSystem.unlink(linkPath);
  }
}
