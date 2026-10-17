#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir, platform, release, arch, cpus, loadavg } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpus } from "./eval/corpus.mjs";
import { freezeRevision, captureCase, hash } from "./eval/capture.mjs";
import { preflight, runSample, nativeArgs, nativeConfig } from "./eval/native.mjs";
import { checkQuality, summarize, reportMarkdown } from "./eval/quality.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const help = `Compare frozen baseline/candidate Followups prompts. Default: capture only; no model calls.

Usage: node scripts/eval-followups.mjs [options]
  --live                  Opt in to sequential native Codex runs (uses existing auth)
  --baseline <gitref>      Baseline commit/ref (default HEAD)
  --provider <id>          Only codex is supported (default codex)
  --model <id>             Default gpt-6-luna
  --reasoning <level>      Default low
  --repeats <count>        Paired repeats per case, 1..100 (default 5)
  --case <id>              One corpus case (default all)
  --out <directory>        Default .local/followups-runs/<timestamp>
  --timeout <seconds>      Per-sample limit, 1..600 (default 120)
  --codex-bin <path>       Codex executable (default codex)
  --help                  Show this help

Dry-run freezes sources, captures production prompts and own session instructions,
and writes manifest.json, results.json, report.md and input files. Live runs preserve
raw events and final text. Repeats below five are smoke/inconclusive. Checks are
deterministic proxies; paired raw output and a human rubric support review.
`;

export function parseArgs(argv) {
  const config = { live: false, baseline: "HEAD", provider: "codex", model: "gpt-6-luna", reasoning: "low", repeats: 5, case: null, out: null, timeout: 120, codexBin: "codex" };
  const keys = { "--baseline": "baseline", "--provider": "provider", "--model": "model", "--reasoning": "reasoning", "--repeats": "repeats", "--case": "case", "--out": "out", "--timeout": "timeout", "--codex-bin": "codexBin" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") return { ...config, help: true };
    if (arg === "--live") { config.live = true; continue; }
    const key = keys[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
    config[key] = argv[++i];
  }
  if (config.provider !== "codex") throw new Error(`Unsupported provider ${config.provider}; only codex is implemented (no fallback).`);
  for (const [key, max] of [["repeats", 100], ["timeout", 600]]) {
    config[key] = Number(config[key]);
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
  }
  if (config.baseline.startsWith("-")) throw new Error("Baseline must be a Git revision, not an option");
  if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(config.reasoning)) throw new Error(`Unsupported reasoning level: ${config.reasoning}`);
  if (config.case && !corpus.some((entry) => entry.id === config.case)) throw new Error(`Unknown case: ${config.case}`);
  return config;
}

export function schedulePairs(cases, repeats) {
  const schedule = [];
  for (const entry of cases) for (let repeat = 0; repeat < repeats; repeat++) {
    for (const variant of repeat % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) schedule.push({ caseId: entry.id, repeat, variant });
  }
  return schedule;
}

export function evaluationFailed(samples) {
  return samples.some((sample) => sample.status !== "complete" || (sample.variant === "candidate" && (sample.toolAttempts > 0 || !sample.coverageComplete || !sample.quality.pass)));
}

const writeJson = (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
export async function runEvaluation(config, { root = repoRoot, runLive = runSample, checkCapabilities = preflight, signal } = {}) {
  const cases = config.case ? corpus.filter((entry) => entry.id === config.case) : corpus;
  const out = path.resolve(root, config.out ?? `.local/followups-runs/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (out === path.resolve(root) || path.resolve(root).startsWith(`${out}${path.sep}`)) throw new Error("Output must not contain the repository");
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error(`Output directory must be empty: ${out}`);
  const temporary = await mkdtemp(path.join(tmpdir(), "followups-capture-"));
  const captures = { baseline: {}, candidate: {} };
  const samples = [];
  const manifest = {
    schemaVersion: 1, cliVersion: "1", createdAt: new Date().toISOString(), executionMode: "native-codex-session",
    dryRun: !config.live, config, corpusHash: hash(JSON.stringify(corpus)), selectedCases: cases.map((entry) => entry.id),
    sdkVersion: JSON.parse(await readFile(path.join(root, "node_modules/@get-bb/plugin-sdk/package.json"), "utf8")).version,
    nodeVersion: process.version, codex: null, revisions: {}, schedule: schedulePairs(cases, config.repeats),
    host: { platform: platform(), release: release(), arch: arch(), logicalCpus: cpus().length, initialLoadAverage: loadavg() },
    nativeConfig, commandArguments: { baseline: {}, candidate: {} },
    caveats: ["Not full BB host parity: captured plugin prompt and own normalized instructions only.", "Native skill discovery and provider context can differ even with user configuration/rules disabled.", "Read-only sandbox does not prevent tool attempts.", "Quality checks are deterministic proxies, not semantic proof.", "Observed model identity and missing usage remain null when not emitted."],
  };
  const persist = async () => {
    const results = { schemaVersion: 1, dryRun: !config.live, failed: evaluationFailed(samples), samples, summary: summarize(samples) };
    manifest.host.latestLoadAverage = loadavg();
    await writeJson(path.join(out, "manifest.json"), manifest);
    await writeJson(path.join(out, "results.json"), results);
    const report = reportMarkdown(manifest, results);
    await writeFile(path.join(out, "report.md"), `${config.live ? "" : "**DRY RUN: no model executed. The schedule below is proposed; measurements are absent.**\n\n"}${report}\n`);
    return results;
  };
  try {
    // Both source trees are frozen before importing either plugin revision.
    for (const variant of ["baseline", "candidate"]) manifest.revisions[variant] = await freezeRevision(root, path.join(temporary, variant), variant === "baseline" ? config.baseline : null, out);
    for (const variant of ["baseline", "candidate"]) {
      await mkdir(path.join(out, "inputs", variant), { recursive: true });
      for (const entry of cases) {
        captures[variant][entry.id] = await captureCase(path.join(temporary, variant), entry, config);
        manifest.commandArguments[variant][entry.id] = nativeArgs(captures[variant][entry.id], config);
        await writeJson(path.join(out, "inputs", variant, `${entry.id}.json`), captures[variant][entry.id]);
      }
    }
    await persist();
    if (config.live) {
      manifest.codex = await checkCapabilities(config.codexBin);
      await persist();
      for (const scheduled of manifest.schedule) {
        if (signal?.aborted) { manifest.interrupted = true; break; }
        const artifactPath = `samples/${scheduled.caseId}/${scheduled.repeat + 1}-${scheduled.variant}`;
        await mkdir(path.join(out, artifactPath), { recursive: true });
        const result = await runLive(captures[scheduled.variant][scheduled.caseId], config, path.join(out, artifactPath), { signal });
        const entry = cases.find((entry) => entry.id === scheduled.caseId);
        samples.push({ ...scheduled, ...result, artifactPath, quality: checkQuality(entry, result.finalText) });
        await persist();
      }
    }
    return { out, manifest, results: await persist() };
  } catch (error) {
    manifest.error = error.message;
    // A failed capture can precede one revision's provenance; keep its actual error.
    await writeJson(path.join(out, "manifest.json"), manifest);
    if (manifest.revisions.baseline && manifest.revisions.candidate) await persist();
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) { console.log(help); return; }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    const result = await runEvaluation(config, { signal: controller.signal });
    console.log(`${config.live ? "Live comparison" : "Dry-run capture"}: ${result.out}`);
    console.log(`Artifacts: manifest.json, results.json, report.md; ${result.manifest.schedule.length} scheduled samples, ${result.results.samples.length} executed.`);
    if (config.repeats < 5) console.log("SMOKE / INCONCLUSIVE: fewer than five paired repeats; no speedup or quality conclusion.");
    if (result.results.failed || controller.signal.aborted) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`Followups comparison failed: ${error.message}`); process.exitCode = 1; });
}
