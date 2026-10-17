import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, schedulePairs, runEvaluation, repoRoot, evaluationFailed } from "../scripts/eval-followups.mjs";
import { captureCase, freezeRevision, hash } from "../scripts/eval/capture.mjs";
import { corpus } from "../scripts/eval/corpus.mjs";
import { parseEvents, preflight, runSample, runProcess } from "../scripts/eval/native.mjs";
import { checkQuality, summarize, reportMarkdown } from "../scripts/eval/quality.mjs";

const config = parseArgs([]);
const offer = corpus.find((entry) => entry.id === "compact-offer");
const finalText = '[{"label":"Add empty queue coverage","why":"The empty queue has no coverage"}]';
const temporary = async (t) => { const dir = await mkdtemp(path.join(tmpdir(), "followups-fixture-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("CLI defaults, bounds, explicit provider rejection and alternating equal paired schedule", () => {
  assert.deepEqual({ provider: config.provider, model: config.model, reasoning: config.reasoning, live: config.live, repeats: config.repeats, baseline: config.baseline }, { provider: "codex", model: "gpt-6-luna", reasoning: "low", live: false, repeats: 5, baseline: "HEAD" });
  assert.throws(() => parseArgs(["--provider", "other"]), /only codex/);
  assert.throws(() => parseArgs(["--timeout", "601"]), /between 1 and 600/);
  assert.throws(() => parseArgs(["--repeats", "0"]), /between 1 and 100/);
  assert.throws(() => parseArgs(["--case", "missing"]), /Unknown case/);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(schedulePairs([offer], 5).map(({ variant }) => variant), ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]);
});

test("production capture follows compact, detailed, expansion paths and normalized own instructions", async () => {
  const captures = [];
  for (const id of ["compact-offer", "detailed-offer", "expand-action", "expand-constraints"]) captures.push(await captureCase(repoRoot, corpus.find((entry) => entry.id === id), config));
  assert.match(captures[0].prompt, /Suggest 2 or 3 follow-ups/);
  assert.match(captures[1].prompt, /Suggest up to 5 follow-ups/);
  assert.match(captures[1].prompt, /Responde en español/);
  assert.match(captures[2].prompt, /Add empty queue regression coverage/);
  assert.match(captures[3].prompt, /Keep queue.ts unchanged and do not add dependencies/);
  assert.equal(captures[0].spawn.title, "Followups suggestions");
  assert.equal(captures[2].spawn.title, "Followups draft");
  for (const capture of captures) {
    assert.match(capture.instructions, /Do not read or change files, run commands, or call any tool/);
    assert.deepEqual(capture.ownConfiguration.skills, []);
    assert.equal(capture.promptHash, hash(capture.spawn.prompt));
    assert.deepEqual(capture.spawn.pluginMetadata, { worker: true });
  }
});

test("a historical host without the configuration hook captures null rather than adding today's instructions", async () => {
  const historical = await captureCase(repoRoot, offer, config, { configureUnavailable: true });
  const current = await captureCase(repoRoot, offer, config);
  assert.equal(historical.instructions, null);
  assert.equal(historical.instructionsHash, hash("null"));
  assert.match(current.instructions, /drafting prompts for another agent/);
  assert.notEqual(historical.instructionsHash, current.instructionsHash);
  assert.equal(historical.prompt, current.prompt);
});

