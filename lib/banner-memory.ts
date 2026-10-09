// What the follow-ups banner remembers about each thread, kept outside the
// component. BB rebuilds the message box (when the window is resized past a
// breakpoint, say, or the thread is switched away from and back to), and a
// rebuilt banner is a new component: anything it kept in its own state, such as
// which tile was drafted, what the draft cost, or which composer text it wrote
// itself, would be forgotten. Kept here, per thread, it outlives every mount for
// as long as the app is open.
//
// Plain functions over a module-level map, with a subscription the banner reads
// through `useSyncExternalStore`, so the logic is testable without React.

import type { FollowupStats } from "../server";

export type BannerMemory = {
  /** The follow-up whose message is being written, if any. */
  readonly expandingId: string | null;
  /** The follow-up whose message was written last: its tile keeps the check mark. */
  readonly draftedId: string | null;
  /** What writing that message cost; null when it fell back to the short label. */
  readonly draftStats: FollowupStats | null;
  /** The text the banner last wrote into an otherwise-empty composer, which it may replace. */
  readonly lastDraft: string | null;
  /** A written message not yet put in the composer: the next banner for the thread does that. */
  readonly pendingDraft: string | null;
  /** The message request that is current; a result for any other one is dropped. */
  readonly request: number;
};

/** The parts of the banner's fetched state that decide what is still remembered. */
export type BannerState = {
  status: "empty" | "working" | "ready";
  suggestions: readonly { id: string }[];
};

export type ComposerValue<Mention> = { text: string; mentions: readonly Mention[] };

const EMPTY: BannerMemory = Object.freeze({
  expandingId: null,
  draftedId: null,
  draftStats: null,
  lastDraft: null,
  pendingDraft: null,
  request: 0,
});

const memories = new Map<string, BannerMemory>();
const listeners = new Map<string, Set<() => void>>();
/** Request numbers are unique across threads and never reused, so a late result can't pass for a current one. */
let lastRequest = 0;

export function readMemory(threadId: string): BannerMemory {
  return memories.get(threadId) ?? EMPTY;
}

/** Call `listener` whenever the thread's memory changes. Returns the unsubscribe. */
export function subscribeMemory(threadId: string, listener: () => void): () => void {
  const set = listeners.get(threadId) ?? new Set<() => void>();
  listeners.set(threadId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(threadId) === set) listeners.delete(threadId);
  };
}

/**
 * Change the thread's memory. Subscribers hear about it unless nothing changed,
 * or `quiet` is set (for a change that rides along with a composer change, which
 * re-renders the banner anyway, made from inside the composer's updater).
 */
function update(threadId: string, patch: Partial<BannerMemory>, quiet = false): void {
  const current = readMemory(threadId);
  const changed = (Object.keys(patch) as (keyof BannerMemory)[]).some((key) => patch[key] !== current[key]);
  if (!changed) return;
  memories.set(threadId, { ...current, ...patch });
  if (quiet) return;
  for (const listener of [...(listeners.get(threadId) ?? [])]) listener();
}

/** The user picked a follow-up: its message is being written. Returns the request to finish it with. */
export function startDraft(threadId: string, id: string): number {
  lastRequest += 1;
  update(threadId, { expandingId: id, draftStats: null, request: lastRequest });
  return lastRequest;
}

/**
 * The message for `request` arrived. If it is still current, its tile is marked
 * drafted, its cost kept, and the text left for the banner to put in the
 * composer; returns whether it was current.
 */
export function finishDraft(
  threadId: string,
  request: number,
  result: { text: string; drafted: boolean; stats: FollowupStats | null },
): boolean {
  const memory = readMemory(threadId);
  if (request !== memory.request || memory.expandingId === null) return false;
  update(threadId, {
    expandingId: null,
    draftedId: memory.expandingId,
    draftStats: result.drafted ? result.stats : null,
    pendingDraft: result.text,
  });
  return true;
}

/** The message for `request` couldn't be written. Returns whether it was current. */
export function failDraft(threadId: string, request: number): boolean {
  if (request !== readMemory(threadId).request) return false;
  update(threadId, { expandingId: null });
  return true;
}

/** Stop waiting for the message being written (cancelled, dismissed): its result will be dropped. */
export function abandonDraft(threadId: string): void {
  lastRequest += 1;
  update(threadId, { expandingId: null, request: lastRequest });
}

/** Take the written message waiting for the composer, once: null if there is none (or another banner took it). */
export function takePendingDraft(threadId: string): string | null {
  const text = readMemory(threadId).pendingDraft;
  if (text !== null) update(threadId, { pendingDraft: null });
  return text;
}

/**
 * The banner fetched the thread's follow-ups. Null (a banner that hasn't loaded
 * yet, as every rebuilt one starts) changes nothing. A batch that has gone takes
 * its drafted tile and draft cost with it; a follow-up that has gone takes the
 * message being written for it. The composer text is the composer's, so it stays.
 */
export function noteState(threadId: string, state: BannerState | null): void {
  if (state === null) return;
  const memory = readMemory(threadId);
  if (state.status !== "ready") update(threadId, { draftedId: null, draftStats: null });
  if (memory.expandingId !== null && !state.suggestions.some((item) => item.id === memory.expandingId)) {
    abandonDraft(threadId);
  }
}

/**
 * The composer's next value when `text` is put in it, and what to remember as
 * the banner's own text. An empty composer, or one still holding the banner's
 * own unedited text, is replaced; anything the user wrote gets `text` below it.
 */
export function composeDraft<Mention>(
  current: ComposerValue<Mention>,
  text: string,
  lastDraft: string | null,
): { next: ComposerValue<Mention>; lastDraft: string | null } {
  if (current.text.trim() === "" || current.text === lastDraft) {
    return { next: { text, mentions: [] }, lastDraft: text };
  }
  return {
    next: { text: `${current.text}${current.text.endsWith("\n") ? "\n" : "\n\n"}${text}`, mentions: current.mentions },
    lastDraft: null,
  };
}

/** Put `text` in the thread's composer value, remembering it as the banner's own when it replaced the value. */
export function fillDraft<Mention>(threadId: string, current: ComposerValue<Mention>, text: string): ComposerValue<Mention> {
  const { next, lastDraft } = composeDraft(current, text, readMemory(threadId).lastDraft);
  update(threadId, { lastDraft }, true);
  return next;
}

/** Whether the composer holds text the user wrote (not empty, and not the banner's own unedited text). */
export function composerHasOwnText(threadId: string, composerText: string): boolean {
  return composerText.trim() !== "" && composerText !== readMemory(threadId).lastDraft;
}
