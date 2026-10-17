#!/usr/bin/env node
// Backfill provider-only chats left by older Followups releases. Discovery is
// read-only; --apply archives through Codex's API and never deletes anything.
import { execFile, spawn } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MIN_AGE_MS = 5 * 60_000;
const PROMPT_PREFIXES = [
  "Suggest 2 or 3 follow-ups the user might send next, based on the assistant's answer below.",
  "You write the suggested replies shown under a coding assistant's answer: the next messages the user might send.",
  "You write the next message a user sends to an AI coding assistant. They clicked a suggested follow-up; turn it into the full message they would send.",
];
const isWorkerPrompt = (text) => PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));

export async function findCandidates(codexHome, now = Date.now()) {
  const databases = (await readdir(codexHome))
    .map((name) => ({ name, version: Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1] ?? -1) }))
    .filter(({ version }) => version >= 0)
    .sort((a, b) => b.version - a.version);
  if (!databases.length) throw new Error("No Codex state database found.");
  const database = join(codexHome, databases[0].name);
  const conditions = PROMPT_PREFIXES.map((prefix) => {
    const literal = `'${prefix.replaceAll("'", "''")}'`;
    return `substr(first_user_message, 1, length(${literal})) = ${literal}`;
  });
  const { stdout } = await exec("sqlite3", ["-readonly", "-json", database,
    `SELECT id, rollout_path AS rolloutPath, updated_at_ms AS updatedAt
     FROM threads WHERE archived = 0 AND (${conditions.join(" OR ")})
     ORDER BY updated_at_ms DESC, id`], { maxBuffer: 16 * 1024 * 1024 });
  const threads = [];
  const skipped = [];
  for (const row of JSON.parse(stdout || "[]")) {
    if (!Number.isFinite(row.updatedAt) || now - row.updatedAt < MIN_AGE_MS) {
      skipped.push({ id: row.id, reason: "updated within five minutes, or timestamp unavailable" });
      continue;
    }
    // A user may have reopened a worker chat and continued it. Check the last
    // user message and turn completion instead of relying on its first prompt.
    let lastUser = "";
    let turnFinished = false;
    try {
      // Worker rollouts are small. Bound reads in case a user repurposed one.
      if ((await stat(row.rolloutPath)).size > 8 * 1024 * 1024) throw new Error("Rollout too large.");
      for (const line of (await readFile(row.rolloutPath, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        const payload = item.payload;
        if (item.type === "response_item" && payload?.type === "message" && payload.role === "user") {
          lastUser = (payload.content ?? []).map((part) => part.text ?? "").join("\n");
          turnFinished = false;
        }
        if (item.type === "event_msg") {
          if (payload?.type === "task_started") turnFinished = false;
          if (payload?.type === "task_complete" || payload?.type === "turn_aborted") turnFinished = true;
        }
      }
    } catch {
      skipped.push({ id: row.id, reason: "rollout could not be verified" });
      continue;
    }
    if (!isWorkerPrompt(lastUser) || !turnFinished) {
      skipped.push({ id: row.id, reason: "chat continued beyond the worker prompt, or last turn is unfinished" });
      continue;
    }
    threads.push({ id: row.id, updatedAt: row.updatedAt });
  }
  return { database, threads, skipped };
}

export async function archiveCandidates(codexBin, codexHome, threads, onProgress = () => {}) {
  const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let closedError = null;
  const close = (error) => {
    closedError = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on("error", close);
  child.on("exit", () => close(new Error("Codex app-server exited.")));
  child.stdin.on("error", close);
  lines.on("error", close);
  child.stderr.resume();
  lines.on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(response.error.message ?? "Codex request failed."));
    else entry.resolve(response.result);
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    if (closedError) { reject(closedError); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      close(new Error("Codex archive request timed out."));
      child.kill();
    }, 30_000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const archived = [];
  const failed = [];
  try {
    await request("initialize", { clientInfo: { name: "followups-archive-backfill", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    for (const thread of threads) {
      if (closedError) throw closedError;
      try {
        await request("thread/archive", { threadId: thread.id });
        archived.push(thread.id);
      } catch (error) {
        failed.push({ id: thread.id, reason: error.message });
      }
      onProgress(archived.length + failed.length, threads.length);
    }
    return { archived, failed };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function main(args) {
  const options = { apply: false, json: false, codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"), codexBin: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") continue;
    else if (arg === "--json") options.json = true;
    else if (arg === "--codex-home" || arg === "--codex-bin") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      options[arg === "--codex-home" ? "codexHome" : "codexBin"] = value;
    } else if (arg === "--help") {
      console.log("Usage: node scripts/archive-existing-codex-followups.mjs [--dry-run | --apply] [--json] [--codex-home PATH] [--codex-bin PATH]\nDefault: read-only preview. --apply archives matched Codex chats; nothing is deleted.");
      return;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("Choose --apply or --dry-run, not both.");
  const preview = await findCandidates(resolve(options.codexHome));
  let result = { dryRun: !options.apply, ...preview };
  if (options.apply && preview.threads.length) {
    const bundledCodex = "/Applications/Codex.app/Contents/Resources/codex";
    const codexBin = options.codexBin ?? await access(bundledCodex).then(() => bundledCodex, () => "codex");
    result = { ...result, ...await archiveCandidates(codexBin, resolve(options.codexHome), preview.threads, (done, total) => {
      if (!options.json && (done % 25 === 0 || done === total)) console.error(`Processed ${done}/${total} chats.`);
    }) };
    if (result.failed.length) process.exitCode = 1;
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${options.apply ? "Matched" : "Would archive"} ${preview.threads.length} Codex follow-up chat(s); skipped ${preview.skipped.length}.`);
    if (options.apply) console.log(`Archived ${result.archived?.length ?? 0}; failed ${result.failed?.length ?? 0}.`);
    else for (const thread of preview.threads.slice(0, 10)) console.log(`${thread.id}  ${new Date(thread.updatedAt).toISOString()}`);
    console.log("No chats are deleted. Preview all IDs with --json; archive with --apply.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