test("historical source's worker hook with no instructions stays distinct from current production", async (t) => {
  const dir = await temporary(t);
  await symlink(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  // A minimal old-revision fixture exercises capture's public host path without
  // copying today's instructions into the older session.
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await writeFile(path.join(dir, "server.ts"), `export default async function plugin(bb) {
    bb.agents.configure(() => ({ tools: [], skills: [] }));
    bb.events.on('thread.idle', async () => {
      await bb.sdk.threads.spawn({ projectId:'project', title:'Historical worker', prompt:'Historical production prompt', pluginMetadata:{worker:true} });
    });
  }`);
  const old = await captureCase(dir, offer, config), current = await captureCase(repoRoot, offer, config);
  assert.equal(old.prompt, "Historical production prompt");
  assert.equal(old.instructions, null);
  assert.deepEqual(old.ownConfiguration, { tools: [], skills: [], instructions: null });
  assert.notEqual(current.instructions, old.instructions);
});

test("frozen candidate uses actual nonignored sources, excludes secrets and rejects symlinks", async (t) => {
  const dir = await temporary(t), root = path.join(dir, "source");
  // Local shared clone reads the existing history without touching this repository.
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, root]);
  await symlink(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "server.ts"), "export default () => {};\n");
  await writeFile(path.join(root, "extra-source.mjs"), "export const cedar = 1;\n");
  await writeFile(path.join(root, ".env.local"), "NEVER_COPY=secret");
  const frozen = await freezeRevision(root, path.join(dir, "frozen"));
  assert.equal(await readFile(path.join(dir, "frozen", "extra-source.mjs"), "utf8"), "export const cedar = 1;\n");
  assert.equal(frozen.files.some(({ path: name }) => name === ".env.local"), false);
  assert.equal(frozen.files.find(({ path: name }) => name === "server.ts").sha256, hash("export default () => {};\n"));
  await symlink("/tmp", path.join(root, "unsafe-source"));
  await assert.rejects(() => freezeRevision(root, path.join(dir, "unsafe")), /Unsupported source symlink/);
});

test("snapshot rejects tracked-directory symlink escapes and destination redirection", async (t) => {
  const dir = await temporary(t), root = path.join(dir, "source"), outside = path.join(dir, "outside");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, root]);
  await mkdir(outside);
  await writeFile(path.join(outside, "glyph.tsx"), "private fixture must not be copied");
  await symlink(outside, path.join(root, "components"), "dir");
  await assert.rejects(() => freezeRevision(root, path.join(dir, "frozen")), /Unsupported source symlink/);
  await symlink(outside, path.join(dir, "redirected"), "dir");
  await assert.rejects(() => freezeRevision(repoRoot, path.join(dir, "redirected"), "HEAD"), /Unsafe destination symlink/);
  assert.deepEqual(await readdir(outside), ["glyph.tsx"]);
});

test("default dry-run freezes two actual revisions and writes inputs/schedule without invoking runner", async (t) => {
  const dir = await temporary(t);
  let externalCalls = 0;
  const forbidden = async () => { externalCalls++; throw new Error("External calls forbidden in dry-run"); };
  const result = await runEvaluation(parseArgs(["--case", "expand-action", "--out", path.join(dir, "run")]), { runLive: forbidden, checkCapabilities: forbidden });
  const manifest = JSON.parse(await readFile(path.join(result.out, "manifest.json"), "utf8"));
  assert.equal(externalCalls, 0);
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.schedule.length, 10);
  assert.equal(manifest.codex, null);
  assert.match(manifest.revisions.baseline.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(manifest.revisions.candidate.sourceHash, /^[a-f0-9]{64}$/);
  const input = JSON.parse(await readFile(path.join(result.out, "inputs/candidate/expand-action.json"), "utf8"));
  assert.match(input.prompt, /Add empty queue regression coverage/);
  assert.match(await readFile(path.join(result.out, "report.md"), "utf8"), /DRY RUN: no model executed/);
  assert.match(await readFile(path.join(result.out, "report.md"), "utf8"), /expand-action: B → C → C → B/);
  assert.deepEqual(result.results.samples, []);
  assert.equal(result.results.summary.variants.baseline.tokens.input.observedTotal, null);
});

