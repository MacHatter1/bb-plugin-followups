// A thread whose child threads are still running isn't finished, even though its own agent is
// idle: it is waiting on them. Follow-ups wait too, and arrive once the children are done.
// Run with `npm test`.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, sleep, until } from "./helpers.mjs";

const WORKER_OUTPUT = '[{"label": "Add a test", "why": "The fix shipped untested"}]';
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A fake BB holding a tree of threads: `tree` maps id -> { parent, status, visibility }. */
async function boot(tree, { listFails = false, beforeWorkerOutput = () => {} } = {}) {
  const world = { tree, metadata: {}, spawned: 0, listCalls: [], getLog: [], listFails };
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
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => world.metadata[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          world.metadata[threadId] = { ...(world.metadata[threadId] ?? {}), ...set };
          return {};
        },
        get: async ({ threadId }) => {
          world.getLog.push(threadId);
          if (threadId === "worker") return { id: "worker", status: "idle", environmentId: "e", projectId: "p", visibility: "hidden" };
          if (!tree[threadId]) throw new Error(`no such thread ${threadId}`);
          return row(threadId);
        },
        list: async (args) => {
          world.listCalls.push(args);
          if (world.listFails) throw new Error("list is down");
          if (args.parentThreadId) return Object.keys(tree).filter((id) => tree[id].parent === args.parentThreadId).map(row);
          return [{ id: "live" }]; // the environment still has a live thread, so workers may be deleted
        },
        output: async ({ threadId }) => {
          if (threadId === "worker") beforeWorkerOutput();
          return { output: threadId === "worker" ? WORKER_OUTPUT : "The captain's answer." };
        },
        spawn: async () => { world.spawned += 1; return { id: "worker" }; },
        archive: async () => ({}), stop: async () => ({}), delete: async () => ({ ok: true }),
        events: { list: async () => [] }, promptHistory: async () => [],
      },
      ...modelStubs(),
    },
  });
  await plugin(host.bb);
  const shown = (id = "captain") => host.harness.callRpc("followups_get", { threadId: id });
  return {
    world, host, row, shown,
    spawned: () => world.spawned,
    logs: () => host.harness.logEntries,
    idle: (id) => host.harness.emitThreadEvent("thread.idle", { thread: row(id), lastAssistantText: "The captain's answer." }),
    async untilReady(id = "captain") { await until(async () => (await shown(id)).status === "ready"); },
    // a child stopped working: change its status, tell the plugin, and let the settle timer fire
    async childStops(id, status = "idle") {
      tree[id].status = status;
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await host.harness.emitThreadEvent("thread.idle", { thread: row(id), lastAssistantText: "done" });
        await flush();
        mock.timers.tick(5000);
      } finally {
        mock.timers.reset();
      }
    },
    dispose: () => host.harness.dispose(),
  };
}
const captainWith = (...kids) => ({
  captain: { status: "idle" },
  ...Object.fromEntries(kids.map(([id, status, parent = "captain"]) => [id, { parent, status, visibility: "hidden" }])),
});

