// What the follow-ups banner remembers per thread lives outside the component, so a
// message box that BB rebuilds (on a resize, or switching threads away and back)
// shows the same drafted tile, draft cost and composer text. A rebuilt banner is a
// new reader of the same memory: these tests act out the banner's steps against it,
// mounting and unmounting nothing. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  abandonDraft,
  composeDraft,
  composerHasOwnText,
  failDraft,
  fillDraft,
  finishDraft,
  noteState,
  readMemory,
  startDraft,
  subscribeMemory,
  takePendingDraft,
} from "../lib/banner-memory.ts";

const STATS = { ms: 5200, model: "codex/gpt-6-luna", totalTokens: 37475, outputTokens: 64 };
const READY = { status: "ready", suggestions: [{ id: "a1" }, { id: "a2" }] };
const DRAFT = "Replace the real sleeps in the retry test with fake timers.";
// Every test uses its own thread ids: the memory is one module-wide store, as it is in the app.
let threads = 0;
const thread = () => `thr_test_${(threads += 1)}`;

/** The banner's steps for picking a follow-up and getting its message back. */
function draftFor(threadId, id, result = { text: DRAFT, drafted: true, stats: STATS }) {
  const request = startDraft(threadId, id);
  return { request, finish: () => finishDraft(threadId, request, result) };
}

// ---- what survives a rebuilt banner ----

test("the drafted tile, its cost and its text outlive the banner that asked for them", () => {
  const t = thread();
  noteState(t, READY);
  const draft = draftFor(t, "a1");
  assert.equal(readMemory(t).expandingId, "a1", "the tile shows it is being written");
  // The message box is rebuilt here: the banner that picked it is gone, a new one mounts.
  noteState(t, null); // the new banner hasn't loaded its follow-ups yet
  assert.equal(draft.finish(), true, "the message still counts once it arrives");
  const memory = readMemory(t);
  assert.equal(memory.expandingId, null);
  assert.equal(memory.draftedId, "a1", "the tile keeps its check mark");
  assert.deepEqual(memory.draftStats, STATS, "and the draft's cost");
  assert.equal(memory.pendingDraft, DRAFT, "the message waits for whichever banner is showing");
});

test("a rebuilt banner that hasn't loaded yet doesn't wipe what was remembered", () => {
  const t = thread();
  noteState(t, READY);
  draftFor(t, "a1").finish();
  takePendingDraft(t);
  const writing = draftFor(t, "a2");
  noteState(t, null);
  const memory = readMemory(t);
  assert.equal(memory.expandingId, "a2", "the message being written isn't abandoned");
  assert.equal(writing.request, memory.request);
  // (The drafted tile moves to a2 when it arrives; a1's mark lasts until then.)
  assert.equal(memory.draftedId, "a1");
});

test("the message is put in the composer once, by one banner", () => {
  const t = thread();
  noteState(t, READY);
  draftFor(t, "a1").finish();
  assert.equal(takePendingDraft(t), DRAFT);
  assert.equal(takePendingDraft(t), null, "a second banner for the thread finds nothing to add");
  assert.equal(readMemory(t).pendingDraft, null);
});

test("the composer text the banner wrote is still its own after a rebuild", () => {
  const t = thread();
  const composer = fillDraft(t, { text: "", mentions: [] }, DRAFT);
  assert.equal(composer.text, DRAFT);
  // A rebuilt banner reads the same memory, so the unedited draft isn't taken for the user's text…
  assert.equal(composerHasOwnText(t, composer.text), false);
  // …and the next pick replaces it rather than adding below it.
  const next = fillDraft(t, composer, "Add a lower-bound assertion to the retry test.");
  assert.equal(next.text, "Add a lower-bound assertion to the retry test.");
});

test("each thread remembers its own", () => {
  const one = thread();
  const two = thread();
  noteState(one, READY);
  noteState(two, READY);
  draftFor(one, "a1").finish();
  fillDraft(one, { text: "", mentions: [] }, DRAFT);
  const other = readMemory(two);
  assert.equal(other.draftedId, null);
  assert.equal(other.draftStats, null);
  assert.equal(other.lastDraft, null);
  assert.equal(other.pendingDraft, null);
  assert.equal(composerHasOwnText(two, DRAFT), true, "the same text is the user's own in another thread");
});

// ---- what is still forgotten, on purpose ----

test("a new batch takes the drafted tile and its cost with it, but not the composer text", () => {
  const t = thread();
  noteState(t, READY);
  draftFor(t, "a1").finish();
  fillDraft(t, { text: "", mentions: [] }, takePendingDraft(t));
  noteState(t, { status: "working", suggestions: [] });
  const memory = readMemory(t);
  assert.equal(memory.draftedId, null);
  assert.equal(memory.draftStats, null);
  assert.equal(memory.lastDraft, DRAFT, "the composer still holds the banner's unedited text");
});

