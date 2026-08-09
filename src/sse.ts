import type { JsonValue } from "./types.ts";

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
  json?: JsonValue;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const build = (): SseMessage | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    let json: JsonValue | undefined;
    try { json = JSON.parse(data) as JsonValue; } catch { /* non-JSON SSE is valid */ }
    const message = { id: eventId, event: eventName, data, json };
    eventName = undefined;
    dataLines = [];
    return message;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const message = build();
          if (message) yield message;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
        if (field === "event") eventName = fieldValue;
        else if (field === "id" && !fieldValue.includes("\0")) eventId = fieldValue;
        else if (field === "data") dataLines.push(fieldValue);
      }
      if (done) break;
    }
    const message = build();
    if (message) yield message;
  } finally {
    reader.releaseLock();
  }
}

