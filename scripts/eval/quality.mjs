export function checkQuality(entry, raw) {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
  const text = raw.trim(), lower = text.toLowerCase();
  if (entry.kind === "suggest") {
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* Shape failure is retained below. */ }
    const array = Array.isArray(parsed);
    check("raw-json-array", array);
    const shape = array && parsed.every((item) => item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).sort().join(",") === "label,why" && typeof item.label === "string" && typeof item.why === "string");
    check("exact-label-why-objects", shape);
    check("suggestion-count", array && parsed.length >= entry.expected.min && parsed.length <= entry.expected.max, `${entry.expected.min}..${entry.expected.max}`);
    if (shape) {
      const labels = parsed.map((item) => item.label.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
      check("distinct-labels", new Set(labels).size === labels.length);
      check("label-length", parsed.every(({ label }) => {
        const words = label.trim().split(/\s+/).length;
        return words >= 3 && words <= (entry.style === "detailed" ? 9 : 8) && label.length <= 60 && !/[.!?:;]$/.test(label) && !/["“”]/.test(label);
      }));
      check("why-length", parsed.every(({ why }) => why.trim() && why.trim().split(/\s+/).length <= (entry.style === "detailed" ? 14 : 12)));
    }
  } else {
    check("nonempty-plain-draft", text.length > 0 && !/^[\[{"“]/.test(text) && !text.includes("```") && !/^#{1,6}\s/m.test(text));
    check("draft-word-budget", text.split(/\s+/).length <= 80);
    check("no-obvious-completion-claim", !/\b(?:i|we)(?:['’]ve| have)?\s+(?:already\s+)?(?:run|ran|executed|committed|pushed|deployed|implemented|added|updated|fixed|completed|verified|tested|did)\b/i.test(text));
  }
  for (const term of entry.expected.required) check(`required:${term}`, lower.includes(term.toLowerCase()));
  for (const term of entry.expected.forbidden) check(`forbidden:${term}`, !lower.includes(term.toLowerCase()));
  if (entry.expected.languageTerms) check("language-literal-proxy", entry.expected.languageTerms.some((term) => lower.includes(term)));
  if (entry.expected.conservation) check("constraint-literal-proxy", entry.expected.conservation.some((term) => lower.includes(term)));
  return { pass: checks.every(({ pass }) => pass), passed: checks.filter(({ pass }) => pass).length, total: checks.length, checks };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = (values) => values.length ? { median: median(values), min: Math.min(...values), max: Math.max(...values) } : { median: null, min: null, max: null };
export function summarize(samples) {
  const variants = {};
  for (const variant of ["baseline", "candidate"]) {
    const rows = samples.filter((sample) => sample.variant === variant);
    variants[variant] = {
      samples: rows.length, complete: rows.filter((sample) => sample.status === "complete").length,
      checkPassSamples: rows.filter((sample) => sample.quality.pass).length,
      passedChecks: rows.reduce((sum, sample) => sum + sample.quality.passed, 0), totalChecks: rows.reduce((sum, sample) => sum + sample.quality.total, 0),
      errors: rows.filter((sample) => sample.status === "error").length, timeouts: rows.filter((sample) => sample.status === "timeout").length, interrupted: rows.filter((sample) => sample.status === "interrupted").length,
      toolAttempts: rows.reduce((sum, sample) => sum + sample.toolAttempts, 0),
      incompleteTelemetry: rows.filter((sample) => !sample.coverageComplete).length,
      missingUsage: rows.filter((sample) => sample.tokens.input === null || sample.tokens.output === null).length,
      missingModelIdentity: rows.filter((sample) => sample.observedModel === null).length,
      wallMs: range(rows.map((sample) => sample.wallMs)),
      tokens: Object.fromEntries(["input", "cachedInput", "output", "reasoning"].map((key) => [key, { observedTotal: rows.some((sample) => sample.tokens[key] !== null) ? rows.reduce((sum, sample) => sum + (sample.tokens[key] ?? 0), 0) : null, missing: rows.filter((sample) => sample.tokens[key] === null).length }])),
    };
  }
  const pairs = samples.filter((sample) => sample.variant === "baseline").map((baseline) => {
    const candidate = samples.find((sample) => sample.variant === "candidate" && sample.caseId === baseline.caseId && sample.repeat === baseline.repeat);
    return candidate ? { caseId: baseline.caseId, repeat: baseline.repeat, baselineStatus: baseline.status, candidateStatus: candidate.status, wallDeltaMs: candidate.wallMs - baseline.wallMs } : null;
  }).filter(Boolean);
  return { variants, pairs, pairedWallDeltaMs: range(pairs.map((pair) => pair.wallDeltaMs)) };
}

const number = (value) => value === null ? "unknown" : Math.round(value).toString();
const fence = (text) => { const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length)); const marker = "`".repeat(longest + 1); return `${marker}\n${text}\n${marker}`; };
export function reportMarkdown(manifest, results) {
  const summary = results.summary;
  const caseIds = manifest.selectedCases ?? [...new Set(results.samples.map((sample) => sample.caseId))];
  const completePairsPerCase = caseIds.map((caseId) => Array.from({ length: manifest.config.repeats }, (_, repeat) =>
    ["baseline", "candidate"].every((variant) => results.samples.some((sample) => sample.caseId === caseId && sample.repeat === repeat && sample.variant === variant && sample.status === "complete")),
  ).filter(Boolean).length);
  const completeSchedule = caseIds.length > 0 && completePairsPerCase.every((count) => count === manifest.config.repeats);
  const evidence = manifest.dryRun || results.samples.length === 0
    ? "**NO MEASUREMENTS: no samples have run. Do not infer a speedup or quality improvement.**"
    : manifest.error || manifest.interrupted || !completeSchedule || completePairsPerCase.some((count) => count < 5)
      ? "**SMOKE / INCONCLUSIVE: incomplete run or fewer than five complete paired repeats per case. Do not infer a speedup or quality improvement.**"
      : "Five or more complete paired repeats per case; timings are descriptive measurements, not a statistical significance claim.";
  const lines = ["# Followups prompt comparison", "", evidence, "", "Checks are deterministic proxies, not semantic proof. Review paired raw outputs below.", "", `Baseline: ${manifest.revisions.baseline.commit} / ${manifest.revisions.baseline.sourceHash}`, `Candidate: ${manifest.revisions.candidate.commit} (dirty: ${manifest.revisions.candidate.dirty}) / ${manifest.revisions.candidate.sourceHash}`, "", "Execution mode: native-codex-session. This reproduces captured plugin prompts and own session instructions, not full BB host parity. Read-only sandbox permits tool attempts. User configuration/rules are disabled where supported; native skill discovery and provider context may still differ. Requested model identity is not observed identity when telemetry omits it.", "", "| Variant | Samples | Complete | Check passes | Tools | Errors | Timeouts | Missing usage | Incomplete telemetry | Missing model | Wall median [min, max] ms |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"];
  if (manifest.error || manifest.interrupted) lines.splice(4, 0, `**${manifest.interrupted ? "INTERRUPTED" : "RUN ERROR"}: ${manifest.error ?? "Execution stopped before the proposed schedule completed."}**`, "");
  for (const variant of ["baseline", "candidate"]) {
    const row = summary.variants[variant];
    lines.push(`| ${variant} | ${row.samples} | ${row.complete} | ${row.checkPassSamples} (${row.passedChecks}/${row.totalChecks} checks) | ${row.toolAttempts} | ${row.errors} | ${row.timeouts} | ${row.missingUsage} | ${row.incompleteTelemetry} | ${row.missingModelIdentity} | ${number(row.wallMs.median)} [${number(row.wallMs.min)}, ${number(row.wallMs.max)}] |`);
  }
  lines.push("", `Paired candidate minus baseline wall time, including failures: median ${number(summary.pairedWallDeltaMs.median)} ms; range [${number(summary.pairedWallDeltaMs.min)}, ${number(summary.pairedWallDeltaMs.max)}] ms. Failures remain in sample counts; compare statuses before interpreting times.`, "", "Token totals below cover only reported fields; missing values remain unknown.", "", "| Variant | Input | Cached input | Output | Reasoning |", "| --- | --- | --- | --- | --- |");
  for (const variant of ["baseline", "candidate"]) lines.push(`| ${variant} | ${["input", "cachedInput", "output", "reasoning"].map((key) => { const value = summary.variants[variant].tokens[key]; return `${number(value.observedTotal)} (${value.missing} missing)`; }).join(" | ")} |`);
  if (manifest.dryRun) {
    lines.push("", "## Proposed schedule", "", "No samples have run. B = baseline; C = candidate.", "");
    for (const caseId of manifest.selectedCases) lines.push(`- ${caseId}: ${manifest.schedule.filter((sample) => sample.caseId === caseId).map((sample) => sample.variant === "baseline" ? "B" : "C").join(" → ")}`);
  }
  lines.push("", "## Human review rubric", "", "For each pair, judge grounding in the actual conversation, relevance to the next useful action, distinctness of suggestions, preservation of constraints and language, and absence of invented details. For expansions, verify that the draft asks the receiving agent to act and makes no claim the drafting worker performed the action. Check the raw event trace for tool attempts, failures, and unknown telemetry. Literal keyword passes cannot establish these properties.", "", "## Paired raw outputs", "");
  for (const pair of summary.pairs) {
    lines.push(`### ${pair.caseId}, repeat ${pair.repeat + 1}`, "");
    for (const variant of ["baseline", "candidate"]) {
      const sample = results.samples.find((sample) => sample.variant === variant && sample.caseId === pair.caseId && sample.repeat === pair.repeat);
      lines.push(`**${variant}** — ${sample.status}, ${number(sample.wallMs)} ms, ${sample.toolAttempts} tool attempts; checks ${sample.quality.passed}/${sample.quality.total}.`, "", `Artifacts: [events](${sample.artifactPath}/events.jsonl), [stderr](${sample.artifactPath}/stderr.txt), [final](${sample.artifactPath}/final.txt).`, "", fence(sample.finalText), "");
      const failed = sample.quality.checks.filter((check) => !check.pass).map((check) => check.name);
      if (failed.length || sample.errors.length || sample.failure || sample.modelMismatch) lines.push(`Failures: ${JSON.stringify({ checks: failed, events: sample.errors, process: sample.failure, model: sample.modelMismatch })}`, "");
    }
  }
  return lines.join("\n");
}
