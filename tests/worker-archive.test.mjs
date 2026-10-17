// Finished and stale worker chats are archived through BB (which forwards to
// capable providers). Only the existing age/retention sweep deletes them.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, until } from "./helpers.mjs";

const OUTPUT = '[{"label":"Add a test","why":"Cover the fix"}]';
const READY = { status: "ready", suggestions: [{ id: "a1", label: "Add a test" }], updatedAt: Date.now() };

async function boot(t, { keepWorkers = 0, metadata = {}, leftovers = false } = {}) {
  const parent = makeThreadResponse({ id: "t1", projectId: "p", environmentId: "e", status: "idle" });
  const worker = (id, createdAt = Date.now()) => makeThreadResponse({
    id, projectId: "p", environmentId: "e", status: "idle", visibility: "hidden",
    origin: "plugin", originPluginId: "followups", title: "Followups worker", createdAt,
  });
  const world = {
    metadata: structuredClone(metadata), workers: leftovers ? { old: worker("old", Date.now() - 600_000) } : {},
    spawned: [], operations: [], archiveFails: false, archiveGate: null, environmentLive: true,
  };
  const host = createFakePluginHost({
    pluginId: "followups", settings: { keepWorkers },
    sdk: {
      ...modelStubs(),
      threads: {
        get: async ({ threadId }) => world.workers[threadId] ?? parent,
        getPluginMetadata: async ({ threadId }) => world.metadata[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          world.metadata[threadId] = { ...world.metadata[threadId], ...set };
          return {};
        },
        list: async (args) => {
          if (args.parentThreadId) return [];
          if (args.originPluginId) return Object.values(world.workers)
            .filter((row) => (row.archivedAt !== null) === args.archived)
            .slice(args.offset, args.offset + args.limit);
          return world.environmentLive ? [parent] : [];
        },
        spawn: async (args) => {
          const id = `worker${world.spawned.length + 1}`;
          world.workers[id] = { ...worker(id), title: args.title };
          world.spawned.push(id);
          return world.workers[id];
        },
        output: async ({ threadId }) => ({ output: world.workers[threadId]
          ? world.workers[threadId].title === "Followups draft" ? "Please add regression coverage." : OUTPUT
          : "The fix is ready." }),
        events: { list: async () => [] },
        promptHistory: async () => [],
        stop: async ({ threadId }) => { world.operations.push(`stop:${threadId}`); return { ok: true }; },
        archive: async ({ threadId }) => {
          world.operations.push(`archive:${threadId}`);
          await world.archiveGate;
          if (world.archiveFails) throw new Error("archive unavailable");
          world.workers[threadId].archivedAt = Date.now();
          return { ok: true, archivedThreadIds: [threadId] };
        },
        delete: async ({ threadId }) => {
          world.operations.push(`delete:${threadId}`);
          delete world.workers[threadId];
          return { ok: true };
        },
      },
    },
  });
  await plugin(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  return {
    world, host,
    rpc: (name, input) => host.harness.behavior.callRpc(name, input),
    idle: () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: parent, lastAssistantText: "The fix is ready." }),
    active: () => host.harness.behavior.emitThreadEvent("thread.active", { thread: { ...parent, status: "active" } }),
    cleanup: (...args) => host.harness.behavior.runCli(["cleanup", ...args, "--json"]),
  };
}

for (const keepWorkers of [0, 2]) {
  test(`consumed suggestion output archives its worker with keepWorkers=${keepWorkers}, without deleting`, async (t) => {
    const w = await boot(t, { keepWorkers });
    await w.idle();
    await until(() => w.world.workers.worker1?.archivedAt != null);
    assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1"]);
    assert.equal((await w.rpc("followups_get", { threadId: "t1" })).status, "ready");
  });
}

test("a consumed message draft archives its worker without deleting it", async (t) => {
  const w = await boot(t, { metadata: { t1: READY } });
  const result = await w.rpc("followups_expand", { threadId: "t1", id: "a1" });
  assert.equal(result.text, "Please add regression coverage.");
  await until(() => w.world.operations.includes("archive:worker1"));
  assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1"]);
});

