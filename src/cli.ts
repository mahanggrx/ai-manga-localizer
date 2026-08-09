#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { runBenchmark } from "./benchmark.ts";
import { loadConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { asLocalizerError, LocalizerError } from "./errors.ts";
import { runTranslate } from "./translate.ts";

const HELP = `manga-localizer - local-first Japanese manga quality orchestrator

Usage:
  manga-localizer doctor [--config FILE] [--json]
  manga-localizer benchmark GOLDEN_SET [--out DIRECTORY]
  manga-localizer translate INPUT --out DIRECTORY [--profile quality-local] [--allow-cloud] [--psd] [--config FILE]

The CLI never downloads models, starts Koharu, or overwrites existing output.
`;

interface ParsedArgs {
  command?: string;
  positionals: string[];
  options: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const booleanOptions = new Set(["--json", "--allow-cloud", "--psd", "--help", "-h"]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (booleanOptions.has(token)) {
      options.set(token, true);
      continue;
    }
    if (!["--config", "--out", "--profile"].includes(token)) throw new LocalizerError("CLI_UNKNOWN_OPTION", `Unknown option: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("-")) throw new LocalizerError("CLI_OPTION_VALUE_MISSING", `${token} requires a value`);
    options.set(token, value);
    index += 1;
  }
  return { command, positionals, options };
}

function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true;
}

function printDoctor(result: Awaited<ReturnType<typeof runDoctor>>): void {
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    process.stdout.write(`[${marker}] ${check.name}: ${check.code} - ${check.detail}\n`);
  }
  process.stdout.write(result.ok ? "Doctor completed without blocking failures.\n" : "Doctor found blocking failures.\n");
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new LocalizerError("NODE_VERSION_UNSUPPORTED", `Node 24 or newer is required; found ${process.versions.node}`);
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.command === "--help" || args.command === "-h" || flag(args, "--help") || flag(args, "-h")) {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadConfig(option(args, "--config"));
  if (args.command === "doctor") {
    if (args.positionals.length > 0) throw new LocalizerError("CLI_ARGUMENTS_INVALID", "doctor does not accept positional arguments");
    const result = await runDoctor(config);
    if (flag(args, "--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printDoctor(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (args.command === "benchmark") {
    if (args.positionals.length !== 1) throw new LocalizerError("CLI_ARGUMENTS_INVALID", "benchmark requires exactly one GOLDEN_SET directory");
    const outputParent = path.resolve(option(args, "--out") ?? process.cwd());
    const result = await runBenchmark(path.resolve(args.positionals[0]), outputParent);
    process.stdout.write(`Benchmark winner: ${result.report.winner}\nResults: ${result.directory}\n`);
    return;
  }
  if (args.command === "translate") {
    if (args.positionals.length !== 1) throw new LocalizerError("CLI_ARGUMENTS_INVALID", "translate requires exactly one INPUT path");
    const outputParent = option(args, "--out");
    if (!outputParent) throw new LocalizerError("CLI_OUTPUT_REQUIRED", "translate requires --out DIRECTORY");
    const profile = option(args, "--profile") ?? "quality-local";
    if (profile !== "quality-local") throw new LocalizerError("CLI_PROFILE_UNSUPPORTED", `Unsupported profile: ${profile}`);
    const result = await runTranslate(config, {
      inputPath: path.resolve(args.positionals[0]),
      outputParent: path.resolve(outputParent),
      allowCloud: flag(args, "--allow-cloud"),
      psd: flag(args, "--psd"),
    });
    process.stdout.write(`Translation ${result.report.status}: ${result.directory}\n`);
    return;
  }
  throw new LocalizerError("CLI_COMMAND_UNKNOWN", `Unknown command: ${args.command}`);
}

main().catch((error) => {
  const failure = asLocalizerError(error);
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.exitCode = 1;
});
