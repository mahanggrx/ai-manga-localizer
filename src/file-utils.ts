import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalizerError } from "./errors.ts";

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 80);
  return slug || "chapter";
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function createUniqueDirectory(parent: string, prefix: string): Promise<{ directory: string; runId: string }> {
  const resolvedParent = path.resolve(parent);
  if (path.parse(resolvedParent).root === resolvedParent) {
    throw new LocalizerError("UNSAFE_OUTPUT_ROOT", "Refusing to use a drive root as the output parent");
  }
  try {
    const existing = await stat(resolvedParent);
    if (!existing.isDirectory()) throw new LocalizerError("OUTPUT_PARENT_NOT_DIRECTORY", resolvedParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(resolvedParent, { recursive: true });
  }

  const runId = randomUUID();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = attempt === 0 ? randomBytes(3).toString("hex") : randomBytes(5).toString("hex");
    const candidate = path.join(resolvedParent, `${safeSlug(prefix)}-${timestampForPath()}-${suffix}`);
    try {
      await mkdir(candidate, { recursive: false });
      return { directory: candidate, runId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new LocalizerError("UNIQUE_OUTPUT_FAILED", "Could not allocate a unique output directory");
}

export function assertPathInside(parent: string, child: string): void {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new LocalizerError("PATH_OUTSIDE_BOUNDARY", `Path is outside allowed boundary: ${childPath}`);
}

export async function writeExclusive(filePath: string, data: Uint8Array | string): Promise<void> {
  await writeFile(filePath, data, { flag: "wx" });
}

export async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  await writeExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

