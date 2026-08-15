# AI Manga Localizer — Project Plan

Last updated: 2026-08-15

## Current phase

The project is in **M4.0/M4.1 Offline Translation Benchmark Contract**.

The engineering skeleton, M1 bubble-mask adapter, M2 routing regression, and category-free M3 OCR runtime contract are established. M3.10A has materialized and verified the real composite shadow. M3.10B resource-policy v2.1 is at `EXECUTABLE_NOT_RUN`; the real three-page owned-process smoke remains deliberately deferred. M4.0/M4.1 now provides a fixed-working-gold, versioned offline translation benchmark contract and a preregistered compact challenge, without starting Koharu, a model server, a model, or the GPU.

This document is the public, repository-level source of truth for project direction. Private images, OCR text, translations, prompts, model files, and review data remain outside Git. Aggregate measurements may be recorded here when they do not expose private content.

## Product goal

Build a local-first Japanese manga to Simplified Chinese quality orchestrator that approaches careful personal scanlation quality while preserving editable project output and failing closed when automation could damage the page.

V1 remains focused on:

- personal, non-commercial, local use;
- image directories, ZIP, and CBZ input;
- Simplified Chinese output;
- ordinary dialogue and narration replacement;
- preservation-first handling of large artistic sound effects;
- rendered images, CBZ, KHR, report, and optional PSD output;
- an RTX 4060 Laptop GPU with 8 GB VRAM as the reference machine.

Hosted services, accounts, payments, public content distribution, and PDF input are outside V1.

## Evidence available today

### Working gold

The private `review-v5` set contains 50 pages and 388 reviewed regions. It has received page-by-page AI visual review, OCR candidate comparison, Japanese correction, reference translation, and layout assessment.

For current personal research it is a **working gold** suitable for:

- comparing candidate routes;
- counting error types;
- extracting hard cases;
- module-level analysis;
- selecting a V1 architecture.

It is not a final professional benchmark validated by multiple independent human reviewers. Ambiguous or decision-critical samples may receive targeted human spot checks later; a full 50-page relabel is not a prerequisite for V1 selection.

### Verified local runs

The following evidence has been observed locally:

- Koharu 0.61.2 is installed and has completed real local runs.
- A three-page GPU safety regression verified successful rendering and byte-identical preservation of protected pages.
- One 50-page Koharu candidate baseline completed with editable and rendered artifacts.
- PaddleOCR-VL 1.6 and Manga OCR candidates were both captured for the baseline.
- A Sakura-family model produced the only complete 50-page historical E2E translation baseline so far; it used legacy OCR inputs and is not a fixed-working-gold OCR model score.
- Murasaki-8B-v0.2 IQ4_XS has been tested through multiple integration routes, but no Murasaki route has yet produced a complete, competitive controlled baseline.
- MangaTranslator integration can partially render pages, but current smoke results do not justify adopting it as the V1 chassis.
- A real Koharu scene probe verified that speech-bubble segmentation is persisted as page-sized, integer-labelled `role=bubble` WebP masks.

### Baseline measurements

The 50-page working-gold comparison currently shows:

| Measurement | Observed baseline |
| --- | ---: |
| Detection recall | 387 / 388 (99.74%) |
| Selected OCR regions at CER <= 3% | 80.41% |
| Historical E2E semantic usability under mixed OCR inputs | 240 / 388 (61.86%) |
| Historical E2E terminology correctness under mixed OCR inputs | 240 / 388 (61.86%) |
| Historical E2E layout usability under mixed OCR inputs | 271 / 388 (69.85%) |
| Strict no-edit pages | 3 / 50 (6%) |
| Mean repair and lettering score | 2.84 / 5 |
| Repair and lettering page-score distribution | 1: 3, 2: 11, 3: 27, 4: 9 |

These are diagnostic measurements, not release claims.

The current deterministic QA detected only 31 of 148 semantic failures. It is useful for malformed output, residual Japanese, length anomalies, token loss, overflow risk, and related structural checks, but it is not a semantic judge.

### OCR evidence

Raw confidence comparison is not a valid cross-model selector. In the current baseline it selected Manga OCR for every available region even though the engines have different failure profiles.

