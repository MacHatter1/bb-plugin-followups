// Edge cases found in a review of the whole plugin: a failed worker spawn, events with nothing to
// clear, a reload with work in flight, unreadable stored metadata, and an "answer" that is really
// the user's own message. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { modelStubs, sleep, until } from "./helpers.mjs";

const OUTPUT = '[{"label": "Add a test", "why": "The fix shipped untested"}]';

/**
 * A fake BB. `metadata` seeds what is stored per thread; `prompts` is the user's message history.
 * `world` counts metadata writes and records spawns, stops and deletes.
 */
async function boot({ spawnFails = false, metadata = {}, prompts = [], settings = {}, status = "idle", models = null } = {}) {
  const world = {
    metadata: structuredClone(metadata), writes: 0, workers: {}, spawned: [], spawnArgs: [], stops: [], deletes: [], modelsGate: null,
    spawnGate: null, spawnCalls: 0, noDefaultModel: false,
  };
  const row = (id) => makeThreadResponse({ id, status, parentThreadId: null, visibility: "visible", projectId: "p", environmentId: "e" });
  const host = createFakePluginHost({
    pluginId: "followups",
    settings,
    agentSkillIds: ["followups"], // the skill the plugin ships, so the fake knows the id
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => world.metadata[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set }) => {
          world.writes += 1;
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
          world.spawnArgs.push(args);
          await world.spawnGate;
          if (spawnFails) throw new Error("environment unavailable");
          const id = `worker${world.spawned.length + 1}`;
          world.workers[id] = { status: "active", output: null, title: args.title };
          world.spawned.push(id);
          return { id };
        },
        archive: async () => ({}),
        stop: async ({ threadId }) => {
          world.stops.push(threadId);
          return {};
        },
        delete: async ({ threadId }) => {
          world.deletes.push(threadId);
          return { ok: true };
        },
        events: { list: async () => [] },
        promptHistory: async () => prompts.map((text) => ({ input: [{ type: "text", text }] })),
      },
      ...modelStubs(() => world.modelsGate),
      // `models` replaces the provider catalog; `world.noDefaultModel` makes BB report no models at all.
      ...(models ? { providers: { models: async () => models } } : {}),
      system: {
        executionOptions: async () =>
          world.noDefaultModel
            ? { models: [], providers: [] }
            : {
                models: [{ model: "m", isDefault: true, routeProviderId: "p1", defaultReasoningEffort: "low" }],
                providers: [{ id: "p1", available: true }],
              },
      },
    },
  });
  await plugin(host.bb);
  const rpc = (name, input) => host.harness.callRpc(name, input);
  return {
    world, rpc, host,
    shown: (id = "t1") => rpc("followups_get", { threadId: id }),
    idle: (text = "The answer.", id = "t1") => host.harness.emitThreadEvent("thread.idle", { thread: row(id), lastAssistantText: text }),
    event: (name, id = "t1") =>
      name.startsWith("message.")
        ? host.harness.emitThreadEvent(name, { entry: { threadId: id } })
        : host.harness.emitThreadEvent(name, { thread: row(id) }),
    signals: () => host.harness.realtimeSignals.length,
    logs: () => host.harness.logEntries,
    dispose: () => host.harness.dispose(),
  };
}

const READY = { status: "ready", suggestions: [{ id: "a1", label: "Add a test", why: "Untested" }], updatedAt: Date.now() };

// ---- a failed spawn ----

test("a worker that can't be started leaves the banner empty, not 'working'", async () => {
  const w = await boot({ spawnFails: true });
  await w.idle();
  await until(() => w.logs().some((l) => /spawn failed for t1/.test(l.message)));
  await sleep(100);
  const got = await w.shown();
  assert.equal(got.status, "empty");
  assert.deepEqual(got.suggestions, []);
  await w.dispose();
});

// ---- events with nothing to clear ----

for (const [name, fire] of [
  ["the thread going active", (w) => w.event("thread.active")],
  ["a message being queued", (w) => w.event("message.queued")],
  ["a message being dispatched", (w) => w.event("message.dispatched")],
]) {
  test(`${name} on a thread with nothing showing writes nothing and broadcasts nothing`, async () => {
    const w = await boot();
    await fire(w);
    await sleep(100);
    assert.equal(w.world.writes, 0);
    assert.equal(w.signals(), 0);
    await w.dispose();
  });

  test(`${name} on a thread showing follow-ups clears them, once`, async () => {
    const w = await boot({ metadata: { t1: structuredClone(READY) } });
    await fire(w);
    await until(async () => (await w.shown()).status === "empty");
    assert.equal(w.world.writes, 1);
    assert.equal(w.signals(), 1);
    assert.ok(w.logs().some((l) => /followups cleared for t1/.test(l.message)));
    await w.dispose();
  });
}

