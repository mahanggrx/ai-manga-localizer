import { open, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalizerError } from "./errors.ts";
import {
  prepareScenePatch,
  prepareTranslatorBaseline,
  sceneFullHash,
  verifyPatchedScene,
  verifyTranslatorScene,
  type PreparedScenePatch,
  type TranslatorBaseline,
} from "./scene-integrity.ts";
import type { JsonValue, KoharuOperationSnapshot, KoharuSceneSnapshot, KoharuSourceTextPatch, PipelineRunRequest } from "./types.ts";

export const PRIVATE_JOURNAL_PHASES = [
  "PREPARED",
  "PATCH_INTENT",
  "PATCH_ACK",
  "PATCH_VERIFIED",
  "TRANSLATOR_INTENT",
  "TRANSLATOR_STARTED",
  "TRANSLATOR_FINISHED",
  "POST_TRANSLATOR_VERIFIED",
] as const;

export type PrivateJournalPhase = typeof PRIVATE_JOURNAL_PHASES[number];

export interface PrivateJournalEntry {
  schemaVersion: 1;
  sequence: number;
  phase: PrivateJournalPhase;
  recordedAt: string;
  epoch?: number;
  fullHash?: string;
  structureHash?: string;
  operationId?: string;
  count?: number;
  responseObserved?: boolean;
  allowedFields?: string[];
}

async function durableExclusiveJson(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const directory = await open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!["EISDIR", "EPERM", "EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

export async function readPrivateJournal(directory: string): Promise<PrivateJournalEntry[]> {
  const files = (await readdir(directory)).filter((name) => /^\d{2}-[A-Z_]+\.json$/.test(name)).sort();
  const entries: PrivateJournalEntry[] = [];
  for (const file of files) {
    const value = JSON.parse(await readFile(path.join(directory, file), "utf8")) as PrivateJournalEntry;
    const expectedPhase = PRIVATE_JOURNAL_PHASES[entries.length];
    if (
      value.schemaVersion !== 1
      || value.sequence !== entries.length
      || value.phase !== expectedPhase
      || file !== `${String(value.sequence).padStart(2, "0")}-${value.phase}.json`
      || typeof value.recordedAt !== "string"
    ) {
      throw new LocalizerError("PRIVATE_JOURNAL_CORRUPT", "Private runtime journal is missing, reordered, or inconsistent");
    }
    entries.push(value);
  }
  return entries;
}

export class DurablePrivateJournal {
  readonly directory: string;
  private entries: PrivateJournalEntry[] = [];

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async create(directory: string): Promise<DurablePrivateJournal> {
    const resolved = path.resolve(directory);
    if (path.parse(resolved).root === resolved) throw new LocalizerError("PRIVATE_JOURNAL_PATH_UNSAFE", "Private journal cannot use a filesystem root");
    await mkdir(resolved, { recursive: false, mode: 0o700 });
    return new DurablePrivateJournal(resolved);
  }

  async append(phase: PrivateJournalPhase, details: Omit<PrivateJournalEntry, "schemaVersion" | "sequence" | "phase" | "recordedAt"> = {}): Promise<PrivateJournalEntry> {
    const expected = PRIVATE_JOURNAL_PHASES[this.entries.length];
    if (phase !== expected) throw new LocalizerError("PRIVATE_JOURNAL_SEQUENCE_INVALID", `Expected private journal phase ${expected ?? "END"}`);
    const entry: PrivateJournalEntry = {
      schemaVersion: 1,
      sequence: this.entries.length,
      phase,
      recordedAt: new Date().toISOString(),
      ...details,
    };
    await durableExclusiveJson(path.join(this.directory, `${String(entry.sequence).padStart(2, "0")}-${phase}.json`), entry);
    this.entries.push(entry);
    return entry;
  }

  async writePatch(patches: KoharuSourceTextPatch[]): Promise<string> {
    const filePath = path.join(this.directory, "source-text-patch.private.json");
    await durableExclusiveJson(filePath, { schemaVersion: 1, patches });
    return filePath;
  }

  async quarantine(code: string): Promise<void> {
    await durableExclusiveJson(path.join(this.directory, "quarantine.private.json"), {
      schemaVersion: 1,
      code,
      recordedAt: new Date().toISOString(),
    });
  }

  phases(): PrivateJournalPhase[] {
    return this.entries.map((entry) => entry.phase);
  }
}

function operationStatus(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of ["status", "state", "result"]) if (typeof value[key] === "string") return (value[key] as string).toLowerCase();
  for (const key of ["operation", "job", "data"]) {
    const nested = operationStatus(value[key]);
    if (nested) return nested;
  }
  return undefined;
}

function terminalStatus(status: string): boolean {
  return ["finished", "completed", "success", "succeeded", "failed", "error", "cancelled"].some((item) => status.includes(item));
}

export function assertOperationsIdle(snapshot: KoharuOperationSnapshot): void {
  for (const operation of snapshot.operations) {
    const status = operationStatus(operation);
    if (!status || !terminalStatus(status)) throw new LocalizerError("KOHARU_OPERATIONS_ACTIVE", "Koharu has an active or unrecognized operation");
  }
}

export interface SceneMutationClient {
  getSceneSnapshot(): Promise<KoharuSceneSnapshot>;
  getOperationSnapshot(): Promise<KoharuOperationSnapshot>;
  applySourceTextBatch(epoch: number, patches: KoharuSourceTextPatch[], label: string): Promise<{ epoch: number }>;
  startPipeline(request: PipelineRunRequest): Promise<string>;
  waitForOperation(id: string): Promise<{ warnings: string[] }>;
}

export interface StableReadOptions {
  attempts?: number;
  delayMs?: number;
}

export async function readStableScene(
  client: Pick<SceneMutationClient, "getSceneSnapshot" | "getOperationSnapshot">,
  assertIdentity: () => Promise<void>,
  options: StableReadOptions = {},
): Promise<KoharuSceneSnapshot> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 250;
  let previous: KoharuSceneSnapshot | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await assertIdentity();
    const operations = await client.getOperationSnapshot();
    try {
      assertOperationsIdle(operations);
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
      if (delayMs > 0) await delay(delayMs);
      previous = undefined;
      continue;
    }
    const current = await client.getSceneSnapshot();
    if (previous && sceneFullHash(previous) === sceneFullHash(current)) return current;
    previous = current;
    if (delayMs > 0) await delay(delayMs);
  }
  throw new LocalizerError("KOHARU_SCENE_NOT_STABLE", "Koharu scene did not produce two consecutive stable reads");
}

