// The plugin hears about a worker finishing from the thread.idle / thread.failed events BB sends
// for every thread, so it waits on those instead of polling the worker every half second; a slow
// poll is only the safety net. Idle events from hidden threads (the workers themselves, other
// plugins' helpers) are ignored without a lookup. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, sleep, until } from "./helpers.mjs";

const OUTPUT = '[{"label": "Add a test", "why": "The fix shipped untested"}]';

/**
 * A fake BB whose worker threads run until the test finishes them. `world.gets` counts every status
 * lookup per thread, so a test can see how often the plugin looked at a worker. `metadata` seeds
 * what is stored per thread.
 */
async function boot({ tree = { t1: { status: "idle" } }, startIdle = false, metadata = {} } = {}) {
  const world = { workers: {}, spawned: [], gets: {}, metadata: structuredClone(metadata) };
  const row = (id) =>
    makeThreadResponse({ id, status: tree[id].status, parentThreadId: null, visibility: tree[id].visibility ?? "visible", projectId: "p", environmentId: "e" });
  const workerRow = (id, status = world.workers[id].status) =>
    makeThreadResponse({ id, status, parentThreadId: null, visibility: "hidden", projectId: "p", environmentId: "e" });
  const finish = (id, output = OUTPUT) => {
    world.workers[id].status = "idle";
    world.workers[id].output = output;
  };
  const host = createFakePluginHost({
    pluginId: "followups",
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => world.metadata[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          world.metadata[threadId] = { ...(world.metadata[threadId] ?? {}), ...set };
          return {};
        },
        get: async ({ threadId }) => {
          world.gets[threadId] = (world.gets[threadId] ?? 0) + 1;
          if (world.workers[threadId]) return { id: threadId, status: world.workers[threadId].status, environmentId: "e", projectId: "p", visibility: "hidden" };
          if (!tree[threadId]) throw new Error(`no such thread ${threadId}`);
          return row(threadId);
        },
        list: async (args) => (args.parentThreadId ? [] : [{ id: "live" }]),
        output: async ({ threadId }) => ({ output: world.workers[threadId] ? (world.workers[threadId].output ?? "") : "The answer." }),
        // With `startIdle`, a worker is idle until its turn starts, and BB reports its last
        // message, its own prompt, as its output.
        spawn: async (args) => {
          const id = `worker${world.spawned.length + 1}`;
          world.workers[id] = startIdle ? { status: "idle", output: args.prompt } : { status: "active", output: null };
          world.spawned.push(id);
          return { id };
        },
        archive: async () => ({}),
        stop: async () => ({}),
        delete: async () => ({ ok: true }),
        events: { list: async () => [] },
        promptHistory: async () => [],
      },
      ...modelStubs(),
    },
  });
  await plugin(host.bb);
  const rpc = (name, input) => host.harness.callRpc(name, input);
  return {
    world, tree, finish, rpc,
    shown: (id = "t1") => rpc("followups_get", { threadId: id }),
    idle: (id = "t1", text = "The answer.") => host.harness.emitThreadEvent("thread.idle", { thread: row(id), lastAssistantText: text }),
    // what BB sends when a worker's thread goes idle or fails
    workerIdle: (id, text = OUTPUT) => host.harness.emitThreadEvent("thread.idle", { thread: workerRow(id, "idle"), lastAssistantText: text }),
    workerFailed: (id) => host.harness.emitThreadEvent("thread.failed", { thread: workerRow(id, "error"), error: "boom" }),
    logs: () => host.harness.logEntries,
    ready: async () => (await rpc("followups_get", { threadId: "t1" })).status === "ready",
    dispose: () => host.harness.dispose(),
  };
}

test("an idle event from a hidden thread is ignored without a lookup", async () => {
  const w = await boot({ tree: { t1: { status: "idle" }, h1: { status: "idle", visibility: "hidden" } } });
  await w.idle("h1", "A helper's answer.");
  await sleep(200);
  assert.equal(w.world.gets.h1 ?? 0, 0, "the thread wasn't even looked up");
  assert.equal(w.world.spawned.length, 0);
  assert.equal((await w.shown("h1")).status, "empty");
  await w.dispose();
});

test("a visible thread going idle is still drafted for", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(700);
  w.finish("worker1");
  await w.workerIdle("worker1");
  await until(w.ready);
  await w.dispose();
});