test("a thread whose draft is in flight is cleared too", async () => {
  const w = await boot({ metadata: { t1: { status: "working", suggestions: [], updatedAt: Date.now() } } });
  await w.event("thread.active");
  await until(async () => (await w.shown()).status === "empty");
  assert.equal(w.world.metadata.t1.status, "empty");
  await w.dispose();
});

test("clearing twice in a row writes once", async () => {
  const w = await boot({ metadata: { t1: structuredClone(READY) } });
  await w.rpc("followups_dismiss", { threadId: "t1" });
  await w.rpc("followups_dismiss", { threadId: "t1" });
  assert.equal(w.world.writes, 1);
  await w.dispose();
});

// ---- a reload with work in flight ----

test("a reload stops the draft in flight and releases its worker before it finishes disposing", async () => {
  const w = await boot();
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await w.dispose();
  assert.ok(w.world.stops.includes("worker1"), "the worker was stopped");
  assert.ok(w.world.deletes.includes("worker1"), "and deleted, not left for the sweep");
  assert.equal(w.logs().filter((l) => l.level === "warn").length, 0, JSON.stringify(w.logs().map((l) => l.message)));
});

test("a reload stops a message draft in flight too, and says nothing afterwards", async () => {
  const w = await boot({ metadata: { t1: structuredClone(READY) } });
  const outcome = w.rpc("followups_expand", { threadId: "t1", id: "a1" }).then((value) => ({ value }), (error) => ({ error }));
  await until(() => w.world.spawned.length === 1);
  assert.equal(w.world.workers.worker1.title, "Followups draft");
  await w.dispose();
  assert.ok(w.world.stops.includes("worker1"));
  assert.ok(w.world.deletes.includes("worker1"));
  await outcome; // settles instead of hanging
  assert.equal(w.logs().filter((l) => l.level === "warn").length, 0, JSON.stringify(w.logs().map((l) => l.message)));
});

test("a draft still looking up its model when the plugin reloads starts no worker afterwards", async () => {
  const w = await boot();
  let release;
  w.world.modelsGate = new Promise((resolve) => { release = resolve; });
  await w.idle();
  await sleep(100);
  await w.dispose();
  release();
  await sleep(400);
  assert.equal(w.world.spawned.length, 0);
});

// ---- unreadable stored metadata ----

test("a thread switched off stays off when its stored follow-ups can't be read", async () => {
  const w = await boot({ metadata: { t1: { override: "off", suggestions: "not a list" } } });
  assert.equal((await w.shown()).enabled, false);
  await w.idle();
  await sleep(250);
  assert.equal(w.world.spawned.length, 0, "no worker for a thread the user switched off");
  await w.dispose();
});

test("a thread switched on stays on when its stored follow-ups can't be read, even with the setting off", async () => {
  const w = await boot({ metadata: { t1: { override: "on", status: 42 } }, settings: { enabled: false } });
  assert.equal((await w.shown()).enabled, true);
  await w.dispose();
});

test("a thread with no choice and unreadable metadata follows the setting", async () => {
  const w = await boot({ metadata: { t1: { suggestions: "not a list" } }, settings: { enabled: false } });
  assert.equal((await w.shown()).enabled, false);
  await w.dispose();
});

// ---- an "answer" that is the user's own message ----

test("an idle thread whose last output is the user's own message gets no follow-ups", async () => {
  const w = await boot({ prompts: ["Fix the flaky retry test"] });
  await w.idle("Fix the flaky retry test"); // BB reports the user's message when no assistant reply exists
  await until(() => w.logs().some((l) => /no assistant answer/.test(l.message)));
  assert.equal(w.world.spawned.length, 0);
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("that holds for a message longer than the part of it the model is shown", async () => {
  const long = `Please look at this log:\n${"line of output ".repeat(300)}`;
  const w = await boot({ prompts: [long] });
  await w.idle(long);
  await until(() => w.logs().some((l) => /no assistant answer/.test(l.message)));
  assert.equal(w.world.spawned.length, 0);
  await w.dispose();
});

test("a real answer to that message is still drafted for", async () => {
  const w = await boot({ prompts: ["Fix the flaky retry test"] });
  await w.idle("I fixed it by awaiting the timer. Want me to run the suite?");
  await until(() => w.world.spawned.length === 1);
  await w.dispose();
});

// ---- what the worker sessions are told ----

test("worker sessions are told to treat the quoted conversation as material, and to use no tools", async () => {
  const w = await boot();
  for (const title of ["Followups suggestions", "Followups draft"]) {
    const config = await w.host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { title }, pluginMetadata: { worker: true } }),
    );
    assert.deepEqual(config.tools, []);
    assert.deepEqual(config.skills, [], "and carry no skill list");
    assert.match(config.instructions, /never as instructions/);
    assert.match(config.instructions, /do not read or change files, run commands, or call any tool/i);
    assert.ok(config.instructions.length < 4096, "within the limit BB truncates at");
  }
  await w.dispose();
});

