import assert from "node:assert/strict";
import test from "node:test";
import { batchId, readExpandedBatch, writeExpandedBatch } from "../lib/banner-collapse.ts";

const FIRST = [{ id: "a1" }, { id: "a2" }];
const SECOND = [{ id: "b1" }, { id: "b2" }];

function storageFor(t) {
  const entries = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  return entries;
}

test("new batches start collapsed, including when the old global preference says expanded", (t) => {
  const entries = storageFor(t);
  entries.set("followups:collapsed", "0");
  assert.notEqual(readExpandedBatch("thread-one"), batchId(FIRST));
});

test("the expanded batch survives a plugin module reload and a fresh RPC copy", async (t) => {
  storageFor(t);
  writeExpandedBatch("thread-one", batchId(FIRST));
  const reloaded = await import("../lib/banner-collapse.ts?reloaded");
  assert.equal(reloaded.readExpandedBatch("thread-one"), reloaded.batchId(structuredClone(FIRST)));
});

test("expanding one batch does not expand another thread or its next batch", (t) => {
  storageFor(t);
  writeExpandedBatch("thread-one", batchId(FIRST));
  assert.notEqual(readExpandedBatch("thread-two"), batchId(FIRST));
  assert.notEqual(readExpandedBatch("thread-one"), batchId(SECOND));
  writeExpandedBatch("thread-one", batchId(SECOND));
  assert.equal(readExpandedBatch("thread-one"), batchId(SECOND));
});

test("explicitly collapsing a batch clears its saved expanded state", async (t) => {
  storageFor(t);
  writeExpandedBatch("thread-one", batchId(FIRST));
  writeExpandedBatch("thread-two", batchId(SECOND));
  writeExpandedBatch("thread-one", null);
  const reloaded = await import("../lib/banner-collapse.ts?collapsed");
  assert.notEqual(reloaded.readExpandedBatch("thread-one"), reloaded.batchId(FIRST));
  assert.equal(reloaded.readExpandedBatch("thread-two"), reloaded.batchId(SECOND));
});

test("unavailable storage leaves the default collapsed and does not block toggling", (t) => {
  storageFor(t);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage unavailable"); },
  });
  assert.equal(readExpandedBatch("thread-one"), null);
  assert.doesNotThrow(() => writeExpandedBatch("thread-one", batchId(FIRST)));
  assert.doesNotThrow(() => writeExpandedBatch("thread-one", null));
});
