import test from "node:test";
import assert from "node:assert/strict";
import { assertLocalTranslationTarget } from "../src/local-translation.ts";

const target = { kind: "provider" as const, providerId: "openai-compatible", modelId: "murasaki" };

test("primary OpenAI-compatible target must resolve to a configured loopback URL", () => {
  assert.doesNotThrow(() => assertLocalTranslationTarget(target, {
    providers: [{ id: "openai-compatible", base_url: "http://127.0.0.1:8080/v1" }],
  }));
  assert.throws(
    () => assertLocalTranslationTarget(target, { providers: [{ id: "openai-compatible", baseUrl: "https://example.com/v1" }] }),
    (error: unknown) => (error as { code?: string }).code === "LOCAL_TRANSLATOR_REMOTE_FORBIDDEN",
  );
  assert.throws(
    () => assertLocalTranslationTarget(target, { providers: [] }),
    (error: unknown) => (error as { code?: string }).code === "LOCAL_TRANSLATOR_PROVIDER_MISSING",
  );
});

test("Koharu built-in local targets do not require a provider", () => {
  assert.doesNotThrow(() => assertLocalTranslationTarget({ kind: "local", modelId: "sakura" }, {}));
});
