// A worker that is drafting follow-ups for an answer the thread has moved on from is stopped
// as soon as that is known, and the next run starts without waiting for it. Results that
// arrive for an outdated answer are still dropped. The same goes for the worker writing the
// message for a follow-up the user clicked. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, sleep, until } from "./helpers.mjs";

const OUTPUT = '[{"label": "Add a test", "why": "The fix shipped untested"}]';
const OLD_OUTPUT = '[{"label": "An outdated idea", "why": "From the previous answer"}]';

/**
 * A fake BB whose worker threads run until the test finishes them (or after `autoMs`), so a test
 * can act while a worker is still going. `world.workers` holds each worker's prompt, status and
 * output; `world.stops` records every stop with its time.
 */
async function boot({ tree = { t1: { status: "idle" } }, autoMs = null } = {}) {
  const world = { workers: {}, spawned: [], stops: [], holds: {}, modelsGate: null, historyGate: null, metadata: {} };
  const row = (id) =>
    makeThreadResponse({ id, status: tree[id].status, parentThreadId: null, visibility: "visible", projectId: "p", environmentId: "e" });
  const finish = (id, output = OUTPUT) => {
    const worker = world.workers[id];
    worker.status = "idle";
    worker.output = output;
    worker.finishedAt = Date.now();
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
          const worker = world.workers[threadId];
          if (worker) return { id: threadId, status: worker.status, environmentId: "e", projectId: "p", visibility: "hidden" };
          if (!tree[threadId]) throw new Error(`no such thread ${threadId}`);
          return row(threadId);
        },
        list: async (args) => (args.parentThreadId ? [] : [{ id: "live" }]),
        output: async ({ threadId }) => {
          if (world.workers[threadId]) {
            await world.holds[threadId];
            return { output: world.workers[threadId].output ?? "" };
          }
          return { output: "The answer." };
        },
        spawn: async (args) => {
          const id = `worker${world.spawned.length + 1}`;
          world.workers[id] = { status: "active", output: null, prompt: args.prompt, title: args.title, spawnedAt: Date.now() };
          world.spawned.push(id);
          if (autoMs !== null) setTimeout(() => finish(id), autoMs);
          return { id };
        },
        archive: async () => ({}),
        stop: async ({ threadId }) => {
          world.stops.push({ id: threadId, at: Date.now() });
          return {};
        },
        delete: async () => ({ ok: true }),
        events: { list: async () => [] },
        promptHistory: async () => {
          await world.historyGate;
          return [];
        },
      },
      ...modelStubs(() => world.modelsGate),
    },
  });
  await plugin(host.bb);
  const rpc = (name, input) => host.harness.callRpc(name, input);
  return {
    world, tree, finish, rpc,
    shown: () => rpc("followups_get", { threadId: "t1" }),
    idle: (text) => host.harness.emitThreadEvent("thread.idle", { thread: row("t1"), lastAssistantText: text }),
    event: (name, payload) => host.harness.emitThreadEvent(name, payload ?? { thread: row("t1") }),
    active: () => host.harness.emitThreadEvent("thread.active", { thread: row("t1") }),
    logs: () => host.harness.logEntries.map((l) => l.message),
    stopped: (id) => world.stops.find((s) => s.id === id),
    dispose: () => host.harness.dispose(),
  };
}

const TRIGGERS = [
  ["the thread goes active", (w) => w.active()],
  ["a message is queued", (w) => w.event("message.queued", { entry: { threadId: "t1" } })],
  ["a message is dispatched", (w) => w.event("message.dispatched", { entry: { threadId: "t1" } })],
];

for (const [name, trigger] of TRIGGERS) {
  test(`when ${name}, the worker is stopped at once, not at the next poll or when it finishes`, async () => {
    const w = await boot();
    await w.idle("First answer.");
    await until(() => w.world.spawned.length === 1);
    const before = Date.now();
    await trigger(w);
    await until(() => w.stopped("worker1"), 1500);
    assert.ok(w.stopped("worker1").at - before < 200, `stopped ${w.stopped("worker1").at - before}ms after the trigger`);
    assert.equal(w.world.workers.worker1.status, "active", "it was stopped while still running");
    assert.ok(w.logs().some((m) => /stopped the draft for t1/.test(m)), JSON.stringify(w.logs()));
    assert.equal((await w.shown()).status, "empty");
    await w.dispose();
  });
}

test("a result that still arrives for the outdated answer is dropped", async () => {
  const w = await boot();
  await w.idle("First answer.");
  await until(() => w.world.spawned.length === 1);
  await w.active();
  await until(() => w.stopped("worker1"));
  w.finish("worker1", OLD_OUTPUT);
  await sleep(900);
  const got = await w.shown();
  assert.equal(got.status, "empty");
  assert.deepEqual(got.suggestions, []);
  assert.equal(w.world.spawned.length, 1, "nothing was started in its place");
  await w.dispose();
});

