import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalizerError } from "../src/errors.ts";
import { applyOwnedScenePatch, classifyCrash, DurablePrivateJournal, readPrivateJournal, runOwnedTranslator, type SceneMutationClient } from "../src/scene-patch.ts";
import { prepareScenePatch, verifyPatchedScene } from "../src/scene-integrity.ts";
import type { KoharuSceneSnapshot, KoharuSourceTextPatch, PipelineRunRequest } from "../src/types.ts";

function scene(epoch = 7): KoharuSceneSnapshot {
  return {
    epoch,
    scene: {
      project: { id: "project-owned" },
      pages: {
        p1: {
          id: "p1", width: 1000, height: 1400, image: { blob: "a".repeat(64) },
          nodes: { r1: { id: "r1", transform: { x: 1, y: 2, width: 30, height: 40, rotationDeg: 0 }, mask: { blob: "b".repeat(64) }, kind: { text: { text: "old-1" } } } },
        },
        p2: {
          id: "p2", width: 1000, height: 1400, image: { blob: "c".repeat(64) },
          nodes: { r2: { id: "r2", transform: { x: 3, y: 4, width: 50, height: 60, rotationDeg: 0 }, kind: { text: { text: "old-2" } } } },
        },
      },
      unknownRootField: { preserved: true },
    },
  };
}

function text(snapshot: KoharuSceneSnapshot, pageId: string, nodeId: string): Record<string, unknown> {
  const pages = snapshot.scene.pages as Record<string, unknown>;
  const page = pages[pageId] as Record<string, unknown>;
  const nodes = page.nodes as Record<string, unknown>;
  const node = nodes[nodeId] as Record<string, unknown> | undefined;
  if (!node) return assert.fail("node missing");
  const kind = node.kind as Record<string, unknown>;
  return kind.text as Record<string, unknown>;
}

const selected = [
  { pageId: "p1", regionId: "r1", selectedSourceText: "selected-1" },
  { pageId: "p2", regionId: "r2", selectedSourceText: "selected-2" },
];

function guard() {
  return { async assertIdentity() {}, async assertProjectIdentity() {} };
}

class FakeClient implements SceneMutationClient {
  current = scene();
  applyBehavior: (epoch: number, patches: KoharuSourceTextPatch[]) => Promise<{ epoch: number }> = async (epoch, patches) => {
    for (const patch of patches) text(this.current, patch.pageId, patch.nodeId).text = patch.sourceText;
    this.current.epoch = epoch + 1;
    return { epoch: this.current.epoch };
  };
  translatorBehavior: (request: PipelineRunRequest) => void = () => undefined;
  started = 0;
  async getSceneSnapshot() { return structuredClone(this.current); }
  async getOperationSnapshot() { return { operations: [] }; }
  async applySourceTextBatch(epoch: number, patches: KoharuSourceTextPatch[]) { return await this.applyBehavior(epoch, patches); }
  async startPipeline(request: PipelineRunRequest) { this.started += 1; this.translatorBehavior(request); return "translator-op"; }
  async waitForOperation() { return { warnings: [] }; }
}

async function journal(name: string): Promise<DurablePrivateJournal> {
  const root = await mkdtemp(path.join(os.tmpdir(), `m3-8-${name}-`));
  return await DurablePrivateJournal.create(path.join(root, "journal"));
}

test("scene patch verifies raw selected text and preserves every other field", () => {
  const before = scene();
  const plan = prepareScenePatch(before, selected);
  assert.equal(plan.changedCount, 2);
  verifyPatchedScene(plan, plan.expectedScene);
  const unknownDrift = structuredClone(plan.expectedScene);
  (unknownDrift.scene.unknownRootField as Record<string, unknown>).preserved = false;
  assert.throws(() => verifyPatchedScene(plan, unknownDrift), (error: unknown) => (error as { code?: string }).code === "KOHARU_SCENE_PATCH_QUARANTINED");
  const reordered = structuredClone(plan.expectedScene);
  const pages = reordered.scene.pages as Record<string, unknown>;
  reordered.scene.pages = { p2: pages.p2 as never, p1: pages.p1 as never };
  assert.throws(() => verifyPatchedScene(plan, reordered), (error: unknown) => (error as { code?: string }).code === "KOHARU_SCENE_PATCH_QUARANTINED");
});