| OCR engine | Available / eligible | Exact among available | Corpus CER among available | Coverage-adjusted CER |
| --- | ---: | ---: | ---: | ---: |
| PaddleOCR-VL 1.6 | 383 / 384 | 289 / 383 (75.46%) | 300 / 5,772 (5.20%) | 327 / 5,799 (5.64%) |
| Manga OCR | 384 / 384 | 311 / 384 (80.99%) | 1,241 / 5,799 (21.40%) | 1,241 / 5,799 (21.40%) |

Manga OCR performs well on many ordinary, dense, and stylized regions but has severe long-tail errors on dark-complex and structural-negative pages. PaddleOCR-VL is more robust on those page classes. The evidence supports a calibrated or type-aware selector, not a single universal engine and not direct raw-confidence comparison.

### Bubble-mask evidence

A three-page Koharu 0.61.2 live probe found:

- 42 text nodes;
- one `role=bubble` mask and one `role=segment` mask per page;
- no direct `insideBubble`, `regionType`, `semanticRole`, panel, or relation fields;
- bubble masks with the same dimensions as their pages;
- label value `0` for background and non-zero integer labels consistent with distinct bubble instances;
- text-region bubble hits of 10/10, 1/5, and 5/27 across the three pages.

The follow-up 50-page live scene probe found 387 text nodes and 387 null `linePolygons` fields. The real adapter route therefore used transform bboxes for all 387 detected nodes. Koharu 0.61.2 Anime Text, Comic Text Detector, Comic Text & Bubble Detector, and PP-DocLayout were also verified not to populate effective non-empty `linePolygons` on text nodes. No detection-only run is needed or planned because it would not validate a geometry route that these engines do not produce.

Koharu therefore provides native bubble-mask evidence, and the M1 adapter now consumes it with explicit geometry provenance. M2 verifies that `unknown -> replace` is no longer the default because unidentified artistic or structural text must not be erased.

### Existing-data routing regression

The M2 offline replay associated the existing 50-page KHR with review-v5 by serialized page UUID and content-addressed mask references. Each page had two page-sized label masks. The first multi-instance slot was treated as the bubble mask and the second binary slot as the segment mask. This inference reproduced the prior three-page live probe exactly: 10/10, 1/5, and 5/27 bubble hits.

Using thresholds of 0.80 for inside-bubble and 0.05 for outside-bubble, the Koharu 0.61.2 bbox production-route replay found:

| Measurement | Detected regions | All reviewed regions |
| --- | ---: | ---: |
| Bubble-contained ordinary dialogue | 317 / 387 (81.91%) | 317 / 388 (81.70%) |
| Bubble-external text | 70 / 387 (18.09%) | 71 / 388 (18.30%) |
| Geometrically uncertain | 0 / 387 (0%) | 0 / 388 (0%) |
| `unknown -> replace` violations | 0 | 0 |

All 70 detected bubble-external regions now resolve to runtime role `unknown` with `preserve-with-annotation`; the 317 bubble-contained regions resolve to `dialogue` with `replace`. The legacy manifest had all 387 detected regions as `unknown + replace`. Unknown regions occur on 17 pages, and the current render-safety gate preserves those pages before inpainting or rendering; the one zero-detection page is separately preserved, leaving 32/50 pages free of the unknown-or-empty role gate before other QA checks. Across detected regions, outside-bubble overlap had a maximum of 0, while mapped dialogue had a minimum overlap of 0.970428 and minimum dominant-label share of 0.9980. The live replay again produced mapped 317, external 70, geometric unknown 0, and `unknown -> replace` violations 0.

The 0.80/0.05 thresholds are frozen only for the Koharu 0.61.2 bbox production route. The `line-polygons` route is unavailable and unvalidated, so no polygon threshold is frozen. Versioned routing reports count `line-polygons` and bbox evidence separately and expose a strict polygon gate; all-bbox data receives `reasonCode = "LINE_POLYGONS_UNAVAILABLE"` and is not freeze-eligible. Mixed or incomplete geometry data is also not a polygon-only result; only all-polygon evidence across detected observations can pass the polygon gate.