test("a message whose follow-up went away is dropped, even if it arrives later", () => {
  const t = thread();
  noteState(t, READY);
  const draft = draftFor(t, "a1");
  noteState(t, { status: "ready", suggestions: [{ id: "b1" }] }); // a new answer replaced the batch
  assert.equal(readMemory(t).expandingId, null);
  assert.equal(draft.finish(), false);
  assert.equal(readMemory(t).pendingDraft, null, "nothing goes into the composer");
  assert.equal(readMemory(t).draftedId, null);
});

test("a cancelled message is dropped when it arrives", () => {
  const t = thread();
  noteState(t, READY);
  const draft = draftFor(t, "a1");
  abandonDraft(t);
  assert.equal(draft.finish(), false);
  assert.equal(readMemory(t).pendingDraft, null);
});

test("only the newest request counts, in this thread or any other", () => {
  const t = thread();
  const other = thread();
  noteState(t, READY);
  const first = draftFor(t, "a1");
  abandonDraft(t);
  const second = draftFor(t, "a2");
  draftFor(other, "a1");
  assert.notEqual(first.request, second.request);
  assert.equal(first.finish(), false);
  assert.equal(second.finish(), true);
  assert.equal(readMemory(t).draftedId, "a2");
});

test("picking again forgets the previous draft's cost until the new one arrives", () => {
  const t = thread();
  noteState(t, READY);
  draftFor(t, "a1").finish();
  startDraft(t, "a2");
  assert.equal(readMemory(t).draftStats, null);
});

test("a short-label fallback is drafted but has no cost to show", () => {
  const t = thread();
  noteState(t, READY);
  draftFor(t, "a1", { text: "Replace sleeps with fake timers", drafted: false, stats: null }).finish();
  const memory = readMemory(t);
  assert.equal(memory.draftedId, "a1");
  assert.equal(memory.draftStats, null);
  assert.equal(memory.pendingDraft, "Replace sleeps with fake timers");
});

test("a failed message stops the writing state; a stale failure changes nothing", () => {
  const t = thread();
  noteState(t, READY);
  const first = draftFor(t, "a1");
  assert.equal(failDraft(t, first.request), true);
  assert.equal(readMemory(t).expandingId, null);
  const second = draftFor(t, "a2");
  assert.equal(failDraft(t, first.request), false);
  assert.equal(readMemory(t).expandingId, "a2", "the newer message is still being written");
  assert.equal(second.finish(), true);
});

// ---- the composer ----

test("an empty composer is replaced, mentions and all", () => {
  const { next, lastDraft } = composeDraft({ text: "  \n", mentions: [{ id: "m" }] }, DRAFT, null);
  assert.deepEqual(next, { text: DRAFT, mentions: [] });
  assert.equal(lastDraft, DRAFT);
});

test("the user's own words are kept, with the draft below them", () => {
  const mentions = [{ id: "m" }];
  const { next, lastDraft } = composeDraft({ text: "Also check the invoice job.", mentions }, DRAFT, DRAFT);
  assert.equal(next.text, `Also check the invoice job.\n\n${DRAFT}`);
  assert.equal(next.mentions, mentions);
  assert.equal(lastDraft, null, "the composer now holds the user's text");
  const after = composeDraft({ text: "Also check the invoice job.\n", mentions: [] }, DRAFT, null);
  assert.equal(after.next.text, `Also check the invoice job.\n\n${DRAFT}`, "a trailing newline gets one more, not two");
});

test("an edited draft is the user's text", () => {
  const t = thread();
  fillDraft(t, { text: "", mentions: [] }, DRAFT);
  assert.equal(composerHasOwnText(t, `${DRAFT} Keep the old test name.`), true);
  assert.equal(composerHasOwnText(t, "   "), false);
});

// ---- telling the banner ----

test("subscribers hear about changes, not about non-changes, and can stop listening", () => {
  const t = thread();
  let heard = 0;
  const stop = subscribeMemory(t, () => (heard += 1));
  noteState(t, READY); // nothing to forget yet
  assert.equal(heard, 0);
  const draft = draftFor(t, "a1");
  assert.equal(heard, 1);
  draft.finish();
  assert.equal(heard, 2);
  fillDraft(t, { text: "", mentions: [] }, DRAFT);
  assert.equal(heard, 2, "the composer change re-renders the banner; the memory stays quiet");
  stop();
  takePendingDraft(t);
  assert.equal(heard, 2);
});

test("a snapshot only changes when the memory does", () => {
  const t = thread();
  const before = readMemory(t);
  noteState(t, READY);
  assert.equal(readMemory(t), before, "the same object, so React doesn't re-render for nothing");
  startDraft(t, "a1");
  assert.notEqual(readMemory(t), before);
});