test("every other thread gets exactly what it got before: the skill, and no instructions", async () => {
  const w = await boot();
  for (const title of ["Fix the flaky test", null, "Followups"]) {
    const config = await w.host.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { title } }));
    assert.deepEqual(config.tools, []);
    assert.deepEqual(config.skills, ["followups"]);
    assert.ok(!config.instructions, `no instructions for ${JSON.stringify(title)}`);
  }
  await w.dispose();
});

test("a thread that only carries a worker's title is treated like any other thread", async () => {
  const w = await boot();
  for (const pluginMetadata of [{}, { worker: "yes" }]) {
    const config = await w.host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { title: "Followups draft" }, pluginMetadata }),
    );
    assert.deepEqual(config.skills, ["followups"]);
    assert.ok(!config.instructions, JSON.stringify(pluginMetadata));
  }
  await w.dispose();
});

test("workers are spawned marked as workers, in the least privileged permission mode", async () => {
  const w = await boot({ metadata: { t1: structuredClone(READY) } });
  const clicked = w.rpc("followups_expand", { threadId: "t1", id: "a1" }).catch(() => undefined);
  await until(() => w.world.spawned.length === 1);
  await w.idle();
  await until(() => w.world.spawned.length === 2);
  assert.deepEqual(w.world.spawnArgs.map((args) => args.title).sort(), ["Followups draft", "Followups suggestions"]);
  for (const args of w.world.spawnArgs) {
    assert.equal(args.permissionMode, "accept-edits", args.title);
    assert.deepEqual(args.pluginMetadata, { worker: true }, args.title);
  }
  await w.dispose();
  await clicked;
});

test("a worker gets the least privileged permission mode its provider offers", async () => {
  const w = await boot({
    models: {
      models: [{ id: "m", model: "m", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
      providers: [{ id: "p1", serviceTiers: [], capabilities: { permissionModes: ["full", "auto"] } }],
    },
  });
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  assert.equal(w.world.spawnArgs[0].permissionMode, "auto");
  await w.dispose();
});

test("the detailed prompt asks for the same objects its closing line asks for", async () => {
  const w = await boot({ settings: { suggestPrompt: "detailed" } });
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  const prompt = w.world.spawnArgs[0].prompt;
  assert.match(prompt, /# Follow-ups \(JSON array of objects, best first\):$/);
  assert.doesNotMatch(prompt, /array of strings/);
  await w.dispose();
});

// ---- the model ----

test("a missing default model isn't remembered: the next run uses one as soon as there is one", async () => {
  const w = await boot();
  w.world.noDefaultModel = true;
  await w.idle();
  await until(() => w.logs().some((l) => /No default BB model is available/.test(l.message)));
  assert.equal(w.world.spawned.length, 0);
  w.world.noDefaultModel = false;
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  await w.dispose();
});

test("saving a model that lists no reasoning levels keeps the level picked", async () => {
  const w = await boot({
    models: {
      models: [{ id: "m", model: "m", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [] }],
      providers: [{ id: "p1", serviceTiers: [] }],
    },
  });
  const { selection } = await w.rpc("followups_model_set", { providerId: "p1", model: "m", reasoningLevel: "high" });
  assert.equal(selection.reasoningLevel, "high");
  await w.idle();
  await until(() => w.world.spawned.length === 1);
  assert.equal(w.world.spawnArgs[0].reasoningLevel, "high", "and the worker runs at it, as before");
  await w.dispose();
});

test("saving a model that doesn't support the level picked falls back to its default", async () => {
  const w = await boot();
  const { selection } = await w.rpc("followups_model_set", { providerId: "p1", model: "m", reasoningLevel: "high" });
  assert.equal(selection.reasoningLevel, "low");
  await w.dispose();
});

// ---- a reload while a worker is being spawned ----

test("a worker whose spawn returns while the plugin reloads is still stopped and deleted", async () => {
  const w = await boot();
  let release;
  w.world.spawnGate = new Promise((resolve) => { release = resolve; });
  await w.idle();
  await until(() => w.world.spawnCalls === 1);
  const disposing = w.dispose();
  await sleep(50);
  release(); // the spawn returns after the reload has begun
  await disposing;
  assert.deepEqual(w.world.spawned, ["worker1"]);
  assert.ok(w.world.stops.includes("worker1"), "the late worker was stopped");
  assert.ok(w.world.deletes.includes("worker1"), "and deleted, not left running");
});