The detected distribution by page stratum was:

| Stratum | Bubble-contained | Bubble-external | Geometric unknown |
| --- | ---: | ---: | ---: |
| ordinary-dialogue | 130 | 4 | 0 |
| dense-text | 84 | 9 | 0 |
| dark-complex | 40 | 12 | 0 |
| artistic-sfx-action | 57 | 6 | 0 |
| structural-negative | 6 | 39 | 0 |

A seven-region private hard-case set now covers one detected bubble-external example from every stratum, the single missed artistic-text region, and one bubble-mapped region on a structural-negative page. It contains stable IDs and numeric evidence only; no image, OCR text, translation, prompt, or blob identifier is recorded.

Current decision: deterministic bubble geometry is sufficient for preservation-first safety on the validated bbox production route, but not for useful coverage by itself because the conservative unknown gate blocks 17 mixed-content pages. The targeted seven-case visual role check found no destructive replacement errors and supported keeping the 0.80/0.05 bbox thresholds unchanged. It also confirmed that bubble-external text contains multiple semantic roles, including replaceable captions or monologue as well as artistic or decorative text that must remain preserved. Geometry alone therefore cannot classify the subtype: external text remains unknown and preserved until separate evidence justifies a classifier. The polygon route remains unavailable and is not a reason to schedule detection-only work.

## Architecture decisions

### Decisions that can be frozen provisionally

- **Koharu remains the V1 chassis.** It owns detection, scene storage, inpainting, rendering, editing, and project export.
- **This repository remains the quality orchestrator.** It owns routing, OCR arbitration, chapter context, QA, benchmarking, privacy, and recovery policy.
- **The V1 pipeline is hybrid.** Evidence does not support replacing Koharu wholesale with MangaTranslator or adopting a single monolithic route.
- **The private `review-v5` set is the current working gold.** It is sufficient for V1 research but not for final public quality claims.
- **Models load sequentially.** The observed 8 GB environment does not have enough headroom for competing large models to remain loaded together.
- **Safety, privacy, archive validation, unique output directories, recovery artifacts, and source-page preservation remain hard requirements.**
- **Unknown region roles fail closed.** Unknown content is preserved or routed to review; it is never erased merely because classification is missing.

### Decisions that remain open

- the calibrated OCR selector and whether a manga-specialized Paddle candidate adds value;
- the default translation model, quantization, prompt mode, and retry/reviewer policy;
- AOT versus LaMa as the default repair path;
- thresholds for residual-text, mask-boundary, and outside-mask visual QA;
- whether additional discourse, speaker, character, or panel fields are justified by real error categories;
- final release-quality thresholds after representative end-to-end runs.

### Approaches rejected or deferred for now

- full relabelling of all 50 working-gold pages before V1 selection;
- direct comparison of raw OCR confidences across engines;
- `unknown -> replace` routing;
- freezing a model because it is already present in configuration;
- treating a partial smoke as evidence of route superiority;
- adding speaker-aware, character-aware, or multi-model semantic machinery before real errors demonstrate that it is a primary bottleneck;
- turning visual QA warnings into an automatic release gate before calibration on real images;
- scheduling detection-only work to seek `linePolygons` from Koharu 0.61.2 engines already verified not to populate them.

## Target V1 pipeline

```mermaid
flowchart LR
    A["Safe import"] --> B["Koharu detection and scene"]
    B --> C["Role and page policy router"]
    B --> D["Bubble and segment masks"]
    D --> C
    C --> E["OCR candidates"]
    E --> F["Calibrated OCR arbitration"]
    F --> G["Chapter context and controlled glossary"]
    G --> H["Replaceable translation model"]
    H --> I["Deterministic QA and targeted retry"]
    I --> J["Koharu inpainting and typesetting"]
    J --> K["Report-first visual QA"]
    K --> L["Images, CBZ, KHR, report, optional PSD"]
```

The router must distinguish evidence provenance:

- `nativeRoleEvidence`: a native Koharu field, typed node, or mask role;
- `derivedRoleEvidence`: mask overlap, geometry, typography, or another deterministic inference;
- `roleConfidence`: a calibrated confidence for the derived decision;
- `roleProvenance`: the exact rule or model that produced the decision;
- `geometrySource`: `line-polygons` or bbox geometry used for the bubble-mask measurement, kept separate from role provenance;
- `bubbleInstanceId`: the non-zero label shared by text regions in the same bubble.

High-confidence bubble-contained text may be treated as dialogue. Bubble-external text is not automatically a sound effect; it remains unknown until a separate rule has adequate evidence.

## Milestones

### M0 — Evidence synthesis

Status: **complete**

Completion evidence:

- working-gold status and limitations documented;
- existing Koharu, OCR, translation, MangaTranslator, safety, and visual evidence compared;
- module-level bottlenecks separated;
- V1 chassis and open component slots identified;
- bubble scene contract resolved through a real API probe.

### M1 — Bubble-mask scene adapter

Status: **complete and committed; unit, mocked contract, CLI, dependency, privacy, and adversarial checks passed; polygon calibration is unavailable on the verified Koharu 0.61.2 routes**

Scope:

- bounded local blob retrieval from Koharu;
- in-memory lossless WebP mask decoding;
- page-coordinate validation;
- text polygon or box overlap with integer bubble labels;
- `insideBubble`, `bubbleInstanceId`, confidence, role provenance, and geometry-source records;
- preservation-first policy for unknown roles;
- schema and contract tests;
- malformed image, dimension mismatch, oversized input, coordinate, privacy, and failure-closed tests.

Completion gate:

- all unit and mocked contract tests pass;
- CLI syntax check passes;
- dependency and license changes are reviewed;
- no source or translated text, blob identifiers, images, or prompts enter logs;
- no claim of real quality is made before the next milestone.

Estimated work: one focused implementation and review task.

### M2 — Existing-data routing regression

Status: **complete; bbox production-route regression, live geometry probe, and seven-case visual role check passed; `line-polygons` remains unavailable and unvalidated**

Use existing KHR and working-gold artifacts without rerunning detection, OCR, or translation models where possible.

Goals:

- measure bubble mapping coverage on the 50-page baseline;
- quantify ordinary dialogue, bubble-external text, and uncertain regions;
- verify that unknown regions no longer enter destructive replacement;
- extract the smallest set of unresolved role hard cases;
- decide whether deterministic geometry and typography are sufficient before adding a classifier.

Completed M2 evidence:

- 317/387 detected regions map to a bubble instance and 70/387 are deterministically bubble-external;
- all 387 detected regions fall outside the uncertainty band under stored bbox geometry;
- all 70 runtime unknown regions are preserved and zero enter replacement;
- those unknowns trigger page preservation on 17/50 pages, while one additional zero-detection page is preserved separately;
- a seven-region private hard-case set covers the unresolved semantic role classes;
- prior three-page live-probe signatures are reproduced exactly without starting Koharu;
- the 50-page live replay produced mapped 317, external 70, geometric unknown 0, and `unknown -> replace` violations 0;
- all 387 live text nodes had null `linePolygons`, so all effective geometry was bbox provenance;
- mapped bbox overlap had a minimum of 0.970428 and external bbox overlap had a maximum of 0;
- 0.80/0.05 is frozen only for the Koharu 0.61.2 bbox production route;
- the strict polygon gate is not freeze-eligible when effective non-empty `linePolygons` are absent;
- the seven-case visual role check found no destructive replacement errors and no evidence supporting a bbox threshold change;
- conservative false preservation remains for some replaceable external captions or monologue, while artistic, decorative, and missed text remains protected;
- bubble-external semantic classification remains open, but it does not block proceeding to OCR arbitration while the fail-closed preservation policy remains in force.

Completion gate:

- visually verify the semantic roles of the seven hard cases without a detection-only run: **passed**;
- verify that no unsafe `unknown -> replace` path or destructive hard-case replacement remains: **passed**;
- keep unresolved external semantic roles fail-closed and explicitly out of the frozen routing claim: **passed**.

Estimated work: one targeted visual role check.

### M3 — OCR arbitration

Status: **M3.10A real composite shadow build verified; M3.10B resource-policy v2.1 is `EXECUTABLE_NOT_RUN`; the real three-page Koharu smoke is deferred**

