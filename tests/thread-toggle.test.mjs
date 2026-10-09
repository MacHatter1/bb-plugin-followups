// Follow-ups can be switched on or off for one thread. A thread's own choice beats the
// "Suggest follow-ups automatically" setting, which is only the default for threads that
// haven't made one. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, sleep, until } from "./helpers.mjs";

const WORKER_OUTPUT = '[{"label": "Add a test", "why": "The fix shipped untested"}]';

/**
 * A fake BB with a few threads. `tree` maps id -> { status, parent, visibility }.
 * `settings` are the plugin's settings; `workerGate`, when given, holds every worker's
 * output until it resolves, so a test can act while a draft is in flight.
 */
async function boot(tree, { settings = {}, workerGate = null, metadataFails = false } = {}) {
  const world = { tree, metadata: {}, spawned: 0, listCalls: [], metadataFails };
  const row = (id) =>
    makeThreadResponse({
      id,
      status: tree[id].status,
      parentThreadId: tree[id].parent ?? null,
      visibility: tree[id].visibility ?? "visible",
      projectId: "p",
      environmentId: "e",
    });
  const host = createFakePluginHost({
    pluginId: "followups",
    settings,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => {
          if (world.metadataFails) throw new Error("metadata is down");
          return world.metadata[threadId] ?? {};
        },
        updatePluginMetadata: async ({ threadId, set }) => {
          world.metadata[threadId] = { ...(world.metadata[threadId] ?? {}), ...set };
          return {};
        },
        get: async ({ threadId }) => {
          if (threadId.startsWith("worker")) return { id: threadId, status: "idle", environmentId: "e", projectId: "p", visibility: "hidden" };
          if (!tree[threadId]) throw new Error(`no such thread ${threadId}`);
          return row(threadId);
        },
        list: async (args) => {
          world.listCalls.push(args);
          if (args.parentThreadId) return Object.keys(tree).filter((id) => tree[id].parent === args.parentThreadId).map(row);
          return [{ id: "live" }];
        },
        output: async ({ threadId }) => {
          if (threadId.startsWith("worker")) {
            await workerGate;
            return { output: WORKER_OUTPUT };
          }
          return { output: `${threadId}'s answer.` };
        },
        spawn: async () => { world.spawned += 1; return { id: `worker${world.spawned}` }; },
        archive: async () => ({}), stop: async () => ({}), delete: async () => ({ ok: true }),
        events: { list: async () => [] }, promptHistory: async () => [],
      },
      ...modelStubs(),
    },
  });
  await plugin(host.bb);
  const rpc = (name, input) => host.harness.callRpc(name, input);
  return {
    world, host, row, rpc,
    shown: (id = "t1") => rpc("followups_get", { threadId: id }),
    setEnabled: (enabled, id = "t1") => rpc("followups_set_enabled", { threadId: id, enabled }),
    cli: (...argv) => host.harness.runCli(argv),
    spawned: () => world.spawned,
    logs: () => host.harness.logEntries,
    idle: (id = "t1") => host.harness.emitThreadEvent("thread.idle", { thread: row(id), lastAssistantText: `${id}'s answer.` }),
    active: (id = "t1") => host.harness.emitThreadEvent("thread.active", { thread: row(id) }),
    async untilReady(id = "t1") { await until(async () => (await rpc("followups_get", { threadId: id })).status === "ready"); },
    dispose: () => host.harness.dispose(),
  };
}
const one = () => ({ t1: { status: "idle" } });

test("by default a thread has follow-ups on", async () => {
  const w = await boot(one());
  assert.equal((await w.shown()).enabled, true);
  await w.idle();
  await w.untilReady();
  await w.dispose();
});

test("turning a thread off clears what it was showing and says so", async () => {
  const w = await boot(one());
  await w.idle();
  await w.untilReady();
  assert.deepEqual(await w.setEnabled(false), { enabled: false });
  const got = await w.shown();
  assert.equal(got.enabled, false);
  assert.equal(got.status, "empty");
  assert.deepEqual(got.suggestions, []);
  assert.ok(w.host.harness.realtimeSignals.some((s) => s.payload?.threadId === "t1"), "the banner is told to refresh");
  await w.dispose();
});