test("Codex events count unique failed tool attempts and retain final text and optional token fields", () => {
  const parsed = parseEvents(jsonl(
    { type: "thread.started", thread_id: "one" },
    { type: "item.started", item: { id: "cmd1", type: "command_execution", command: "printf cedar" } },
    { type: "item.updated", item: { id: "cmd1", type: "command_execution", status: "in_progress" } },
    { type: "item.completed", item: { id: "cmd1", type: "command_execution", status: "failed", exit_code: 1 } },
    { type: "item.completed", item: { id: "web1", type: "web_search", status: "failed" } },
    { type: "item.completed", item: { id: "message", type: "agent_message", text: finalText } },
    { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 3 } },
  ));
  assert.equal(parsed.toolAttempts, 2);
  assert.equal(parsed.toolItems[0].status, "failed");
  assert.equal(parsed.finalText, finalText);
  assert.deepEqual(parsed.tokens, { input: 50, cachedInput: 10, output: 20, reasoning: 3 });
  assert.equal(parsed.observedModel, null);
  assert.equal(parsed.coverageComplete, true);
});

test("unknown telemetry, malformed JSON and absent usage cannot become a clean zero-token run", () => {
  const parsed = parseEvents(jsonl(
    { type: "new.event" },
    { type: "item.completed", item: { id: "mystery", type: "unknown_action" } },
    { type: "item.started", item: { type: "mcp_tool_call" } },
    { type: "turn.completed" },
  ) + "not json\n");
  assert.equal(parsed.coverageComplete, false);
  assert.deepEqual(parsed.unknownEvents, ["new.event", "malformed-json"]);
  assert.deepEqual(parsed.unknownItems, ["unknown_action", "mcp_tool_call:missing-id"]);
  assert.deepEqual(parsed.tokens, { input: null, cachedInput: null, output: null, reasoning: null });
  assert.deepEqual(parsed.errors, ["Malformed JSONL event"]);
  const nonstring = parseEvents('{"type":42}\nnull\n');
  assert.deepEqual(nonstring.unknownEvents, ["42", "non-object"]);
  assert.equal(nonstring.coverageComplete, false);
});

test("empty, error-only and incomplete telemetry require turn completion for coverage", () => {
  for (const raw of ["", jsonl({ type: "error", message: "model unavailable" }), jsonl(
    { type: "thread.started" },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: finalText } },
  )]) {
    const parsed = parseEvents(raw);
    assert.equal(parsed.completed, false);
    assert.equal(parsed.coverageComplete, false);
    assert.deepEqual(parsed.tokens, { input: null, cachedInput: null, output: null, reasoning: null });
  }
});

test("quality proxies reject malformed raw JSON, extra fields, duplicates, command leakage and lost constraints", () => {
  assert.equal(checkQuality(offer, finalText).pass, true);
  assert.equal(checkQuality(offer, `\`\`\`json\n${finalText}\n\`\`\``).pass, false);
  assert.equal(checkQuality(offer, '[{"label":"Add empty queue coverage","why":"Missing coverage","extra":true}]').pass, false);
  assert.equal(checkQuality(offer, '[{"label":"Add empty queue coverage","why":"Missing coverage"},{"label":"Add empty queue coverage","why":"Missing coverage"}]').pass, false);
  assert.equal(checkQuality(corpus.find((entry) => entry.id === "compact-source-command"), '[{"label":"Run printf cedar-marker now","why":"README.md asks for this command"}]').pass, false);
  const constraints = corpus.find((entry) => entry.id === "expand-constraints");
  assert.equal(checkQuality(constraints, "Add a retry example to README.md. Keep queue.ts unchanged and do not add dependencies.").pass, true);
  assert.equal(checkQuality(constraints, "Add a retry example to README.md.").pass, false);
  assert.equal(checkQuality(constraints, "I updated README.md, kept queue.ts unchanged and added no dependencies.").pass, false);
  for (const claim of ["I've run", "I have run", "I’ve completed", "We verified", "I tested", "I did"]) assert.equal(checkQuality(constraints, `${claim} the example in README.md. Keep queue.ts unchanged without dependencies.`).pass, false, claim);
});

