// Only a few suggestion workers run at once: a burst of threads finishing together (an agent team,
// say) queues instead of starting a worker, and its tokens, for every one of them at the same time.
// A draft waiting its turn shows nothing; one that moves on while waiting never starts. The
// message draft for a clicked follow-up is never held up. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, sleep, until } from "./helpers.mjs";

const MAX = 4; // MAX_CONCURRENT_DRAFTS in server.ts

/** A fake BB with threads t1..t8, worker threads the test finishes by hand, and `failFirst` spawns that fail. */
async function boot({ failFirst = 0, metadata = {} } = {}) {
  const world = { workers: {}, spawnCalls: 0, spawned: [], stops: [], metadata: structuredClone(metadata) };
  const row = (id) => makeThreadResponse({ id, status: "idle", parentThreadId: null, visibility: "visible", projectId: "p", environmentId: "e" });
  const host = createFakePluginHost({
    pluginId: "followups",
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => world.metadata[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          world.metadata[threadId] = { ...(world.metadata[threadId] ?? {}), ...set };
          return {};
        },
        get: async ({ threadId }) =>
          world.workers[threadId]
            ? { id: threadId, status: world.workers[threadId].status, environmentId: "e", projectId: "p", visibility: "hidden" }
            : row(threadId),
        list: async (args) => (args.parentThreadId ? [] : [{ id: "live" }]),
        output: async ({ threadId }) => ({ output: world.workers[threadId] ? (world.workers[threadId].output ?? "") : "The answer." }),
        spawn: async (args) => {
          world.spawnCalls += 1;
          if (world.spawnCalls <= failFirst) throw new Error("environment unavailable");
          const id = `worker${world.spawned.length + 1}`;
          world.workers[id] = { status: "active", output: null, prompt: args.prompt, title: args.title };
          world.spawned.push(id);
          return { id };
        },
        archive: async () => ({}),
        stop: async ({ threadId }) => {
          world.stops.push(threadId);
          return {};
        },
        delete: async () => ({ ok: true }),
        events: { list: async () => [] },
        promptHistory: async () => [],
      },
      ...modelStubs(),
    },
  });
  await plugin(host.bb);
  const rpc = (name, input) => host.harness.callRpc(name, input);
  const OUTPUT = '[{"label": "Add a test", "why": "The fix shipped untested"}]';
  return {
    world, rpc,
    shown: (id) => rpc("followups_get", { threadId: id }),
    /** Thread `id` finishes with an answer that says so. */
    idle: (id) => host.harness.emitThreadEvent("thread.idle", { thread: row(id), lastAssistantText: `The answer of ${id}.` }),
    active: (id) => host.harness.emitThreadEvent("thread.active", { thread: row(id) }),
    /** The worker finishes, and BB says so. */
    finish: async (workerId) => {
      world.workers[workerId].status = "idle";
      world.workers[workerId].output = OUTPUT;
      await host.harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: workerId, status: "idle", visibility: "hidden", projectId: "p", environmentId: "e" }),
        lastAssistantText: OUTPUT,
      });
    },
    forWhom: (workerId) => /The answer of (t\d+)\./.exec(world.workers[workerId].prompt)?.[1],
    logs: () => host.harness.logEntries.map((l) => l.message),
    dispose: () => host.harness.dispose(),
  };
}
const burst = async (w, ids) => { for (const id of ids) await w.idle(id); };

test("no more than four drafts run at once, and the rest show nothing while they wait", async () => {
  const w = await boot();
  await burst(w, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  await until(() => w.world.spawned.length === MAX);
  await sleep(400);
  assert.equal(w.world.spawned.length, MAX, "the fifth and sixth are queued");
  assert.equal((await w.shown("t1")).status, "working");
  assert.equal((await w.shown("t5")).status, "empty", "no skeleton for a draft that hasn't started");
  assert.equal((await w.shown("t6")).status, "empty");
  assert.ok(w.logs().some((m) => /t5 is waiting for a free worker/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

test("a finished worker hands its place to the next draft in line, in the order they arrived", async () => {
  const w = await boot();
  await burst(w, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  await until(() => w.world.spawned.length === MAX);
  await sleep(700); // past every worker's first look
  await w.finish("worker1");
  await until(() => w.world.spawned.length === MAX + 1);
  assert.equal(w.forWhom("worker5"), "t5");
  await w.finish("worker2");
  await until(() => w.world.spawned.length === MAX + 2);
  assert.equal(w.forWhom("worker6"), "t6");
  await until(async () => (await w.shown("t1")).status === "ready");
  await w.dispose();
});

test("a draft whose thread moves on while it waits never starts a worker, and its place goes to the next in line", async () => {
  const w = await boot();
  await burst(w, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  await until(() => w.world.spawned.length === MAX);
  await w.active("t5"); // the user carried on in t5
  await sleep(700);
  await w.finish("worker1");
  await until(() => w.world.spawned.length === MAX + 1);
  assert.equal(w.forWhom("worker5"), "t6", "t6's draft took the place, not t5's");
  await sleep(300);
  assert.equal(w.world.spawned.length, MAX + 1, "t5's draft never started");
  await w.dispose();
});

test("a draft that can't start a worker gives its place back", async () => {
  const w = await boot({ failFirst: MAX });
  await burst(w, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  await until(() => w.world.spawned.length === 2);
  assert.deepEqual([w.forWhom("worker1"), w.forWhom("worker2")], ["t5", "t6"]);
  for (const id of ["t1", "t2", "t3", "t4"]) assert.equal((await w.shown(id)).status, "empty", `${id} isn't left 'working'`);
  await w.dispose();
});

test("a draft stopped because its thread moved on gives its place back", async () => {
  const w = await boot();
  await burst(w, ["t1", "t2", "t3", "t4", "t5"]);
  await until(() => w.world.spawned.length === MAX);
  // Drafts that start together can reach their spawn in any order: find t1's worker.
  const t1Worker = w.world.spawned.find((id) => w.forWhom(id) === "t1");
  await w.active("t1");
  await until(() => w.world.spawned.length === MAX + 1, 2000);
  assert.equal(w.forWhom("worker5"), "t5");
  assert.ok(w.world.stops.includes(t1Worker));
  await w.dispose();
});

test("the message draft for a clicked follow-up isn't held up by a full house", async () => {
  const w = await boot({ metadata: { t8: { status: "ready", suggestions: [{ id: "a1", label: "Add a test" }], updatedAt: Date.now() } } });
  await burst(w, ["t1", "t2", "t3", "t4", "t5"]);
  await until(() => w.world.spawned.length === MAX);
  const clicked = w.rpc("followups_expand", { threadId: "t8", id: "a1" }).then((value) => ({ value }), (error) => ({ error }));
  await until(() => w.world.spawned.length === MAX + 1, 2000);
  assert.equal(w.world.workers.worker5.title, "Followups draft");
  await w.dispose();
  await clicked;
});