export interface OwnedMutationGuard {
  assertIdentity(): Promise<void>;
  assertProjectIdentity(snapshot?: KoharuSceneSnapshot): Promise<void>;
}

async function rereadAfterMutation(client: SceneMutationClient, guard: OwnedMutationGuard, stableRead?: StableReadOptions): Promise<KoharuSceneSnapshot> {
  await guard.assertIdentity();
  await guard.assertProjectIdentity();
  const snapshot = await readStableScene(client, async () => {
    await guard.assertIdentity();
    await guard.assertProjectIdentity();
  }, stableRead);
  await guard.assertProjectIdentity(snapshot);
  return snapshot;
}

export async function applyOwnedScenePatch(options: {
  client: SceneMutationClient;
  guard: OwnedMutationGuard;
  journal: DurablePrivateJournal;
  selected: Array<{ pageId: string; regionId: string; selectedSourceText: string }>;
  stableRead?: StableReadOptions;
}): Promise<{ plan: PreparedScenePatch; snapshot: KoharuSceneSnapshot; responseObserved: boolean }> {
  const before = await rereadAfterMutation(options.client, options.guard, options.stableRead);
  const plan = prepareScenePatch(before, options.selected);
  await options.journal.append("PREPARED", {
    epoch: plan.epoch,
    fullHash: plan.beforeFullHash,
    structureHash: plan.beforeStructureHash,
    count: plan.changedCount,
    allowedFields: ["scene.pages[*].nodes[*].kind.text.text"],
  });
  await options.journal.writePatch(plan.patches);
  await options.journal.append("PATCH_INTENT", { epoch: plan.epoch, count: plan.changedCount });

  let responseObserved = false;
  let responseEpoch: number | undefined;
  let requestError: unknown;
  if (plan.patches.length > 0) {
    try {
      await options.guard.assertIdentity();
      await options.guard.assertProjectIdentity(before);
      const response = await options.client.applySourceTextBatch(plan.epoch, plan.patches, "manga-localizer selected OCR source text");
      responseObserved = true;
      responseEpoch = response.epoch;
    } catch (error) {
      requestError = error;
    }
  } else {
    responseObserved = true;
    responseEpoch = plan.epoch;
  }

  let actual: KoharuSceneSnapshot;
  try {
    actual = await rereadAfterMutation(options.client, options.guard, options.stableRead);
    verifyPatchedScene(plan, actual);
    if (
      !responseObserved
      && requestError instanceof LocalizerError
      && ["KOHARU_HTTP_ERROR", "KOHARU_EPOCH_CONFLICT", "KOHARU_BOOTSTRAPPING"].includes(requestError.code)
    ) {
      throw new LocalizerError("KOHARU_SCENE_PATCH_SERVER_ERROR", "Scene matched in memory after a server-side error, but durable history persistence was not proven");
    }
    if (responseObserved && responseEpoch !== plan.expectedEpoch) {
      throw new LocalizerError("KOHARU_SCENE_PATCH_RESPONSE_EPOCH", "History response epoch disagrees with the verified scene epoch");
    }
  } catch (error) {
    await options.journal.quarantine((error as { code?: string }).code ?? "KOHARU_SCENE_PATCH_QUARANTINED");
    throw error;
  }
  await options.journal.append("PATCH_ACK", { epoch: actual.epoch, count: plan.changedCount, responseObserved });
  await options.journal.append("PATCH_VERIFIED", { epoch: actual.epoch, fullHash: sceneFullHash(actual), count: plan.selectedCount });
  if (requestError && !responseObserved) {
    // The exact readback proves the one intended Batch completed despite a lost
    // response. No retry is issued because Batch is not atomic in Koharu 0.61.2.
  }
  return { plan, snapshot: actual, responseObserved };
}

