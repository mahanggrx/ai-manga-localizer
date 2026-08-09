import { inflateRawSync } from "node:zlib";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { LocalizerError } from "./errors.ts";
import { sha256Bytes } from "./file-utils.ts";
import type { InputImage, LocalizerConfig } from "./types.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function validateArchivePath(rawName: string): string {
  if (rawName.includes("\0") || rawName.includes("\ufffd")) throw new LocalizerError("ARCHIVE_INVALID_NAME", "Archive entry has an invalid name");
  const normalized = rawName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")) {
    throw new LocalizerError("ARCHIVE_ABSOLUTE_PATH", `Unsafe archive entry: ${rawName}`);
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === ".." || part === ".") throw new LocalizerError("ARCHIVE_TRAVERSAL", `Unsafe archive entry: ${rawName}`);
    if (part.includes(":")) throw new LocalizerError("ARCHIVE_ALTERNATE_STREAM", `Unsafe archive entry: ${rawName}`);
    if (part !== "" && (part.endsWith(".") || part.endsWith(" "))) throw new LocalizerError("ARCHIVE_AMBIGUOUS_PATH", `Unsafe archive entry: ${rawName}`);
  }
  return parts.filter(Boolean).join("/");
}

export function detectMediaType(fileName: string, bytes: Uint8Array): InputImage["mediaType"] {
  const ext = path.extname(fileName).toLowerCase();
  let mediaType: InputImage["mediaType"] | undefined;
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mediaType = "image/png";
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mediaType = "image/jpeg";
  else if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") mediaType = "image/webp";
  if (!mediaType) throw new LocalizerError("INVALID_IMAGE_MAGIC", `Unsupported or invalid image: ${fileName}`);
  const expected = mediaType === "image/png" ? new Set([".png"]) : mediaType === "image/jpeg" ? new Set([".jpg", ".jpeg"]) : new Set([".webp"]);
  if (!expected.has(ext)) throw new LocalizerError("IMAGE_EXTENSION_MISMATCH", `Image extension does not match content: ${fileName}`);
  return mediaType;
}

interface ZipCentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  localOffset: number;
}

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new LocalizerError("ZIP_EOCD_MISSING", "ZIP end-of-central-directory record not found");
}

function readCentralEntries(buffer: Buffer, limits: LocalizerConfig["archives"]): ZipCentralEntry[] {
  const eocd = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new LocalizerError("ZIP_MULTI_DISK", "Multi-disk ZIP archives are unsupported");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new LocalizerError("ZIP64_UNSUPPORTED", "ZIP64 archives are unsupported");
  if (totalEntries > limits.maxEntries) throw new LocalizerError("ZIP_TOO_MANY_ENTRIES", `Archive has ${totalEntries} entries`);
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw new LocalizerError("ZIP_CENTRAL_BOUNDS", "Invalid ZIP central directory bounds");

  const entries: ZipCentralEntry[] = [];
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new LocalizerError("ZIP_CENTRAL_INVALID", `Invalid central entry ${index}`);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || diskStart !== 0) throw new LocalizerError("ZIP_CENTRAL_INVALID", `Invalid central entry ${index}`);
    const name = validateArchivePath(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    if ((flags & 0x1) !== 0) throw new LocalizerError("ZIP_ENCRYPTED", `Encrypted entry is unsupported: ${name}`);
    if (method !== 0 && method !== 8) throw new LocalizerError("ZIP_COMPRESSION_UNSUPPORTED", `Unsupported compression method ${method}: ${name}`);
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (unixType === 0o120000) throw new LocalizerError("ZIP_SYMLINK", `Symbolic link entry is forbidden: ${name}`);
    if (uncompressedSize > limits.maxEntryBytes) throw new LocalizerError("ZIP_ENTRY_TOO_LARGE", `Entry exceeds size limit: ${name}`);
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) throw new LocalizerError("ZIP_TOTAL_TOO_LARGE", "Archive exceeds total uncompressed size limit");
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, externalAttributes, localOffset });
    offset = end;
  }
  return entries;
}