test("an idle thread with a running child gets no follow-ups yet", async () => {
  const w = await boot(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(300);
  assert.equal(w.spawned(), 0, "no worker may be spawned");
  assert.equal((await w.shown()).status, "empty");
  assert.ok(
    w.logs().some((l) => /captain is idle but 1 child thread\(s\) are still running/.test(l.message)),
    JSON.stringify(w.logs().map((l) => l.message)),
  );
  await w.dispose();
});

for (const status of ["active", "starting", "pending", "stopping"]) {
  test(`a child that is ${status} counts as still working`, async () => {
    const w = await boot(captainWith(["kid", status]));
    await w.idle("captain");
    await sleep(250);
    assert.equal(w.spawned(), 0);
    await w.dispose();
  });
}

for (const status of ["idle", "error"]) {
  test(`a child that is ${status} does not hold the parent back`, async () => {
    const w = await boot(captainWith(["kid", status]));
    await w.idle("captain");
    await w.untilReady();
    assert.equal(w.spawned(), 1);
    await w.dispose();
  });
}

test("a thread with no children gets follow-ups as before", async () => {
  const w = await boot({ captain: { status: "idle" } });
  await w.idle("captain");
  await w.untilReady();
  await w.dispose();
});

test("an idle child with a running grandchild still counts, three levels down too", async () => {
  for (const tree of [
    captainWith(["kid", "idle"], ["grandkid", "active", "kid"]),
    captainWith(["a", "idle"], ["b", "idle", "a"], ["c", "active", "b"]),
  ]) {
    const w = await boot(tree);
    await w.idle("captain");
    await sleep(250);
    assert.equal(w.spawned(), 0, JSON.stringify(Object.keys(tree)));
    await w.dispose();
  }
});

test("hidden children are looked at, and archived ones (left out of the default list) are not needed", async () => {
  const w = await boot(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(200);
  const childLookups = w.world.listCalls.filter((args) => args.parentThreadId === "captain");
  assert.ok(childLookups.length >= 1);
  assert.ok(childLookups.every((args) => args.includeHidden === true), "hidden children must be included");
  assert.ok(childLookups.every((args) => args.archived !== true), "archived children are finished work");
  await w.dispose();
});

test("a parent/child cycle can't hang the check", async () => {
  const tree = { a: { status: "idle", parent: "b" }, b: { status: "idle", parent: "a", visibility: "hidden" } };
  const w = await boot(tree);
  await w.idle("a");
  await w.untilReady("a");
  await w.dispose();
});

test("if the children can't be looked up, follow-ups still arrive and the failure is logged", async () => {
  const w = await boot(captainWith(["kid", "active"]), { listFails: true });
  await w.idle("captain");
  await w.untilReady();
  assert.ok(
    w.logs().some((l) => l.level === "warn" && /child threads/.test(l.message) && /list is down/.test(l.message)),
    JSON.stringify(w.logs().map((l) => l.message)),
  );
  await w.dispose();
});

test("once the last child finishes and the parent stays idle, follow-ups are drafted", async () => {
  const w = await boot(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(200);
  assert.equal(w.spawned(), 0);
  await w.childStops("kid");
  await w.untilReady();
  const got = await w.shown();
  assert.deepEqual(got.suggestions.map(({ label, why }) => ({ label, why })), [{ label: "Add a test", why: "The fix shipped untested" }]);
  assert.ok(w.logs().some((l) => /children of captain finished/.test(l.message)));
  await w.dispose();
});

test("with two children, nothing is drafted until the second one finishes", async () => {
  const w = await boot(captainWith(["one", "active"], ["two", "active"]));
  await w.idle("captain");
  await w.childStops("one");
  await sleep(300);
  assert.equal(w.spawned(), 0, "one child is still running");
  await w.childStops("two");
  await w.untilReady();
  await w.dispose();
});

test("a grandchild finishing releases the waiting grandparent", async () => {
  const w = await boot(captainWith(["kid", "idle"], ["grandkid", "active", "kid"]));
  await w.idle("captain");
  await sleep(200);
  assert.equal(w.spawned(), 0);
  await w.childStops("grandkid");
  await w.untilReady();
  await w.dispose();
});

test("if the parent wakes up first (a child's report starts a turn), nothing is drafted from the old answer", async () => {
  const w = await boot(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(150);
  w.world.tree.captain.status = "active";
  await w.host.harness.emitThreadEvent("thread.active", { thread: w.row("captain") });
  await w.childStops("kid");
  await sleep(400);
  assert.equal(w.spawned(), 0);
  // ...and when its own turn ends, the normal idle path drafts as usual
  w.world.tree.captain.status = "idle";
  await w.idle("captain");
  await w.untilReady();
  await w.dispose();
});

test("a thread that was never waiting is left alone when a child finishes", async () => {
  const w = await boot(captainWith(["kid", "idle"]));
  await w.idle("captain");
  await w.untilReady();
  const spawnedBefore = w.spawned();
  const lookedUp = () => ({
    parent: w.world.getLog.filter((id) => id === "captain").length,
    children: w.world.listCalls.filter((args) => args.parentThreadId).length,
  });
  const before = lookedUp();
  await w.childStops("kid");
  await sleep(300);
  assert.equal(w.spawned(), spawnedBefore, "no second worker");
  assert.deepEqual(lookedUp(), before, "nothing about the parent or its children is looked up when nothing is waiting");
  await w.dispose();
});

test("a child that starts working while the answer is being drafted keeps the follow-ups back", async () => {
  const tree = captainWith(["kid", "idle"]);
  const w = await boot(tree, { beforeWorkerOutput: () => { tree.kid.status = "active"; } });
  await w.idle("captain");
  await until(() => w.spawned() === 1);
  await sleep(1500);
  const got = await w.shown();
  assert.equal(got.status, "empty", "the drafted suggestions must not be shown while a child runs");
  assert.deepEqual(got.suggestions, []);
  // and they come once that child finishes
  await w.childStops("kid");
  await until(() => w.spawned() === 2);
  await w.dispose();
});

test("`bb followups regenerate` refuses a thread that is waiting on child threads", async () => {
  const w = await boot(captainWith(["kid", "active"]));
  const result = await w.host.harness.runCli(["regenerate", "captain"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /child thread/);
  assert.equal(w.spawned(), 0);
  await w.dispose();
});

test("our own hidden workers (no parent) never trigger any of this", async () => {
  const w = await boot({ captain: { status: "idle" } });
  await w.idle("captain");
  await w.untilReady();
  assert.ok(!w.logs().some((l) => /child thread/.test(l.message)));
  await w.dispose();
});