test("a finished worker is picked up from its idle event, not at the next poll", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(800); // past the first look, so now it is waiting for the event
  const before = Date.now();
  w.finish("worker1");
  await w.workerIdle("worker1");
  await until(w.ready);
  const took = Date.now() - before;
  assert.ok(took < 250, `ready ${took}ms after the event`);
  assert.deepEqual((await w.shown()).suggestions.map((s) => s.label), ["Add a test"]);
  await w.dispose();
});

test("a worker that fails is noticed from its failed event", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(800);
  const before = Date.now();
  w.world.workers.worker1.status = "error";
  await w.workerFailed("worker1");
  await until(() => w.logs().some((l) => l.level === "warn" && /generate failed for t1/.test(l.message) && /failed/.test(l.message)));
  assert.ok(Date.now() - before < 400, `noticed after ${Date.now() - before}ms`);
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("events for other threads don't make the plugin look at the worker", async () => {
  const w = await boot({ tree: { t1: { status: "idle" }, h1: { status: "idle", visibility: "hidden" } } });
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(800);
  const looked = w.world.gets.worker1;
  await w.idle("h1");
  await sleep(150);
  assert.equal(w.world.gets.worker1, looked);
  await w.dispose();
});

test("an idle event before the first look doesn't make it look early", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await w.workerIdle("worker1", "The prompt the worker was started with"); // a thread can report idle before its turn starts
  await sleep(250);
  assert.equal(w.world.gets.worker1 ?? 0, 0, "the first look is still half a second after the spawn");
  await sleep(500);
  assert.equal(w.world.gets.worker1, 1);
  await w.dispose();
});

test("an event that arrives before the status agrees is followed up quickly", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(800);
  await w.workerIdle("worker1"); // the event is ahead of the status the plugin reads
  const before = Date.now();
  await sleep(60);
  w.finish("worker1");
  await until(w.ready, 2000);
  assert.ok(Date.now() - before < 700, `ready ${Date.now() - before}ms after the early event`);
  await w.dispose();
});

test("a worker already finished at the first look is found then", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  w.finish("worker1");
  await w.workerIdle("worker1");
  const before = Date.now();
  await until(w.ready, 2000);
  assert.ok(Date.now() - before < 800, `ready ${Date.now() - before}ms later`);
  await w.dispose();
});

test("if no event ever arrives, the slow poll still finds the finished worker", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(1000);
  w.finish("worker1"); // and no event
  const before = Date.now();
  await until(w.ready, 5000);
  const took = Date.now() - before;
  assert.ok(took < 4000, `found after ${took}ms`);
  await w.dispose();
});

test("a worker that runs for several seconds is looked at a handful of times, not every half second", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(3400);
  w.finish("worker1");
  await w.workerIdle("worker1");
  await until(w.ready);
  assert.ok(w.world.gets.worker1 <= 4, `${w.world.gets.worker1} status lookups over 3.4s (polling every 500ms would make 7)`);
  const line = w.logs().map((l) => l.message).find((m) => /^followups ready for t1/.test(m));
  assert.match(line, /(\d+) status checks \((\d+) by event\)/, line);
  assert.equal(Number(line.match(/\((\d+) by event\)/)[1]), 1);
  await w.dispose();
});

// ---- a worker that is idle before its turn starts ----

test("a worker idle before its turn starts isn't read as having answered with its own prompt", async () => {
  const w = await boot({ startIdle: true });
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await sleep(800); // past the first look: the worker is idle, and its output is its prompt
  assert.equal((await w.shown()).status, "working", "still waiting for the worker's answer");
  w.world.workers.worker1.status = "active"; // its turn starts…
  await sleep(100);
  w.finish("worker1"); // …and ends with a real answer
  await w.workerIdle("worker1");
  await until(w.ready);
  assert.deepEqual((await w.shown()).suggestions.map((s) => s.label), ["Add a test"]);
  await w.dispose();
});

test("the same holds for the worker writing a clicked follow-up's message", async () => {
  const READY = { status: "ready", suggestions: [{ id: "a1", label: "Add a test" }], updatedAt: Date.now() };
  const w = await boot({ startIdle: true, metadata: { t1: READY } });
  const drafted = w.rpc("followups_expand", { threadId: "t1", id: "a1" });
  await until(() => w.world.spawned.length === 1);
  await sleep(800);
  w.finish("worker1", "Please add a regression test for the retry path.");
  await w.workerIdle("worker1");
  const result = await drafted;
  assert.equal(result.drafted, true);
  assert.equal(result.text, "Please add a regression test for the retry path.");
  await w.dispose();
});