test("a stale worker is stopped and archived as soon as its parent moves on", async (t) => {
  const w = await boot(t);
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await w.active();
  await until(() => w.world.operations.includes("archive:worker1"));
  assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1"]);
  assert.equal((await w.rpc("followups_get", { threadId: "t1" })).status, "empty");
});

test("provider archive latency does not delay showing follow-ups", async (t) => {
  const w = await boot(t);
  let release;
  w.world.archiveGate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await w.idle();
  await until(() => w.world.operations.includes("archive:worker1"));
  assert.equal((await w.rpc("followups_get", { threadId: "t1" })).status, "ready");
  assert.equal(w.world.workers.worker1.archivedAt, null);
  release();
  await until(() => w.world.workers.worker1.archivedAt !== null);
});

test("reload waits for an archive already in flight without releasing the worker twice", async (t) => {
  const w = await boot(t);
  let release;
  w.world.archiveGate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await w.idle();
  await until(() => w.world.operations.includes("archive:worker1"));
  const disposing = w.host.harness.lifecycle.dispose();
  release();
  await disposing;
  assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1"]);
});

test("cleanup leaves a worker alone while its archive is still in flight", async (t) => {
  const w = await boot(t);
  let release;
  w.world.archiveGate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await w.idle();
  await until(() => w.world.operations.includes("archive:worker1"));
  w.world.workers.worker1.createdAt = Date.now() - 600_000;
  const report = JSON.parse((await w.cleanup()).stdout);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.skipped[0].reason, "in use");
  assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1"]);
  release();
  await until(() => w.world.operations.includes("delete:worker1"));
  assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1", "delete:worker1"]);
});

test("an archive failure retains the worker and logs a warning", async (t) => {
  const w = await boot(t);
  w.world.archiveFails = true;
  await w.idle();
  await until(() => w.host.harness.logEntries.some((entry) => /could not archive worker/.test(entry.message)));
  assert.equal(w.world.workers.worker1.archivedAt, null);
  assert.deepEqual(w.world.operations, ["stop:worker1", "archive:worker1"]);
  assert.equal((await w.rpc("followups_get", { threadId: "t1" })).status, "ready");
});

test("cleanup archives old unarchived leftovers before deleting them", async (t) => {
  const w = await boot(t, { leftovers: true });
  const result = await w.cleanup();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).deleted, ["old"]);
  assert.deepEqual(w.world.operations, ["archive:old", "delete:old"]);
});

test("cleanup retries a failed archive before deleting a leftover", async (t) => {
  const w = await boot(t, { leftovers: true });
  w.world.archiveFails = true;
  const failed = JSON.parse((await w.cleanup()).stdout);
  assert.deepEqual(failed.deleted, []);
  assert.match(failed.skipped[0].reason, /^archive failed:/);
  assert.ok(w.world.workers.old);
  w.world.archiveFails = false;
  assert.deepEqual(JSON.parse((await w.cleanup()).stdout).deleted, ["old"]);
  assert.deepEqual(w.world.operations, ["archive:old", "archive:old", "delete:old"]);
});

test("cleanup retries archiving retained debug workers without deleting them", async (t) => {
  const w = await boot(t, { leftovers: true, keepWorkers: 1 });
  assert.deepEqual(JSON.parse((await w.cleanup()).stdout).kept, ["old"]);
  assert.deepEqual(w.world.operations, ["archive:old"]);
});

test("cleanup dry-run does not archive or delete anything", async (t) => {
  const w = await boot(t, { leftovers: true });
  assert.deepEqual(JSON.parse((await w.cleanup("--dry-run")).stdout).deleted, ["old"]);
  assert.deepEqual(w.world.operations, []);
});

test("cleanup keeps the environment guard for archived workers", async (t) => {
  const w = await boot(t, { leftovers: true });
  w.world.workers.old.archivedAt = Date.now();
  w.world.environmentLive = false;
  const report = JSON.parse((await w.cleanup()).stdout);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.skipped[0].reason, "its environment has no other live thread");
  assert.deepEqual(w.world.operations, []);
});