test("lost Batch response is accepted only after exact stable readback and is never retried", async () => {
  const client = new FakeClient();
  let calls = 0;
  client.applyBehavior = async (epoch, patches) => {
    calls += 1;
    for (const patch of patches) text(client.current, patch.pageId, patch.nodeId).text = patch.sourceText;
    client.current.epoch = epoch + 1;
    throw new LocalizerError("KOHARU_TIMEOUT", "synthetic response loss");
  };
  const result = await applyOwnedScenePatch({ client, guard: guard(), journal: await journal("lost"), selected, stableRead: { delayMs: 0 } });
  assert.equal(result.responseObserved, false);
  assert.equal(calls, 1);
  assert.equal(result.snapshot.epoch, 8);
});

test("server error cannot prove durable history even when in-memory scene matches", async () => {
  const client = new FakeClient();
  const privateJournal = await journal("server-error");
  client.applyBehavior = async (epoch, patches) => {
    for (const patch of patches) text(client.current, patch.pageId, patch.nodeId).text = patch.sourceText;
    client.current.epoch = epoch + 1;
    throw new LocalizerError("KOHARU_HTTP_ERROR", "synthetic server persistence error", { status: 500 });
  };
  await assert.rejects(
    () => applyOwnedScenePatch({ client, guard: guard(), journal: privateJournal, selected, stableRead: { delayMs: 0 } }),
    (error: unknown) => (error as { code?: string }).code === "KOHARU_SCENE_PATCH_SERVER_ERROR",
  );
});

