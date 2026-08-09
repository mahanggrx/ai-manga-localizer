import test from "node:test";
import assert from "node:assert/strict";
import { createCbzBuffer, crc32, naturalCompare, readZipImagesBuffer, validateArchivePath } from "../src/archive.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

test("CBZ writer round-trips safe images and natural order", () => {
  const cbz = createCbzBuffer([
    { fileName: "10.png", bytes: PNG },
    { fileName: "2.png", bytes: PNG },
  ]);
  const images = readZipImagesBuffer(cbz, DEFAULT_CONFIG);
  assert.deepEqual(images.map((image) => image.fileName), ["2.png", "10.png"]);
  assert.equal(images[0].mediaType, "image/png");
  assert.equal(crc32(images[0].bytes), crc32(PNG));
  assert.ok(naturalCompare("2.png", "10.png") < 0);
});

test("archive paths reject traversal, drive paths, ADS, and ambiguous names", () => {
  for (const name of ["../secret.png", "C:/secret.png", "/secret.png", "folder/file.png:stream", "folder./file.png"]) {
    assert.throws(() => validateArchivePath(name));
  }
  assert.equal(validateArchivePath("chapter/001.png"), "chapter/001.png");
});

test("ZIP reader detects corrupted entry bytes through CRC", () => {
  const cbz = createCbzBuffer([{ fileName: "001.png", bytes: PNG }]);
  const nameLength = cbz.readUInt16LE(26);
  const dataStart = 30 + nameLength;
  cbz[dataStart + PNG.length - 1] ^= 0xff;
  assert.throws(() => readZipImagesBuffer(cbz, DEFAULT_CONFIG), /CRC mismatch/);
});