export async function runOwnedTranslator(options: {
  client: SceneMutationClient;
  guard: OwnedMutationGuard;
  journal: DurablePrivateJournal;
  expectedPatchedSnapshot: KoharuSceneSnapshot;
  selected: Array<{ pageId: string; regionId: string; selectedSourceText: string }>;
  request: PipelineRunRequest;
  stableRead?: StableReadOptions;
}): Promise<{ snapshot: KoharuSceneSnapshot; baseline: TranslatorBaseline; operationId: string; warnings: string[] }> {
  const before = await rereadAfterMutation(options.client, options.guard, options.stableRead);
  if (sceneFullHash(before) !== sceneFullHash(options.expectedPatchedSnapshot)) {
    throw new LocalizerError("KOHARU_TRANSLATOR_PRECONDITION_DRIFT", "Scene changed after patch verification and before translator intent");
  }
  const pages = options.request.pages ?? [];
  const nodeIds = options.request.textNodeIds ?? [];
  if (nodeIds.length !== options.selected.length || new Set(nodeIds).size !== nodeIds.length || options.selected.some((item) => !nodeIds.includes(item.regionId))) {
    throw new LocalizerError("KOHARU_TRANSLATOR_TARGET_INVALID", "Translator request must contain every selected text node id exactly once");
  }
  const baseline = prepareTranslatorBaseline(before, options.selected, pages);
  await options.journal.append("TRANSLATOR_INTENT", {
    epoch: before.epoch,
    fullHash: baseline.fullHash,
    count: nodeIds.length,
    allowedFields: ["scene.pages[target].nodes[selected].kind.text.translation"],
  });
  await options.guard.assertIdentity();
  await options.guard.assertProjectIdentity(before);
  let operationId: string;
  try {
    operationId = await options.client.startPipeline(options.request);
  } catch (error) {
    try { await rereadAfterMutation(options.client, options.guard, options.stableRead); } catch { /* journal state remains authoritative */ }
    await options.journal.quarantine("KOHARU_TRANSLATOR_START_OUTCOME_UNKNOWN");
    throw error;
  }
  await options.journal.append("TRANSLATOR_STARTED", { epoch: before.epoch, operationId, count: nodeIds.length });
  let result: { warnings: string[] };
  try {
    result = await options.client.waitForOperation(operationId);
  } catch (error) {
    try { await rereadAfterMutation(options.client, options.guard, options.stableRead); } catch { /* fail closed below */ }
    await options.journal.quarantine("KOHARU_TRANSLATOR_OUTCOME_UNKNOWN");
    throw error;
  }
  await options.journal.append("TRANSLATOR_FINISHED", { operationId, count: pages.length });
  let after: KoharuSceneSnapshot;
  try {
    after = await rereadAfterMutation(options.client, options.guard, options.stableRead);
    verifyTranslatorScene(baseline, after);
  } catch (error) {
    await options.journal.quarantine((error as { code?: string }).code ?? "KOHARU_TRANSLATOR_POSTCONDITION_FAILED");
    throw error;
  }
  await options.journal.append("POST_TRANSLATOR_VERIFIED", { epoch: after.epoch, fullHash: sceneFullHash(after), count: nodeIds.length });
  return { snapshot: after, baseline, operationId, warnings: result.warnings };
}

export type CrashDisposition =
  | "patch-not-started"
  | "patch-outcome-unknown"
  | "patch-partial"
  | "patch-complete-translator-not-started"
  | "translator-outcome-unknown"
  | "translator-complete-unverified"
  | "post-translator-verified";

export function classifyPatchReadback(plan: PreparedScenePatch, snapshot: KoharuSceneSnapshot): "before" | "patched" | "partial" {
  const hash = sceneFullHash(snapshot);
  if (hash === plan.beforeFullHash) return "before";
  if (hash === plan.expectedFullHash) return "patched";
  return "partial";
}

export function classifyCrash(phases: PrivateJournalPhase[], readback: "before" | "partial" | "patched" | "translated"): CrashDisposition {
  const last = phases.at(-1);
  if (!last || last === "PREPARED") return "patch-not-started";
  if (last === "PATCH_INTENT" || last === "PATCH_ACK") {
    if (readback === "before") return last === "PATCH_INTENT" ? "patch-not-started" : "patch-outcome-unknown";
    if (readback === "partial") return "patch-partial";
    if (readback === "patched") return "patch-complete-translator-not-started";
    return "translator-outcome-unknown";
  }
  if (last === "PATCH_VERIFIED" || last === "TRANSLATOR_INTENT") return "patch-complete-translator-not-started";
  if (last === "TRANSLATOR_STARTED") return readback === "translated" ? "translator-complete-unverified" : "translator-outcome-unknown";
  if (last === "TRANSLATOR_FINISHED") return "translator-complete-unverified";
  return "post-translator-verified";
}