test("a worker that had already finished when the thread moved on has its result dropped", async () => {
  const w = await boot();
  let release;
  await w.idle("First answer.");
  await until(() => w.world.spawned.length === 1);
  w.world.holds.worker1 = new Promise((resolve) => { release = resolve; });
  w.finish("worker1", OLD_OUTPUT);
  await until(() => w.world.workers.worker1.status === "idle");
  await sleep(700); // its status was read; its output is being fetched
  await w.active();
  release();
  await sleep(300);
  const got = await w.shown();
  assert.equal(got.status, "empty");
  assert.deepEqual(got.suggestions, []);
  await w.dispose();
});

test("the next run does not wait for the old worker", async () => {
  const w = await boot();
  await w.idle("Answer A.");
  await until(() => w.world.spawned.length === 1);
  await w.active();
  w.tree.t1.status = "idle";
  const started = Date.now();
  await w.idle("Answer B.");
  await until(() => w.world.spawned.length === 2, 2000);
  const waited = Date.now() - started;
  assert.ok(waited < 1500, `the new worker started ${waited}ms later`);
  assert.equal(w.world.workers.worker1.status, "active", "the old worker had not finished");
  assert.ok(w.stopped("worker1"), "and was stopped");
  assert.ok(w.world.workers.worker2.prompt.includes("Answer B."), "the new worker was given the new answer");
  assert.ok(!w.world.workers.worker2.prompt.includes("Answer A."));
  w.finish("worker2");
  await until(async () => (await w.shown()).status === "ready");
  w.finish("worker1", OLD_OUTPUT); // the old worker reporting late changes nothing
  await sleep(700);
  const got = await w.shown();
  assert.deepEqual(got.suggestions.map((s) => s.label), ["Add a test"]);
  await w.dispose();
});

test("a newer answer queued behind a running draft takes over without waiting, with no clear in between", async () => {
  const w = await boot();
  await w.idle("Answer A.");
  await until(() => w.world.spawned.length === 1);
  await w.idle("Answer B.");
  await until(() => w.world.spawned.length === 2, 2000);
  assert.equal(w.world.workers.worker1.status, "active");
  assert.ok(w.stopped("worker1"));
  assert.ok(w.world.workers.worker2.prompt.includes("Answer B."));
  w.finish("worker2");
  await until(async () => (await w.shown()).status === "ready");
  await w.dispose();
});

test("a draft stopped for a newer run that then doesn't happen is not left saying it is working", async () => {
  const w = await boot();
  await w.idle("Answer A.");
  await until(() => w.world.spawned.length === 1);
  assert.equal((await w.shown()).status, "working");
  w.tree.t1.status = "active"; // it is busy again, so the queued run has nothing to do
  await w.idle("Answer B.");
  await until(() => w.stopped("worker1"), 1500);
  await sleep(300);
  assert.equal((await w.shown()).status, "empty");
  assert.equal(w.world.spawned.length, 1);
  await w.dispose();
});

test("turning the thread off stops the worker", async () => {
  const w = await boot();
  await w.idle("Answer A.");
  await until(() => w.world.spawned.length === 1);
  await w.rpc("followups_set_enabled", { threadId: "t1", enabled: false });
  await until(() => w.stopped("worker1"), 1500);
  assert.equal((await w.shown()).status, "empty");
  assert.equal(w.world.spawned.length, 1);
  await w.dispose();
});