test("Batch partial apply, unchanged epoch, extra epoch, and unknown changes all quarantine", async (t) => {
  const cases: Array<[string, (client: FakeClient, epoch: number, patches: KoharuSourceTextPatch[]) => void]> = [
    ["mid-batch", (client, _epoch, patches) => { text(client.current, patches[0].pageId, patches[0].nodeId).text = patches[0].sourceText; }],
    ["unchanged-epoch", (client, _epoch, patches) => { for (const patch of patches) text(client.current, patch.pageId, patch.nodeId).text = patch.sourceText; }],
    ["extra-epoch", (client, epoch, patches) => { for (const patch of patches) text(client.current, patch.pageId, patch.nodeId).text = patch.sourceText; client.current.epoch = epoch + 2; }],
    ["unknown-field", (client, epoch, patches) => { for (const patch of patches) text(client.current, patch.pageId, patch.nodeId).text = patch.sourceText; client.current.epoch = epoch + 1; client.current.scene.unexpected = true; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const client = new FakeClient();
    const privateJournal = await journal(name);
    client.applyBehavior = async (epoch, patches) => { mutate(client, epoch, patches); throw new Error("ambiguous Batch outcome"); };
    await assert.rejects(
      () => applyOwnedScenePatch({ client, guard: guard(), journal: privateJournal, selected, stableRead: { delayMs: 0 } }),
      (error: unknown) => (error as { code?: string }).code === "KOHARU_SCENE_PATCH_QUARANTINED",
    );
  });
});

async function patchedClient(name: string): Promise<{ client: FakeClient; journal: DurablePrivateJournal; patched: KoharuSceneSnapshot }> {
  const client = new FakeClient();
  const privateJournal = await journal(name);
  const result = await applyOwnedScenePatch({ client, guard: guard(), journal: privateJournal, selected, stableRead: { delayMs: 0 } });
  return { client, journal: privateJournal, patched: result.snapshot };
}

test("translator starts only after PATCH_VERIFIED and exact target ids are sent", async () => {
  const fixture = await patchedClient("translator-success");
  fixture.client.translatorBehavior = (request) => {
    assert.deepEqual(request.textNodeIds, ["r1", "r2"]);
    assert.equal(fixture.journal.phases().at(-1), "TRANSLATOR_INTENT");
  };
  fixture.client.waitForOperation = async () => {
    text(fixture.client.current, "p1", "r1").translation = "translated-1";
    text(fixture.client.current, "p2", "r2").translation = "translated-2";
    fixture.client.current.epoch += 2;
    return { warnings: [] };
  };
  const result = await runOwnedTranslator({
    client: fixture.client,
    guard: guard(),
    journal: fixture.journal,
    expectedPatchedSnapshot: fixture.patched,
    selected,
    request: { steps: ["translator"], pages: ["p1", "p2"], textNodeIds: ["r1", "r2"] },
    stableRead: { delayMs: 0 },
  });
  assert.equal(result.snapshot.epoch, 10);
  assert.equal(fixture.journal.phases().at(-1), "POST_TRANSLATOR_VERIFIED");
  const entries = await readPrivateJournal(fixture.journal.directory);
  assert.deepEqual(entries.map((entry) => entry.phase), fixture.journal.phases());
  assert.doesNotMatch(JSON.stringify(entries), /selected-1|selected-2|translated-1|translated-2/);
});

test("translator partial pages, source rewrite, and unknown field changes fail closed", async (t) => {
  for (const kind of ["partial", "source", "unknown"] as const) await t.test(kind, async () => {
    const fixture = await patchedClient(`translator-${kind}`);
    fixture.client.waitForOperation = async () => {
      text(fixture.client.current, "p1", "r1").translation = "translated-1";
      if (kind !== "partial") text(fixture.client.current, "p2", "r2").translation = "translated-2";
      fixture.client.current.epoch += kind === "partial" ? 1 : 2;
      if (kind === "source") text(fixture.client.current, "p1", "r1").text = "rewritten";
      if (kind === "unknown") fixture.client.current.scene.newUnknown = { changed: true };
      return { warnings: [] };
    };
    await assert.rejects(
      () => runOwnedTranslator({
        client: fixture.client, guard: guard(), journal: fixture.journal, expectedPatchedSnapshot: fixture.patched, selected,
        request: { steps: ["translator"], pages: ["p1", "p2"], textNodeIds: ["r1", "r2"] }, stableRead: { delayMs: 0 },
      }),
      (error: unknown) => ["KOHARU_TRANSLATOR_EPOCH_MISMATCH", "KOHARU_TRANSLATOR_SOURCE_REWRITTEN", "KOHARU_TRANSLATOR_SCENE_DRIFT"].includes((error as { code?: string }).code ?? ""),
    );
  });
});

test("translator precondition drift blocks POST", async () => {
  const fixture = await patchedClient("translator-precondition");
  fixture.client.current.epoch += 1;
  await assert.rejects(
    () => runOwnedTranslator({
      client: fixture.client, guard: guard(), journal: fixture.journal, expectedPatchedSnapshot: fixture.patched, selected,
      request: { steps: ["translator"], pages: ["p1", "p2"], textNodeIds: ["r1", "r2"] }, stableRead: { delayMs: 0 },
    }),
    (error: unknown) => (error as { code?: string }).code === "KOHARU_TRANSLATOR_PRECONDITION_DRIFT",
  );
  assert.equal(fixture.client.started, 0);
});

test("crash journal states distinguish patch and translator outcomes", () => {
  assert.equal(classifyCrash(["PREPARED"], "before"), "patch-not-started");
  assert.equal(classifyCrash(["PREPARED", "PATCH_INTENT"], "before"), "patch-not-started");
  assert.equal(classifyCrash(["PREPARED", "PATCH_INTENT"], "partial"), "patch-partial");
  assert.equal(classifyCrash(["PREPARED", "PATCH_INTENT"], "patched"), "patch-complete-translator-not-started");
  assert.equal(classifyCrash(["PREPARED", "PATCH_INTENT", "PATCH_ACK", "PATCH_VERIFIED", "TRANSLATOR_INTENT", "TRANSLATOR_STARTED", "TRANSLATOR_FINISHED"], "translated"), "translator-complete-unverified");
  assert.equal(classifyCrash(["PREPARED", "PATCH_INTENT", "PATCH_ACK", "PATCH_VERIFIED", "TRANSLATOR_INTENT", "TRANSLATOR_STARTED", "TRANSLATOR_FINISHED", "POST_TRANSLATOR_VERIFIED"], "translated"), "post-translator-verified");
});