M3.1a evidence:

- `review-v5` remains unchanged; the five accepted visual-audit decisions are represented only by an ignored, versioned private overlay pinned to the exact base hash and byte length;
- the fixed benchmark population is 388 working-gold regions: 387 detector outputs and one detection miss;
- OCR scoring contains 384 eligible detected regions, excludes three detected structural or boundary cases, and has 383 regions with both retained candidates;
- derived input and aggregate baseline report are private ignored artifacts; public schemas and synthetic fixtures contain no private manga text, page identifiers, or real region identifiers;
- normalization is NFKC followed by whitespace removal; exact match and character edit distance use the normalized text, missing candidates remain explicit, and no cross-engine raw confidence is consumed;
- M3.2 implemented offline comparison against this contract without rerunning a model. It did not establish a calibrated arbitration policy.

M3.2 outcome:

- the fixed M3.1a benchmark input, its baseline report, and the final M2 routing observations are SHA-256 pinned and joined one-to-one across all 388 reviewed regions;
- leave-one-page-out evaluation uses 50 page folds, with 49 pages containing OCR-eligible regions; training and held-page evaluation never share a page;
- the two predeclared adaptive strategies both reached 327 / 384 exact regions (85.16%) and 434 / 5,799 corpus CER (7.48%), compared with Paddle at 289 / 384 exact (75.26%) and 327 / 5,799 CER (5.64%);
- both adaptive strategies preserved the structural-negative Paddle safety baseline, but neither simultaneously improved fixed-denominator exact and corpus CER over both fixed engines;
- page-cluster bootstrap with seed 20260811 and 5,000 replicates found an exact-rate gain over Paddle of 9.90 percentage points with a 95% interval of 5.33 to 15.32 points, while the corpus-CER difference was 1.85 points with a 95% interval of -3.92 to 12.52 points and therefore crossed zero;
- the bubble-aware fallback produced the same aggregate result as the category-only strategy under the predeclared support floor of five; no observation-driven threshold or extra rule was added;
- one missing Paddle candidate and three normalized-agreement joint errors remain explicit QA residuals;
- decision: **do not freeze either simple arbitration strategy**. This result did not justify M4 by itself; the later category-free runtime policy and fail-closed source-text preconditions allow M4 translation benchmarking to proceed without claiming that an adaptive OCR selector was calibrated.

M3.5–M3.7 decisions:

- M3.5 gate: **INCONCLUSIVE**. It does not establish a production selector.
- M3.6 P2 is a **post-hoc development result only**. It is not prospective gate evidence and is not promoted into the runtime contract.
- M3.7 decision: **FALL_BACK_TO_CATEGORY_FREE_POLICY**.
- Benchmark category, bubble relation, repetition signals, and other post-hoc strata do not enter V1 runtime selection.
- Raw confidence remains per-engine provenance only and is never compared between Paddle OCR and Manga OCR.

M3.8 runtime contract:

- OCR runtime policy version 1 is independent from the benchmark scorer and shares one NFKC-plus-Unicode-whitespace-removal and hard-safety implementation with benchmark evaluation.
- `strict-quality` requires both engines for every eligible region. Safe normalized agreement is accepted; disagreement, missing candidates, fallback not-run, or any hard-unsafe candidate enters blocking QA. This is the `quality-local` default and maximizes safety at the cost of more manual review.
- `low-manual` accepts safe agreement and deterministically selects Paddle on safe disagreement. Missing candidates, fallback not-run, or any hard-unsafe candidate still enters blocking QA. This reduces disagreement review at the cost of allowing a known deterministic override.
- Both policies are category-free. Neither uses category, bubble state, repetition gates, nor cross-engine raw confidence.
- Runtime association fails closed on duplicate identities, population drift, page conflicts, extra or missing fallback regions, and source-geometry conflicts.
- Region records carry both candidate states, candidate-local confidence provenance, selected engine when present, policy version, fixed selection reason, and fixed QA reason codes.
- Koharu 0.61.2 accepts an `Op::Batch` directly at `/history/apply` and returns the resulting epoch, but it has no expected-epoch input and a Batch applies child operations sequentially without rollback. The runtime guarantee is therefore explicitly a **single-writer operational guarantee, not atomic CAS**.
- Scene mutation and translator execution require an orchestrator-started loopback Koharu process, a verified child handle/PID/start time/executable hash/socket owner, a unique run-owned data root, and exactly one run-created project. External/shared Koharu mode remains read-only and stops with `KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE` before project creation, upload, scene mutation, or translator execution.
- Before patching, the runtime waits for idle operations and two identical scene reads, freezes epoch plus full and allowed-field-masked structure hashes, writes a private durable intent journal, and sends one non-empty Batch containing only necessary source-text updates. Every response, timeout, or ambiguous error is followed by readback rather than retry. Only exact equality with the precomputed patched scene at `E0 + 1` advances the journal; partial application, an extra epoch, population or active-project drift, or any unknown-field change quarantines the isolated project.
- Translator start requires a second exact epoch/hash precondition check and sends only the selected text-node IDs and their target pages. `CompletedWithErrors` is failure. The verified postcondition requires one epoch increment per actual target page, unchanged selected source text, unchanged population/geometry/mask/blob and unknown fields, and changes only to target translation fields. Two stable reads and one final pre-render hash check are required before inpaint or render.
- The first owned V1 closure performs one journaled translator pipeline. Existing local/cloud retry mutations are not silently reused because they would require separately journaled epoch and postcondition gates; retry-eligible pages remain explicit QA/render-preservation outcomes until that extension is designed.
- The private journal records `PREPARED`, `PATCH_INTENT`, `PATCH_ACK`, `PATCH_VERIFIED`, `TRANSLATOR_INTENT`, `TRANSLATOR_STARTED`, `TRANSLATOR_FINISHED`, and `POST_TRANSLATOR_VERIFIED`. Its phase plus exact scene readback distinguishes patch-not-started, ambiguous or partial patch, patched-but-translator-not-started, and translator-finished-but-not-yet-verified recovery states without placing source text in ordinary logs.
- The model cache boundary uses a project-owned, rebuildable shadow copy. Locked source files are copied byte-for-byte with size and SHA-256 checks before and after copying; hardlinks are permitted only inside the shadow from blobs to snapshots. A run may link only to the verified shadow, never directly to an AppData cache, and the manifest is revalidated before and after the run. Mutation marks the shadow as requiring rebuild. Cleanup unlinks only exact links created by the run and never recursively enters a junction or other reparse point.
- This boundary does not claim protection against a malicious local process running with the same user permissions. The real composite build is now verified, but the remaining owned-lifecycle acceptance evidence is still one separately authorized real three-page smoke.

M3.9 preflight implementation:

- the public builder accepts a generic complete-file manifest and never embeds private source paths or workstation hashes;
- every content source is a regular non-reparse file and is checked by size and SHA-256 before copy, after copy, and at the destination;
- the builder creates a unique sibling staging directory on the target volume, checks worst-case free space, permits hardlinks only between files inside that staging root, validates the full runtime/config/font/model population, and publishes with one non-overwriting directory rename;
- failure cleanup visits only exact files and directories recorded by the current build in reverse order, refuses reparse points, and never recursively traverses a staging tree;
- owned execution stages the executable, runtime subtree, rendered config, and pinned renderer font into the unique run data root; only the model-cache subtree may be exposed through the separately identity-checked run junction;
- owned config explicitly freezes the run-relative data root, shadow and data-relative runtime/config/model/font paths, offline/no-download policy, and renderer `defaultFont` request value plus file size and SHA-256;
- the renderer request carries the frozen `defaultFont`, while the complete composite manifest is revalidated before staging/start and after process stop;
- micro-fixture tests cover success, source drift, partial copy, insufficient space, font drift, config drift, atomic publish conflict, and exact non-recursive cleanup without materializing the real dependency closure;
- these bullets describe the M3.9 synthetic implementation evidence. M3.10A subsequently supplied the real composite materialization evidence; it did not start Koharu, a model, the GPU, or the three-page smoke.

M3.10A/M3.10B outcome:

- the frozen composite shadow was materially built and its completion checks succeeded;
- no private source path, workstation-specific hash, manga content, or prompt is recorded in this public plan;
- resource-policy v2.1 has reached `EXECUTABLE_NOT_RUN`, which means the executable policy package is ready but no real lifecycle result is claimed;
- the real three-page owned-process smoke remains deferred and is not implied by the successful composite build or resource-policy readiness state.

Goals:

- retain PaddleOCR-VL and Manga OCR candidates;
- keep all cross-engine runtime decisions category-free and independent of raw confidence;
- accept safe normalized agreement directly and route strict disagreement to QA;
- prove selected OCR is the actual translation input before enabling the translator;
- evaluate a manga-specialized Paddle candidate only on the same crops and only after separate download authorization;
- keep translation disabled unless the owned-process identity, unique project, private patch journal, exact scene readback, epoch expectations, and translator postconditions are all active.

Estimated work: one separately authorized three-page owned-process smoke and review of its private journal and non-private structural evidence; it is deferred while M4 text-only selection work proceeds independently.

### M4 — Controlled translation selection

Status: **M4.0/M4.1 contract, scorer, private derivation, challenge preregistration, and historical attribution report complete; controlled candidate runs not executed**

Use fixed working-gold OCR so that OCR and rendering failures cannot distort model comparison.

Start with a compact challenge set containing clean-OCR semantic failures and stratified successful controls. Compare the existing complete baseline with viable local candidates under the same context, glossary, formatting, and non-refusal checks. Expand to all 388 regions only when the compact result is close enough to affect the decision.

M4.0/M4.1 evidence:

- translation evaluation is independent from the legacy `benchmark.ts` path and has versioned input, candidate-run, review-overlay, spec, and report contracts with public JSON Schemas and synthetic tests;
- the fixed population is 388 working-gold regions. Translation quality is eligible on 384 regions; one detection miss and three non-text or bbox-boundary cases are explicitly non-translation responsibility;
- among the 384 translation-responsibility regions in the historical Sakura output, 303 use raw-identical OCR input, eight are identical after the fixed NFKC-plus-whitespace normalization, and 73 use different OCR input;
- only the 311 input-agreement regions may contribute to historical translation-quality analysis. The other 73 remain historical E2E attribution only and cannot be counted as a fixed-OCR Sakura model score;
- the previously observed 240/388 semantic-usable, 240/388 terminology-correct, and 271/388 layout-usable results remain historical E2E review aggregates over mixed OCR inputs;
- the preregistered compact challenge contains 38 regions across 29 pages: 24 input-agreement semantic or terminology failures and 14 successful controls covering every non-empty category-by-length stratum;
- challenge length strata are 13 short, 13 medium, and 12 long regions. All 38 regions require explicit non-refusal/non-dilution review;
- selection uses only fixed eligibility, historical input agreement, pre-existing review labels, page/category/length strata, stable identifiers, a fixed seed, and deterministic SHA-256 ordering. It does not inspect a new candidate and fails closed if the selection parameters or source pins drift;
- reference translation exactness and edit distance are diagnostics only. They are never a semantic correctness gate, model-selection hard gate, or substitute for reviewed semantic and terminology outcomes;
- refusal/dilution and context/character-name consistency require explicit review verdicts. The historical review does not contain those verdicts, so the scorer reports zero reviewed denominator instead of inferring them from keywords or prose;
- the report contains only aggregate evidence, separates deterministic formatting and structural QA from semantic review, and supports paired page-grouped percentile bootstrap comparisons with fixed seed and 95% intervals;
- the current planned controlled pair is Sakura-GalTransl-7B v3.7 IQ4_XS and Murasaki-8B v0.2 IQ4_XS on the same fixed challenge OCR, page context, no-glossary condition, plain-text formatting contract, and non-refusal/non-dilution requirement. Neither controlled run has been executed.

Goals:

- select the default translation model and prompt mode;
- separate OCR-caused failures from translation-caused failures;
- measure rejection, dilution, repetition, formatting, terminology, and context errors;
- decide whether a conditional semantic reviewer improves enough cases to justify its cost;
- lock model identity, quantization, license, and SHA-256 only after the hard gates pass.