test("dismissing the \"finding follow-ups\" skeleton stops the worker", async () => {
  const w = await boot();
  await w.idle("Answer A.");
  await until(() => w.world.spawned.length === 1);
  await w.rpc("followups_dismiss", { threadId: "t1" });
  await until(() => w.stopped("worker1"), 1500);
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("the thread going away stops the worker", async () => {
  const w = await boot();
  await w.idle("Answer A.");
  await until(() => w.world.spawned.length === 1);
  await w.event("thread.deleted");
  await until(() => w.stopped("worker1"), 1500);
  await w.dispose();
});

test("moving on while the model is still being looked up starts no worker and leaves nothing 'working'", async () => {
  const w = await boot();
  let release;
  w.world.modelsGate = new Promise((resolve) => { release = resolve; });
  await w.idle("Answer A.");
  await sleep(150);
  await w.active();
  await sleep(100);
  release();
  await sleep(500);
  assert.equal(w.world.spawned.length, 0, "no worker for an answer already outdated");
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("a draft nobody has moved on from is left to finish, and is only stopped after it has", async () => {
  const w = await boot({ autoMs: 250 });
  await w.idle("Answer A.");
  await until(async () => (await w.shown()).status === "ready", 4000);
  await until(() => w.stopped("worker1"), 2000);
  assert.ok(w.stopped("worker1").at >= w.world.workers.worker1.finishedAt, "stopped only once it was done");
  assert.ok(!w.logs().some((m) => /stopped the draft/.test(m)), JSON.stringify(w.logs()));
  assert.deepEqual((await w.shown()).suggestions.map((s) => s.label), ["Add a test"]);
  await w.dispose();
});

// ---- the worker writing the message for a clicked follow-up ----

/** Get follow-ups showing for t1, and return the id of the first one. */
async function withFollowups(w) {
  await w.idle("The answer.");
  await until(() => w.world.spawned.length === 1);
  w.finish("worker1");
  await until(async () => (await w.shown()).status === "ready");
  return (await w.shown()).suggestions[0].id;
}

/** Click a follow-up: start the draft and settle its outcome without leaving a rejection unhandled. */
function click(w, id) {
  return w.rpc("followups_expand", { threadId: "t1", id }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

const DRAFT_TRIGGERS = [
  ...TRIGGERS,
  ["the banner is dismissed", (w) => w.rpc("followups_dismiss", { threadId: "t1" })],
  ["follow-ups are turned off for the thread", (w) => w.rpc("followups_set_enabled", { threadId: "t1", enabled: false })],
  ["the thread is deleted", (w) => w.event("thread.deleted")],
];

for (const [name, trigger] of DRAFT_TRIGGERS) {
  test(`when ${name}, the message draft's worker is stopped at once and the draft is refused`, async () => {
    const w = await boot();
    const id = await withFollowups(w);
    const outcome = click(w, id);
    await until(() => w.world.spawned.length === 2);
    assert.equal(w.world.workers.worker2.title, "Followups draft");
    const before = Date.now();
    await trigger(w);
    await until(() => w.stopped("worker2"), 1500);
    assert.ok(w.stopped("worker2").at - before < 200, `stopped ${w.stopped("worker2").at - before}ms after the trigger`);
    assert.equal(w.world.workers.worker2.status, "active", "it was stopped while still writing");
    const { value, error } = await outcome;
    assert.equal(value, undefined, "no draft is handed over");
    assert.match(error.message, /no longer available/);
    assert.ok(w.logs().some((m) => /stopped the message draft for t1/.test(m)), JSON.stringify(w.logs()));
    assert.equal(w.world.spawned.length, 2, "nothing was started in its place");
    await w.dispose();
  });
}

test("a message draft that had already finished when the thread moved on is not handed over", async () => {
  const w = await boot();
  const id = await withFollowups(w);
  const outcome = click(w, id);
  await until(() => w.world.spawned.length === 2);
  let release;
  w.world.holds.worker2 = new Promise((resolve) => { release = resolve; });
  w.finish("worker2", "Please add a test for the retry path.");
  await sleep(700); // its status was read; its output is being fetched
  await w.active();
  release();
  const { value, error } = await outcome;
  assert.equal(value, undefined);
  assert.match(error.message, /no longer available/);
  await w.dispose();
});

test("moving on while the draft is still being prepared spawns no worker for it", async () => {
  const w = await boot();
  const id = await withFollowups(w);
  let release;
  w.world.historyGate = new Promise((resolve) => { release = resolve; });
  const outcome = click(w, id);
  await sleep(150);
  await w.active();
  await sleep(100);
  release();
  const { value, error } = await outcome;
  assert.equal(value, undefined);
  assert.match(error.message, /no longer available/);
  assert.equal(w.world.spawned.length, 1, "only the suggestion worker was ever started");
  await w.dispose();
});

test("every message draft in flight for the thread is stopped, not just one", async () => {
  const w = await boot();
  const id = await withFollowups(w);
  const first = click(w, id);
  const second = click(w, id);
  await until(() => w.world.spawned.length === 3);
  await w.active();
  await until(() => w.stopped("worker2") && w.stopped("worker3"), 1500);
  assert.match((await first).error.message, /no longer available/);
  assert.match((await second).error.message, /no longer available/);
  await w.dispose();
});

test("a message draft nobody has moved on from is left to finish, and is only stopped after it has", async () => {
  const w = await boot();
  const id = await withFollowups(w);
  const outcome = click(w, id);
  await until(() => w.world.spawned.length === 2);
  await sleep(700);
  assert.equal(w.stopped("worker2"), undefined, "still being written, so not stopped");
  w.finish("worker2", "Please add a test for the retry path.");
  const { value, error } = await outcome;
  assert.equal(error, undefined);
  assert.equal(value.drafted, true);
  assert.equal(value.text, "Please add a test for the retry path.");
  await until(() => w.stopped("worker2"), 2000);
  assert.ok(w.stopped("worker2").at >= w.world.workers.worker2.finishedAt, "stopped only once it was done");
  assert.ok(!w.logs().some((m) => /stopped the message draft/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

test("a repeated idle event doesn't take the message being written away from the user", async () => {
  const w = await boot();
  const id = await withFollowups(w);
  const outcome = click(w, id);
  await until(() => w.world.spawned.length === 2);
  await w.idle("The answer."); // nothing was cleared: only a newer suggestion run is queued
  await sleep(700);
  assert.equal(w.stopped("worker2"), undefined, "the message draft keeps going");
  w.finish("worker2", "Please add a test for the retry path.");
  const { value, error } = await outcome;
  assert.equal(error, undefined);
  assert.equal(value.text, "Please add a test for the retry path.");
  await w.dispose();
});
