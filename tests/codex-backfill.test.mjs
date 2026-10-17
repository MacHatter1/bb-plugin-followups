import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { archiveCandidates, findCandidates } from "../scripts/archive-existing-codex-followups.mjs";

const exec = promisify(execFile);
const NOW = Date.now();
const PROMPT = "You write the suggested replies shown under a coding assistant's answer: the next messages the user might send.\n\n# What the user asked\nFix it\n\n# The assistant's answer\nFixed.";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "followups-backfill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new Database(join(root, "state_10.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, first_user_message TEXT, updated_at_ms INTEGER, archived INTEGER)");
  await writeFile(join(root, "state_9.sqlite"), "wrong database version");
  t.after(() => db.close());
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
  async function add(id, { first = PROMPT, last = first, finished = true, recent = false, archived = 0, missing = false } = {}) {
    const rollout = join(root, `${id}.jsonl`);
    if (!missing) await writeFile(rollout, [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: last }] } },
      ...(finished ? [{ type: "event_msg", payload: { type: "task_complete" } }] : []),
    ].map((item) => JSON.stringify(item)).join("\n"));
    insert.run(id, rollout, first, NOW - (recent ? 60_000 : 600_000), archived);
  }
  return { root, db, add };
}

test("backfill selects only finished old workers that were not continued by the user", async (t) => {
  const f = await fixture(t);
  await f.add("eligible");
  await f.add("recent", { recent: true });
  await f.add("continued", { last: "Keep working on my real project." });
  await f.add("unfinished", { finished: false });
  await f.add("missing", { missing: true });
  await f.add("already-archived", { archived: 1 });
  await f.add("ordinary", { first: "Please review this prompt:\n" + PROMPT });
  const report = await findCandidates(f.root, NOW);
  assert.ok(report.database.endsWith("state_10.sqlite"));
  assert.deepEqual(report.threads.map((row) => row.id), ["eligible"]);
  assert.deepEqual(new Set(report.skipped.map((row) => row.id)), new Set(["recent", "continued", "unfinished", "missing"]));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM threads WHERE archived=0").get().n, 6, "discovery never changes state");
});

test("backfill defaults to dry-run without starting a provider", async (t) => {
  const f = await fixture(t);
  await f.add("eligible");
  const { stdout } = await exec(process.execPath, ["scripts/archive-existing-codex-followups.mjs",
    "--codex-home", f.root, "--codex-bin", "/nonexistent-provider", "--json"]);
  const result = JSON.parse(stdout);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.threads.map((row) => row.id), ["eligible"]);
  assert.equal(f.db.prepare("SELECT archived FROM threads").get().archived, 0);
});

test("apply sends only initialize and archive requests, recording per-chat failures", async (t) => {
  const f = await fixture(t);
  const messagesPath = join(f.root, "requests.jsonl");
  const provider = join(f.root, "fake-codex.mjs");
  await writeFile(provider, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({input:process.stdin});
lines.on("line", line => {
  appendFileSync(${JSON.stringify(messagesPath)},line+"\\n");
  const request=JSON.parse(line);
  if(!request.id)return;
  const response=request.params.threadId==="fails"
    ? {id:request.id,error:{message:"active writer"}}
    : {id:request.id,result:{}};
  process.stdout.write(JSON.stringify(response)+"\\n");
});
`, { mode: 0o755 });
  const result = await archiveCandidates(provider, f.root, [{ id: "done" }, { id: "fails" }]);
  assert.deepEqual(result, { archived: ["done"], failed: [{ id: "fails", reason: "active writer" }] });
  const messages = (await readFile(messagesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.method), ["initialize", "initialized", "thread/archive", "thread/archive"]);
  assert.deepEqual(messages.slice(2).map((message) => message.params.threadId), ["done", "fails"]);
});