function inflateEntry(buffer: Buffer, entry: ZipCentralEntry, maxEntryBytes: number): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw new LocalizerError("ZIP_LOCAL_HEADER_INVALID", `Invalid local header: ${entry.name}`);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) throw new LocalizerError("ZIP_ENTRY_BOUNDS", `Invalid entry bounds: ${entry.name}`);
  const compressed = buffer.subarray(dataStart, dataEnd);
  const output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
  if (output.length !== entry.uncompressedSize) throw new LocalizerError("ZIP_SIZE_MISMATCH", `Size mismatch: ${entry.name}`);
  if (crc32(output) !== entry.crc) throw new LocalizerError("ZIP_CRC_MISMATCH", `CRC mismatch: ${entry.name}`);
  return output;
}

async function collectDirectoryFiles(root: string, current = root): Promise<string[]> {
  const rootResolved = path.resolve(root);
  const currentResolved = path.resolve(current);
  const relative = path.relative(rootResolved, currentResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new LocalizerError("INPUT_PATH_ESCAPE", currentResolved);
  const result: string[] = [];
  const entries = await readdir(currentResolved, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentResolved, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new LocalizerError("INPUT_REPARSE_POINT", `Symbolic links and junctions are unsupported: ${fullPath}`);
    if (entry.isDirectory()) result.push(...await collectDirectoryFiles(rootResolved, fullPath));
    else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(fullPath);
  }
  return result;
}

function toInputImage(fileName: string, bytes: Uint8Array): InputImage {
  return { fileName, mediaType: detectMediaType(fileName, bytes), bytes, sha256: sha256Bytes(bytes) };
}

export async function loadInputImages(inputPath: string, config: LocalizerConfig): Promise<{ kind: "directory" | "zip" | "cbz"; images: InputImage[] }> {
  const resolved = path.resolve(inputPath);
  const info = await lstat(resolved).catch((error) => {
    throw new LocalizerError("INPUT_NOT_FOUND", `Input not found: ${resolved}`, { cause: error });
  });
  if (info.isSymbolicLink()) throw new LocalizerError("INPUT_REPARSE_POINT", `Symbolic links and junctions are unsupported: ${resolved}`);
  let kind: "directory" | "zip" | "cbz";
  let images: InputImage[];
  if (info.isDirectory()) {
    kind = "directory";
    const files = (await collectDirectoryFiles(resolved)).sort(naturalCompare);
    images = await Promise.all(files.map(async (file) => toInputImage(path.relative(resolved, file).replace(/\\/g, "/"), await readFile(file))));
  } else if (info.isFile() && [".zip", ".cbz"].includes(path.extname(resolved).toLowerCase())) {
    kind = path.extname(resolved).toLowerCase() === ".cbz" ? "cbz" : "zip";
    const buffer = await readFile(resolved);
    images = readZipImagesBuffer(buffer, config);
  } else {
    throw new LocalizerError("INPUT_TYPE_UNSUPPORTED", "Input must be an image directory, ZIP, or CBZ");
  }
  if (images.length === 0) throw new LocalizerError("INPUT_HAS_NO_IMAGES", "No supported images found in input");
  if (images.length > config.archives.maxEntries) throw new LocalizerError("INPUT_TOO_MANY_IMAGES", `Input has ${images.length} images`);
  const total = images.reduce((sum, image) => sum + image.bytes.length, 0);
  if (total > config.archives.maxTotalBytes) throw new LocalizerError("INPUT_TOO_LARGE", "Input images exceed configured total size limit");
  return { kind, images };
}

export function readZipImagesBuffer(bytes: Uint8Array, config: LocalizerConfig): InputImage[] {
  const buffer = Buffer.from(bytes);
  const entries = readCentralEntries(buffer, config.archives)
    .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => naturalCompare(a.name, b.name));
  return entries.map((entry) => toInputImage(entry.name, inflateEntry(buffer, entry, config.archives.maxEntryBytes)));
}

function dosTimestamp(date = new Date()): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createCbzBuffer(files: Array<{ fileName: string; bytes: Uint8Array }>): Buffer {
  if (files.length > 0xffff) throw new LocalizerError("CBZ_TOO_MANY_FILES", "Too many files for ZIP32 output");
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosTimestamp();
  for (const file of files) {
    const safeName = validateArchivePath(file.fileName);
    const name = Buffer.from(safeName, "utf8");
    const data = Buffer.from(file.bytes);
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new LocalizerError("CBZ_ZIP64_REQUIRED", "Output is too large for ZIP32");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
