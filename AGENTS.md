# Repository working agreements

## Current delivery mode

- Prioritize a usable personal MVP over commercial-grade completeness. Implement the shortest reliable path to something the user can actually run, then improve it from the user's real experience.
- Do not add speculative infrastructure, exhaustive freeze chains, repeated audits, or defensive checks unless they directly prevent likely data loss, privacy leakage, unusable output, or a demonstrated failure.
- Use the minimum validation that proves the changed behavior. Stop when the current milestone is usable; record non-blocking refinements as later work instead of implementing them immediately.
- Subagents are optional and should be short-lived and bounded. Until the user changes the setting, subagents may only use `gpt-5.6-luna` with `max` reasoning, and must be terminated after their result is handed back.

## Purpose and scope

- This repository is a local-first, non-commercial Japanese manga to Simplified Chinese quality orchestrator for Koharu.
- Keep version 1 focused on image directories, ZIP, and CBZ inputs. PDF, hosted services, accounts, payments, and public distribution are out of scope.
- Koharu owns detection, OCR, inpainting, rendering, and project export. This repository owns orchestration, quality checks, benchmarking, and privacy boundaries.

## Safety and privacy

- Never upload source images. Cloud fallback may send OCR text only when the user explicitly passes `--allow-cloud` and configures a provider.
- Do not log source text, translated text, images, secrets, or model prompts. Logs may contain stable region IDs, durations, stage names, and error codes.
- Never commit manga pages, private golden-set data, model weights, fonts, KHR/PSD/CBZ outputs, or API keys.
- Do not add keyword censorship or semantic dilution for lawful user-authorized content. Refusal-like translations are quality failures.
- Never overwrite input or an existing output. Create a unique output directory for every run.
- Archive processing must fail closed on absolute paths, `..`, drive prefixes, alternate data streams, symbolic links, junctions, encryption, unsupported compression, CRC mismatch, or size-limit violations.

## Engineering conventions

- Use Node.js 24 built-ins by default. Adding or downloading a dependency requires explicit user authorization.
- Keep TypeScript compatible with Node's built-in erasable type syntax: no enums, namespaces, parameter properties, or runtime TypeScript-only constructs.
- Treat Koharu as an external versioned service. Validate `/meta`, `/engines`, bootstrapping `503`, operation events, and scene shape; fail closed on incompatible contracts.
- Keep all public JSON artifacts schema-versioned. Update JSON Schemas and tests with any contract change.
- Prefer deterministic rules for QA and benchmark scoring. Record model identity, quantization, and SHA-256 in the model lock.
- Do not create commits, push, rewrite history, or create worktrees.

## Verification

- Run `node --test tests/*.test.ts` after changing runtime code.
- Run `node --check src/cli.ts` after changing CLI wiring.
- Real Koharu, GPU, model, font, and cloud tests require separate authorization because they start processes, download assets, or may send data.
- Completion requires unit tests, mocked Koharu contract tests, a documented list of unexecuted real checks, and an adversarial review of archive safety, privacy, data loss, error recovery, and evidence claims.

## Skills

- Do not create a repository skill until the golden-set benchmark workflow is stable and has passed representative runs.
