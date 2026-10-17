import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const ACTIONS = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change", "tool_call", "image_view", "collab_tool_call"]);
const NON_ACTIONS = new Set(["reasoning", "agent_message"]);
const EVENTS = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "error", "item.started", "item.updated", "item.completed"]);
const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null;

export function parseEvents(raw) {
  const tools = new Map(), messages = new Map(), unknownEvents = new Set(), unknownItems = new Set(), errors = [];
  let usage = null, completed = false, observedModel = null;
  for (const line of raw.split("\n").filter((line) => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { errors.push("Malformed JSONL event"); unknownEvents.add("malformed-json"); continue; }
    if (!event || typeof event !== "object") { unknownEvents.add("non-object"); continue; }
    if (!EVENTS.has(event.type)) unknownEvents.add(String(event.type));
    const emittedModel = event.model ?? event.thread?.model;
    if (typeof emittedModel === "string") {
      if (observedModel && observedModel !== emittedModel) errors.push(`Model identity changed: ${observedModel} -> ${emittedModel}`);
      observedModel = emittedModel;
    }
    if (event.type === "turn.completed") { completed = true; usage = event.usage ?? null; }
    if (event.type === "error" || event.type === "turn.failed") errors.push(typeof event.message === "string" ? event.message : JSON.stringify(event.error ?? event));
    if (typeof event.type === "string" && event.type.startsWith("item.")) {
      const item = event.item ?? {}, id = item.id;
      if (ACTIONS.has(item.type)) {
        if (typeof id === "string") tools.set(id, { ...tools.get(id), ...item });
        else unknownItems.add(`${item.type}:missing-id`);
      } else if (!NON_ACTIONS.has(item.type)) unknownItems.add(String(item.type));
      if (item.type === "agent_message" && typeof item.text === "string") {
        if (typeof id === "string") messages.set(id, item.text);
        else { unknownItems.add("agent_message:missing-id"); messages.set("missing-id", item.text); }
      }
    }
  }
  const tokens = {
    input: finite(usage?.input_tokens), cachedInput: finite(usage?.cached_input_tokens), output: finite(usage?.output_tokens),
    reasoning: finite(usage?.reasoning_output_tokens ?? usage?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens),
  };
  return {
    completed, finalText: [...messages.values()].join("\n"), tokens, observedModel,
    toolAttempts: tools.size, toolItems: [...tools.values()], errors,
    unknownEvents: [...unknownEvents], unknownItems: [...unknownItems],
    coverageComplete: completed && unknownEvents.size === 0 && unknownItems.size === 0,
  };
}

/** shell:false and a fresh owned process group; never signal another session. */
export async function runProcess(bin, args, { cwd, input = "", timeoutMs = 120000, maxBytes = 16 * 1024 * 1024, signal } = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure = null, firstEventMs = null, firstOutputMs = null, partial = "", stopped = false;
    const child = spawn(bin, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stop = (reason) => {
      if (stopped) return;
      stopped = true; failure = reason;
      try { if (process.platform === "win32") child.kill("SIGKILL"); else if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure += `: ${error.message}`; }
    };
    const abort = () => stop("interrupted");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      const remaining = Math.max(0, maxBytes - stdout.length - stderr.length);
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) stop("output-limit");
      partial += chunk.toString();
      const lines = partial.split("\n"); partial = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          firstEventMs ??= performance.now() - started;
          if (event.item?.type === "agent_message" && event.item.text) firstOutputMs ??= performance.now() - started;
        } catch { /* The parser reports malformed telemetry. */ }
      }
    });
    child.stderr.on("data", (chunk) => {
      const remaining = Math.max(0, maxBytes - stdout.length - stderr.length);
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) stop("output-limit");
    });
    child.on("error", (error) => { failure = `spawn: ${error.message}`; });
    child.stdin.on("error", () => {}); // Early CLI failure can close stdin.
    child.stdin.end(input);
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), wallMs: performance.now() - started, firstEventMs, firstOutputMs, failure, exitCode, exitSignal });
    });
  });
}

export async function preflight(bin) {
  const version = await runProcess(bin, ["--version"], { timeoutMs: 10000 });
  const help = await runProcess(bin, ["exec", "--help"], { timeoutMs: 10000 });
  const rootHelp = await runProcess(bin, ["--help"], { timeoutMs: 10000 });
  for (const result of [version, help, rootHelp]) if (result.failure || result.exitCode !== 0) throw new Error(`Codex capability preflight failed: ${result.failure ?? result.stderr}`);
  const combined = help.stdout + rootHelp.stdout;
  const required = ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--sandbox", "--skip-git-repo-check", "--config"];
  const missing = required.filter((flag) => !combined.includes(flag));
  if (missing.length) throw new Error(`Codex lacks required flags: ${missing.join(", ")}`);
  return { version: version.stdout.trim(), requiredFlags: required, help: combined };
}

export const nativeConfig = { project_doc_max_bytes: 0, approval_policy: "never", "features.apps": false, "features.multi_agent": false };
export function nativeArgs(capture, config) {
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];
  for (const [key, value] of Object.entries({ ...nativeConfig, model: config.model, model_reasoning_effort: config.reasoning })) args.push("-c", `${key}=${JSON.stringify(value)}`);
  if (capture.instructions !== null) args.push("-c", `developer_instructions=${JSON.stringify(capture.instructions)}`);
  return [...args, "-"];
}

export async function runSample(capture, config, artifactDir, { signal } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "cedar-"));
  const args = nativeArgs(capture, config);
  try {
    const raw = await runProcess(config.codexBin, args, { cwd, input: capture.prompt, timeoutMs: config.timeout * 1000, signal });
    // Preserve evidence before interpretation, including unexpected telemetry.
    await writeFile(path.join(artifactDir, "events.jsonl"), raw.stdout);
    await writeFile(path.join(artifactDir, "stderr.txt"), raw.stderr);
    let parsed;
    try { parsed = parseEvents(raw.stdout); }
    catch (error) { parsed = { ...parseEvents(""), coverageComplete: false, errors: [`Telemetry parser failed: ${error.message}`] }; }
    const mismatch = parsed.observedModel !== null && parsed.observedModel !== config.model;
    const status = raw.failure === "timeout" ? "timeout" : raw.failure === "interrupted" ? "interrupted" : raw.failure || raw.exitCode !== 0 || parsed.errors.length || !parsed.completed || mismatch ? "error" : "complete";
    await writeFile(path.join(artifactDir, "final.txt"), parsed.finalText);
    return { ...parsed, status, commandArguments: args, wallMs: raw.wallMs, firstEventMs: raw.firstEventMs, firstOutputMs: raw.firstOutputMs, exitCode: raw.exitCode, exitSignal: raw.exitSignal, failure: raw.failure, ...(mismatch ? { modelMismatch: `Requested ${config.model}; observed ${parsed.observedModel}` } : {}) };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