Estimated work: one separately authorized compact text-only two-candidate run plus review/scoring, and only if its paired result can change the decision, one separately authorized full fixed-input text-only benchmark.

### M5 — Repair, lettering, and visual QA

Status: **pending**

Use a stratified ten-page set before any full-chapter visual rerun.

Goals:

- compare the viable repair paths on identical masks;
- measure outside-mask pixel changes and boundary damage;
- detect residual source text without modifying unrelated artwork;
- evaluate overflow, font fallback, line breaking, and small-note placement;
- calibrate visual checks as report-only signals before making any of them release gates.

Estimated work: one GPU experiment task and one visual review task.

### M6 — V1 freeze and chapter acceptance

Status: **pending**

Goals:

- freeze the chosen engines, models, thresholds, quantizations, and hashes;
- run the three-page safety smoke again;
- process one complete representative chapter on the reference 8 GB GPU;
- record peak VRAM, page time, failure recovery, and quality metrics;
- perform an adversarial review of data loss, privacy, archive safety, routing, model failure, visual damage, and evidence claims;
- update public documentation to match only the results actually achieved.

Estimated work: one full integration task, followed by one independent review task.

## V1 acceptance targets

These remain targets, not achieved results:

- ordinary dialogue and narration detection recall at least 98%;
- printed-dialogue OCR CER no higher than 3%;
- at least 90% of translations require no semantic rewrite;
- chapter names and terminology at least 99% consistent;
- no unplanned Japanese residuals outside the deliberate artistic-text policy;
- no text overflow in accepted output;
- at least 85% of pages require no manual correction for personal reading;
- repair and lettering blind-review average at least 4/5;
- a complete representative chapter finishes on the reference 8 GB GPU without OOM;
- no comic content leaves the machine unless the user explicitly enables and configures the text-only cloud fallback for that run.

## Experiment policy

- Prefer existing artifacts and offline replay before rerunning models.
- Test the smallest decision-changing hard set before a full benchmark.
- Change one module at a time so that gains and regressions remain attributable.
- Run only one large local model at a time.
- Record model version, quantization, license, and SHA-256 with every candidate result.
- Treat synthetic tests, smoke runs, real runs, visual review, and formal acceptance as different evidence levels.
- Do not promote a self-reported model benchmark to a project decision without a controlled local comparison.
- Do not turn AI-assisted working-gold judgments into public professional-quality claims.

## Public and private boundary

The repository may contain:

- source code, schemas, tests, prompts that are safe to publish, and aggregate measurements;
- synthetic fixtures that contain no private manga content;
- model identities, licenses, quantizations, and hashes;
- architecture decisions and unexecuted-test disclosures.

The repository must not contain:

- manga pages or crops;
- private OCR text, translations, review rationales, or working-gold records;
- model weights, fonts, KHR/PSD/CBZ output, API keys, or provider secrets;
- local absolute paths or user-specific environment details;
- logs containing source text, translated text, images, blob identifiers, or prompts.

## Working method

- Keep this plan in the primary project task; implementation tasks execute one milestone at a time.
- Before each milestone, inspect Git status and protect unrelated work.
- Do not combine optional refactors with evidence-driven changes.
- Run the smallest relevant verification first, then expand only when failures or coupling justify it.
- Do not commit or push until the milestone diff and verification results have been reviewed by the user.
- Create a repository skill only after the benchmark workflow is stable and has passed representative runs.

## Immediate next actions

1. Review the M4.0/M4.1 public contract, schemas, scorer tests, privacy boundary, and ignored private fixed artifacts.
2. If separately authorized, run only the 38-region text-only challenge for the two preregistered controlled candidates with exact working-gold OCR input and without Koharu, image processing, rendering, cloud fallback, downloads, or firewall changes.
3. Add explicit review overlays for semantic usability, terminology, refusal/dilution, context/character-name consistency, and layout, then generate the paired page-grouped report.
4. Expand to all fixed-input regions only if the compact controlled comparison can change the model decision. Keep the M3.10B three-page owned-process smoke deferred until separately authorized.