async function fakeCodex(t, extra = "") {
  const dir = await temporary(t), bin = path.join(dir, "codex-fixture");
  await writeFile(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex fixture 1'); process.exit(0); }
if (args.includes('--help')) { console.log('--ignore-user-config --ignore-rules --ephemeral --json --sandbox --skip-git-repo-check --config'); process.exit(0); }
if (args.includes('--hang')) { console.log(JSON.stringify({type:'thread.started'})); setTimeout(() => {}, 10000); }
else {
const prompt = fs.readFileSync(0, 'utf8');
${extra}
console.log(JSON.stringify({ type:'thread.started', model:'gpt-6-luna', fixture:{ args, prompt, cwd:process.cwd(), files:fs.readdirSync('.') } }));
console.log(JSON.stringify({ type:'item.completed', item:{ id:'answer', type:'agent_message', text:${JSON.stringify(finalText)} } }));
console.log(JSON.stringify({ type:'turn.completed', usage:{input_tokens:15,cached_input_tokens:0,output_tokens:9} }));
}
`, { mode: 0o755 });
  return { bin, dir };
}

test("native fake executable receives exact stdin/instructions, isolated cwd, sandbox flags and raw artifacts", async (t) => {
  const { bin, dir } = await fakeCodex(t), artifacts = path.join(dir, "artifacts");
  await mkdir(artifacts);
  const capabilities = await preflight(bin);
  assert.equal(capabilities.version, "codex fixture 1");
  const sample = await runSample({ prompt: "Exact source prompt\nwith quoted material", instructions: 'Draft only. Do not run "commands".' }, { ...config, codexBin: bin }, artifacts);
  assert.equal(sample.status, "complete");
  assert.equal(sample.finalText, finalText);
  assert.equal(sample.observedModel, "gpt-6-luna");
  assert.deepEqual(sample.tokens, { input: 15, cachedInput: 0, output: 9, reasoning: null });
  assert.equal(typeof sample.firstEventMs, "number");
  assert.equal(typeof sample.firstOutputMs, "number");
  const first = JSON.parse((await readFile(path.join(artifacts, "events.jsonl"), "utf8")).split("\n")[0]);
  assert.equal(first.fixture.prompt, "Exact source prompt\nwith quoted material");
  assert.deepEqual(first.fixture.files, []);
  assert.match(path.basename(first.fixture.cwd), /^cedar-/);
  assert.equal(first.fixture.args.includes('developer_instructions="Draft only. Do not run \\"commands\\"."'), true);
  assert.equal(first.fixture.args.includes("project_doc_max_bytes=0"), true);
  assert.equal(first.fixture.args.includes("--ignore-rules"), true);
  assert.equal(first.fixture.args.includes("read-only"), true);
  assert.equal(first.fixture.args.includes('approval_policy="never"'), true);
  assert.equal(first.fixture.args.includes("features.apps=false"), true);
  assert.equal(first.fixture.args.includes("features.multi_agent=false"), true);
  assert.equal(await readFile(path.join(artifacts, "final.txt"), "utf8"), finalText);
});

test("candidate tool attempts/unknown coverage/failed checks fail the gate while baseline quality stays comparable", () => {
  const base = { variant: "baseline", status: "complete", toolAttempts: 0, coverageComplete: true, quality: { pass: false } };
  assert.equal(evaluationFailed([base, { ...base, variant: "candidate", quality: { pass: true } }]), false);
  assert.equal(evaluationFailed([{ ...base, variant: "candidate", toolAttempts: 1, quality: { pass: true } }]), true);
  assert.equal(evaluationFailed([{ ...base, variant: "candidate", coverageComplete: false, quality: { pass: true } }]), true);
  assert.equal(evaluationFailed([{ ...base, variant: "candidate" }]), true);
});

test("owned child timeout, output limit and startup errors remain explicit", async (t) => {
  const { bin } = await fakeCodex(t);
  const timeout = await runProcess(bin, ["--hang"], { timeoutMs: 150 });
  assert.equal(timeout.failure, "timeout");
  const limit = await runProcess(bin, ["--help"], { maxBytes: 12, timeoutMs: 2000 });
  assert.equal(limit.failure, "output-limit");
  assert.equal(Buffer.byteLength(limit.stdout + limit.stderr), 12);
  const missing = await runProcess(path.join(tmpdir(), "definitely-missing-followups-executable"), [], { timeoutMs: 2000 });
  assert.match(missing.failure, /^spawn:/);
});

test("native error and timeout samples preserve raw artifacts instead of dropping the trial", async (t) => {
  const { bin, dir } = await fakeCodex(t, `console.log(JSON.stringify({type:'error', message:'fixture model unavailable'})); process.exit(2);`);
  const errorDir = path.join(dir, "error"); await mkdir(errorDir);
  const failed = await runSample({ prompt: "Draft only", instructions: null }, { ...config, codexBin: bin }, errorDir);
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.errors, ["fixture model unavailable"]);
  assert.deepEqual(failed.tokens, { input: null, cachedInput: null, output: null, reasoning: null });
  assert.match(await readFile(path.join(errorDir, "events.jsonl"), "utf8"), /fixture model unavailable/);
  const hang = await fakeCodex(t, "setTimeout(() => {}, 10000); await new Promise(() => {});");
  const timeoutDir = path.join(dir, "timeout"); await mkdir(timeoutDir);
  const timed = await runSample({ prompt: "Draft only", instructions: null }, { ...config, codexBin: hang.bin, timeout: 0.15 }, timeoutDir);
  assert.equal(timed.status, "timeout");
  assert.equal(timed.failure, "timeout");
  assert.equal(await readFile(path.join(timeoutDir, "final.txt"), "utf8"), "");
  assert.deepEqual((await readdir(timeoutDir)).sort(), ["events.jsonl", "final.txt", "stderr.txt"]);
});

test("preflight rejects missing capabilities and observed model changes are explicit errors", async (t) => {
  const dir = await temporary(t), unsupported = path.join(dir, "unsupported");
  await writeFile(unsupported, '#!/usr/bin/env node\nconsole.log("fixture --json");\n', { mode: 0o755 });
  await assert.rejects(() => preflight(unsupported), /lacks required flags/);
  const fake = await fakeCodex(t, "console.log(JSON.stringify({type:'thread.started',model:'other-model'}));");
  const artifacts = path.join(dir, "model-mismatch"); await mkdir(artifacts);
  const sample = await runSample({ prompt: "Draft only", instructions: null }, { ...config, codexBin: fake.bin }, artifacts);
  assert.equal(sample.status, "error");
  assert.deepEqual(sample.errors, ["Model identity changed: other-model -> gpt-6-luna"]);
});

test("live orchestration with a fake executable preserves equal pairs and reviewable reports", async (t) => {
  const { bin, dir } = await fakeCodex(t);
  const result = await runEvaluation(parseArgs(["--live", "--codex-bin", bin, "--case", "compact-offer", "--repeats", "2", "--out", path.join(dir, "run")]));
  assert.deepEqual(result.results.samples.map(({ variant, status }) => [variant, status]), [["baseline", "complete"], ["candidate", "complete"], ["candidate", "complete"], ["baseline", "complete"]]);
  assert.equal(result.results.summary.variants.baseline.samples, 2);
  assert.equal(result.results.summary.variants.candidate.checkPassSamples, 2);
  assert.equal(result.results.summary.variants.baseline.missingModelIdentity, 0);
  const report = await readFile(path.join(result.out, "report.md"), "utf8");
  assert.match(report, /SMOKE \/ INCONCLUSIVE/);
  assert.match(report, /Human review rubric/);
  assert.match(report, /Add empty queue coverage/);
  assert.match(report, /not semantic proof/);
  assert.equal((await readdir(path.join(result.out, "samples/compact-offer"))).length, 4);
});

test("summary and report include failures, missing usage and paired failure times", () => {
  const parsed = parseEvents("");
  const quality = checkQuality(offer, "");
  const samples = [
    { ...parsed, variant: "baseline", caseId: offer.id, repeat: 0, status: "timeout", wallMs: 1000, failure: "timeout", quality, artifactPath: "a" },
    { ...parsed, variant: "candidate", caseId: offer.id, repeat: 0, status: "error", wallMs: 20, failure: "spawn failed", quality, artifactPath: "b" },
  ];
  const summary = summarize(samples);
  assert.equal(summary.variants.baseline.timeouts, 1);
  assert.equal(summary.variants.candidate.errors, 1);
  assert.equal(summary.variants.baseline.missingUsage, 1);
  assert.equal(summary.variants.candidate.wallMs.median, 20);
  assert.equal(summary.pairedWallDeltaMs.median, -980);
  assert.equal(summary.variants.baseline.tokens.input.observedTotal, null);
  const report = reportMarkdown({ config: { repeats: 1 }, revisions: { baseline: {}, candidate: {} } }, { samples, summary });
  assert.match(report, /including failures/);
  assert.match(report, /spawn failed/);
  assert.match(report, /unknown \(1 missing\)/);
});

test("report repeat evidence reflects observed complete pairs for every requested case", () => {
  const parsed = parseEvents(jsonl({ type: "turn.completed" }));
  const quality = checkQuality(offer, finalText);
  const samples = Array.from({ length: 5 }, (_, repeat) => ["baseline", "candidate"].map((variant) => ({
    ...parsed, variant, caseId: offer.id, repeat, status: "complete", wallMs: 20, finalText, quality, artifactPath: `${repeat}-${variant}`,
  }))).flat();
  const manifest = { config: { repeats: 5 }, revisions: { baseline: {}, candidate: {} } };
  const report = (rows, overrides = {}) => reportMarkdown({ ...manifest, ...overrides }, { samples: rows, summary: summarize(rows) });
  assert.match(report([]), /NO MEASUREMENTS/);
  assert.doesNotMatch(report([]), /Five or more/);
  assert.match(report([], { dryRun: true, selectedCases: [offer.id], schedule: [] }), /NO MEASUREMENTS/);
  assert.match(report(samples.slice(0, 2)), /SMOKE \/ INCONCLUSIVE/);
  assert.doesNotMatch(report(samples.slice(0, 2)), /Five or more/);
  assert.match(report(samples.slice(0, -1)), /SMOKE \/ INCONCLUSIVE/);
  assert.match(report(samples, { selectedCases: [offer.id, "missing-case"] }), /SMOKE \/ INCONCLUSIVE/);
  assert.match(report(samples, { config: { repeats: 6 } }), /SMOKE \/ INCONCLUSIVE/);
  assert.match(report(samples, { interrupted: true }), /SMOKE \/ INCONCLUSIVE/);
  assert.match(report(samples, { error: "stopped early" }), /SMOKE \/ INCONCLUSIVE/);
  const failed = samples.map((sample, index) => index === 9 ? { ...sample, status: "error", failure: "fixture failure" } : sample);
  const failedReport = report(failed);
  assert.match(failedReport, /SMOKE \/ INCONCLUSIVE/);
  assert.match(failedReport, /fixture failure/);
  assert.match(failedReport, /including failures/);
  assert.equal(summarize(failed).pairs.length, 5);
  assert.match(report(samples), /Five or more complete paired repeats per case/);
  assert.match(report(samples), /not a statistical significance claim/);
  assert.doesNotMatch(report(samples), /SMOKE \/ INCONCLUSIVE/);
});