test("an off thread gets no follow-ups when it finishes, and no worker is spawned", async () => {
  const w = await boot(one());
  await w.setEnabled(false);
  await w.idle();
  await sleep(300);
  assert.equal(w.spawned(), 0);
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("one thread's choice doesn't touch another", async () => {
  const w = await boot({ t1: { status: "idle" }, t2: { status: "idle" } });
  await w.setEnabled(false, "t1");
  assert.equal((await w.shown("t2")).enabled, true);
  await w.idle("t1");
  await w.idle("t2");
  await w.untilReady("t2");
  assert.equal(w.spawned(), 1, "only t2 was drafted");
  assert.equal((await w.shown("t1")).status, "empty");
  await w.dispose();
});

test("turning a finished thread on drafts from its latest answer right away", async () => {
  const w = await boot(one());
  await w.setEnabled(false);
  assert.deepEqual(await w.setEnabled(true), { enabled: true });
  await w.untilReady();
  const got = await w.shown();
  assert.equal(got.enabled, true);
  assert.deepEqual(got.suggestions.map(({ label, why }) => ({ label, why })), [{ label: "Add a test", why: "The fix shipped untested" }]);
  assert.equal(w.spawned(), 1);
  await w.dispose();
});

test("turning a running thread on waits for it to finish", async () => {
  const w = await boot({ t1: { status: "active" } });
  await w.setEnabled(false);
  await w.setEnabled(true);
  await sleep(250);
  assert.equal(w.spawned(), 0, "nothing to draft from while it works");
  w.world.tree.t1.status = "idle";
  await w.idle();
  await w.untilReady();
  await w.dispose();
});

test("turning on a thread that already shows follow-ups doesn't draft again", async () => {
  const w = await boot(one());
  await w.idle();
  await w.untilReady();
  await w.setEnabled(true);
  await sleep(300);
  assert.equal(w.spawned(), 1);
  await w.dispose();
});

test("turning a thread off while its follow-ups are being drafted drops them", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const w = await boot(one(), { workerGate: gate });
  await w.idle();
  await until(() => w.spawned() === 1);
  assert.equal((await w.shown()).status, "working");
  await w.setEnabled(false);
  release();
  await sleep(400);
  const got = await w.shown();
  assert.equal(got.status, "empty", "the late result must not be shown");
  assert.deepEqual(got.suggestions, []);
  assert.equal(got.enabled, false);
  await w.dispose();
});

test("the choice survives the thread working again and a new answer", async () => {
  const w = await boot(one());
  await w.setEnabled(false);
  await w.active();
  assert.equal((await w.shown()).enabled, false);
  await w.idle();
  await sleep(250);
  assert.equal(w.spawned(), 0);
  assert.equal((await w.shown()).enabled, false);
  await w.dispose();
});

test("dismissing the banner doesn't turn follow-ups off for the thread", async () => {
  const w = await boot(one());
  await w.idle();
  await w.untilReady();
  await w.rpc("followups_dismiss", { threadId: "t1" });
  const got = await w.shown();
  assert.equal(got.status, "empty");
  assert.equal(got.enabled, true);
  await w.dispose();
});

test("with the setting off, threads start off, and one can opt in", async () => {
  const w = await boot({ t1: { status: "idle" }, t2: { status: "idle" } }, { settings: { enabled: false } });
  assert.equal((await w.shown("t1")).enabled, false);
  await w.idle("t1");
  await w.idle("t2");
  await sleep(300);
  assert.equal(w.spawned(), 0, "nothing automatic");
  await w.setEnabled(true, "t1");
  await w.untilReady("t1");
  assert.equal((await w.shown("t1")).enabled, true);
  assert.equal((await w.shown("t2")).enabled, false);
  assert.equal(w.spawned(), 1);
  await w.dispose();
});

test("with the setting off, an opted-in thread keeps getting follow-ups when it finishes again", async () => {
  const w = await boot(one(), { settings: { enabled: false } });
  await w.setEnabled(true);
  await w.untilReady();
  await w.active();
  assert.equal((await w.shown()).status, "empty");
  await w.idle();
  await w.untilReady();
  assert.equal(w.spawned(), 2);
  await w.dispose();
});

test("with the setting on, a thread that opted out stays out even if it is switched on elsewhere", async () => {
  const w = await boot({ t1: { status: "idle" }, t2: { status: "idle" } });
  await w.setEnabled(false, "t1");
  await w.setEnabled(true, "t2");
  await w.untilReady("t2");
  assert.equal((await w.shown("t1")).enabled, false);
  await w.dispose();
});

test("an off thread isn't checked for child threads", async () => {
  const w = await boot({ t1: { status: "idle" }, kid: { status: "active", parent: "t1", visibility: "hidden" } });
  await w.setEnabled(false);
  await w.idle();
  await sleep(250);
  assert.equal(w.world.listCalls.filter((args) => args.parentThreadId).length, 0);
  assert.ok(!w.logs().some((l) => /child thread/.test(l.message)));
  await w.dispose();
});

test("if the choice can't be read, no worker is spawned and the failure is logged", async () => {
  const w = await boot(one(), { metadataFails: true });
  await w.idle();
  await sleep(300);
  assert.equal(w.spawned(), 0, "a billed worker for a thread that may be off would be worse than none");
  assert.ok(
    w.logs().some((l) => l.level === "warn" && /t1/.test(l.message) && /metadata is down/.test(l.message)),
    JSON.stringify(w.logs().map((l) => l.message)),
  );
  await w.dispose();
});

test("turning a thread on and off is logged", async () => {
  const w = await boot(one());
  await w.setEnabled(false);
  await w.setEnabled(true);
  const lines = w.logs().map((l) => l.message);
  assert.ok(lines.some((m) => /followups turned off for t1/.test(m)), JSON.stringify(lines));
  assert.ok(lines.some((m) => /followups turned on for t1/.test(m)), JSON.stringify(lines));
  await w.dispose();
});

test("`bb followups off` and `on` change one thread, and `show` says which it is", async () => {
  const w = await boot(one());
  const off = await w.cli("off", "t1");
  assert.equal(off.exitCode, 0);
  assert.match(off.stdout, /off for t1/);
  const shownOff = await w.cli("show", "t1");
  assert.match(shownOff.stdout, /off for t1/);
  const json = JSON.parse((await w.cli("show", "t1", "--json")).stdout);
  assert.equal(json.enabled, false);
  const on = await w.cli("on", "t1");
  assert.equal(on.exitCode, 0);
  assert.match(on.stdout, /on for t1/);
  assert.equal((await w.shown()).enabled, true);
  await w.untilReady();
  await w.dispose();
});

test("`bb followups on` and `off` need exactly one thread id", async () => {
  const w = await boot(one());
  for (const argv of [["on"], ["off"], ["on", "a", "b"], ["off", "a", "b"]]) {
    const result = await w.cli(...argv);
    assert.equal(result.exitCode, 1, argv.join(" "));
    assert.match(result.stderr, /Usage/);
  }
  await w.dispose();
});

test("`bb followups regenerate` refuses a thread that is off and spawns nothing", async () => {
  const w = await boot(one());
  await w.setEnabled(false);
  const result = await w.cli("regenerate", "t1");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /turned off for t1/);
  assert.match(result.stderr, /followups on t1/);
  assert.equal(w.spawned(), 0);
  await w.dispose();
});

test("`bb followups regenerate` while a draft is running waits for its own run, and reports that one", async () => {
  let release;
  const workerGate = new Promise((resolve) => { release = resolve; });
  const w = await boot(one(), { workerGate });
  await w.idle();
  await until(() => w.spawned() === 1);
  let done = false;
  const result = w.cli("regenerate", "t1").then((value) => { done = true; return value; });
  await sleep(300);
  assert.equal(done, false, "it doesn't report before its own run has finished");
  release();
  const { exitCode, stdout } = await result;
  assert.equal(exitCode, 0);
  assert.equal(w.spawned(), 2, "its run started a worker of its own");
  assert.match(stdout, /1 suggestion\(s\), 1 with a reason \(ready\)/);
  assert.match(stdout, /^Took \d+ms/m);
  await w.dispose();
});
