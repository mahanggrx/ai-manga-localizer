export type OcrHardSafetyReason =
  | "candidate-missing"
  | "normalized-empty"
  | "replacement-character"
  | "unpaired-surrogate"
  | "forbidden-control"
  | "bidi-control";

export interface OcrTextSafety {
  text?: string;
  normalized: string;
  hardReasons: OcrHardSafetyReason[];
  safe: boolean;
}

export const OCR_HARD_SAFETY_REASONS: readonly OcrHardSafetyReason[] = [
  "candidate-missing",
  "normalized-empty",
  "replacement-character",
  "unpaired-surrogate",
  "forbidden-control",
  "bidi-control",
];

const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function normalizeOcrText(text: string): string {
  return text.normalize("NFKC").replace(/\p{White_Space}+/gu, "");
}

export function inspectOcrText(text: string | undefined): OcrTextSafety {
  if (text === undefined) return { normalized: "", hardReasons: ["candidate-missing"], safe: false };
  const hardReasons: OcrHardSafetyReason[] = [];
  if (hasUnpairedSurrogate(text)) hardReasons.push("unpaired-surrogate");
  if (text.includes("\ufffd")) hardReasons.push("replacement-character");
  if (FORBIDDEN_CONTROL.test(text)) hardReasons.push("forbidden-control");
  if (BIDI_CONTROL.test(text)) hardReasons.push("bidi-control");
  const normalized = normalizeOcrText(text);
  if (normalized.length === 0) hardReasons.push("normalized-empty");
  return { text, normalized, hardReasons, safe: hardReasons.length === 0 };
}
