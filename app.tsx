// bb-plugin-followups — frontend entry.
//
// One composer banner, shown above a thread's message box: the follow-up
// prompts the server drafted from the thread's last finished answer.
// Clicking a follow-up asks the server to expand it into a full,
// ready-to-send draft and puts it in the composer (never sends). The draft
// never overwrites what the user has typed: it replaces an empty composer (or
// a draft this banner wrote itself) and is appended below anything else.
// Sending any message clears the banner — the server wipes the stored
// follow-ups on message.queued/dispatched, so this component simply
// disappears on the next refresh.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalProviderModelPickerValue,
  PluginSettingsSectionProps,
  PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { FollowupStats, ModelSelection, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Glyph, GLYPHS } from "@/components/glyph";
import type { GlyphName } from "@/components/glyph";
import { Icon } from "@/components/ui/icon";
import { CONTROL_HOVER_TRANSITION } from "@/components/ui/motion";

const CHANGED = "followups-changed";
/** Fade and rise in when the banner (or its ready state) first appears. */
const ENTER =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const COLLAPSED_KEY = "followups:collapsed";
/** Two balanced columns when there's room (a lone fourth tile looks orphaned in three); one when narrow. */
const GRID =
  "grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(22rem,1fr))]";

/** Whether the user folded the banner down to its header (remembered across threads). */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage unavailable: the choice just lasts until the next reload.
  }
}

const STATS_OPEN_KEY = "followups:stats-open";

function readStatsOpen(): boolean {
  try {
    return localStorage.getItem(STATS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStatsOpen(open: boolean): void {
  try {
    localStorage.setItem(STATS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage unavailable: the choice just lasts until the next reload.
  }
}

type FollowupsState = {
  status: "empty" | "working" | "ready";
  suggestions: { id: string; label: string; why?: string }[];
  stats: FollowupStats | null;
};

/** 420 -> "420ms", 4180 -> "4.2s", 47000 -> "47s", 75000 -> "1m 15s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const exact = (n: number) => n.toLocaleString("en-US");

/** One figure: an icon, then `before` text, a bold value, and `after` text. */
function Figure({
  icon,
  before,
  value,
  after,
}: {
  icon: GlyphName;
  before?: string;
  value: string;
  after?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Glyph icon={GLYPHS[icon]} className="size-3.5 shrink-0 opacity-70" />
      <span>
        {before ? `${before} ` : null}
        <b className="font-medium tabular-nums text-foreground">{value}</b>
        {after ? ` ${after}` : null}
      </span>
    </span>
  );
}

/** A run's one-line summary: how long it took and the token total. */
function StatsSummary({ label, stats }: { label: string; stats: FollowupStats }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Figure icon="time" before={label} value={formatDuration(stats.ms)} />
      {stats.totalTokens !== undefined ? (
        <Figure icon="tokens" value={exact(stats.totalTokens)} after="tokens" />
      ) : null}
    </div>
  );
}

type StatsRun = { name: string; stats: FollowupStats };

/**
 * The runs side by side: one row per figure, one column per run, so it stays
 * narrow however many runs there are. Input is ↑ (sent) and output ↓ (received).
 */
function StatsTable({ runs }: { runs: StatsRun[] }) {
  const cell = (n: number | undefined) => (n === undefined ? "—" : exact(n));
  const rows: {
    icon: GlyphName;
    label: string;
    strong?: boolean;
    value: (stats: FollowupStats) => string;
  }[] = [
    { icon: "time", label: "Generated in", strong: true, value: (s) => formatDuration(s.ms) },
    { icon: "tokens", label: "Tokens", strong: true, value: (s) => cell(s.totalTokens) },
    { icon: "input", label: "New input", value: (s) => cell(s.inputTokens) },
    { icon: "cached", label: "Cached", value: (s) => cell(s.cachedInputTokens) },
    { icon: "output", label: "Output", value: (s) => cell(s.outputTokens) },
  ];
  if (runs.some((run) => (run.stats.reasoningOutputTokens ?? 0) > 0)) {
    rows.push({ icon: "reasoning", label: "Reasoning", value: (s) => cell(s.reasoningOutputTokens) });
  }
  return (
    <table className="mt-1.5 w-full max-w-md border-collapse text-xs">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          <td />
          {runs.map((run) => (
            <th key={run.name} scope="col" className="pb-1 text-right font-normal">
              {run.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((row) => (
          <tr key={row.label} className="border-t border-border/60">
            <th scope="row" className="py-1 pr-4 text-left font-normal">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Glyph icon={GLYPHS[row.icon]} className="size-3.5 shrink-0 opacity-70" />
                {row.label}
              </span>
            </th>
            {runs.map((run) => (
              <td
                key={run.name}
                className={`py-1 pl-4 text-right ${row.strong ? "font-medium text-foreground" : ""}`}
              >
                {row.value(run.stats)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Divider, then what the run(s) cost. Closed: a summary line per run. Open
 * (Details): the model, then a table of the token split. A run is the
 * suggestions, and the draft once one has been written.
 */
function StatsFooter({
  stats,
  draftStats,
}: {
  stats: FollowupStats;
  draftStats: FollowupStats | null;
}) {
  const [open, setOpen] = useState(readStatsOpen);
  const panelId = useId();
  function toggle() {
    const next = !open;
    setOpen(next);
    writeStatsOpen(next);
  }
  const runs: StatsRun[] = [
    { name: "Suggestions", stats },
    ...(draftStats ? [{ name: "Draft", stats: draftStats }] : []),
  ];
  const models = [...new Set(runs.map((run) => run.stats.model))];
  const toggleButton = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={toggle}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-state-hover hover:text-foreground ${CONTROL_HOVER_TRANSITION} ${FOCUS_RING}`}
    >
      {open ? "Hide details" : "Details"}
      <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3.5" />
    </button>
  );
  return (
    <div className="mt-2 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
      {open ? (
        <>
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Glyph icon={GLYPHS.model} className="size-3.5 shrink-0" />
              <span className="truncate">{models.join(" · ")}</span>
            </span>
            {toggleButton}
          </div>
          <div id={panelId}>
            <StatsTable runs={runs} />
          </div>
        </>
      ) : (
        <div className="flex items-start gap-2">
          <div id={panelId} className="min-w-0 flex-1 space-y-1.5">
            <StatsSummary label="Generated in" stats={stats} />
            {draftStats ? <StatsSummary label="Draft generated in" stats={draftStats} /> : null}
          </div>
          {toggleButton}
        </div>
      )}
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The follow-ups switch for a thread, in its header: always there (the banner
 * only shows when there is something to say), so follow-ups can be turned off
 * before the first ones arrive and back on afterwards. It shows the thread's own
 * choice, or the setting's default when it has made none.
 */
function ThreadSwitch({ threadId }: PluginThreadHeaderActionProps) {
  return <ThreadSwitchButton key={threadId} threadId={threadId} />;
}

function ThreadSwitchButton({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Bumped by every refresh and every click, so an older answer never overwrites a newer state. */
  const fetchRef = useRef(0);

  const refetch = useCallback(() => {
    const request = ++fetchRef.current;
    rpc.call("followups_get", { threadId }).then(
      (next) => {
        if (request === fetchRef.current) setEnabled(next.enabled);
      },
      () => undefined,
    );
  }, [rpc, threadId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useRealtime(CHANGED, (payload: unknown) => {
    if (
      payload &&
      typeof payload === "object" &&
      "threadId" in payload &&
      (payload as { threadId: unknown }).threadId === threadId
    ) {
      refetch();
    }
  });

  if (enabled === null) return null;

  function toggle() {
    if (saving || enabled === null) return;
    const next = !enabled;
    fetchRef.current += 1; // a refresh already on its way predates this click
    setEnabled(next);
    setSaving(true);
    setFailed(false);
    rpc
      .call("followups_set_enabled", { threadId, enabled: next })
      // The change didn't stick: show what is actually saved.
      .catch(() => {
        setFailed(true);
        refetch();
      })
      .finally(() => setSaving(false));
  }

  // The name is fixed and aria-pressed carries the state, so a screen reader says
  // "Follow-ups for this thread, toggle button, pressed" and not the state twice.
  const tip = failed
    ? "Couldn't change follow-ups for this thread. Try again."
    : enabled
      ? "Follow-ups are on for this thread. Click to turn off."
      : "Follow-ups are off for this thread. Click to turn on.";
  return (
    // Button takes no `title`, so the hover tip sits on a wrapper.
    <span title={tip} className="inline-flex shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={failed ? tip : "Follow-ups for this thread"}
        aria-pressed={enabled}
        disabled={saving}
        onClick={toggle}
        className={`relative h-7 w-7 hover:text-foreground ${
          failed ? "text-destructive" : enabled ? "text-foreground/80" : "text-muted-foreground/70"
        }`}
      >
        <Glyph icon={GLYPHS.followUps} className="size-4" />
        {enabled ? null : (
          // A diagonal slash over the icon: off.
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 h-[1.5px] w-[18px] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current"
          />
        )}
      </Button>
    </span>
  );
}

function FollowupsBanner() {
  const composer = useComposer();
  const { scope } = composer;
  if (scope.kind !== "thread") return null;
  return <ThreadFollowups key={scope.threadId} threadId={scope.threadId} />;
}

function ThreadFollowups({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [state, setState] = useState<FollowupsState | null>(null);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [draftedId, setDraftedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Cost of the draft just written (the suggestions' own cost rides in `state`). */
  const [draftStats, setDraftStats] = useState<FollowupStats | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  /** Prefix for the ids that tie each tile to its reason, for screen readers. */
  const idBase = useId();
  /** The row buttons, in order, for arrow-key navigation. */
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Bumped to abandon an in-flight expansion (cancel, dismiss, new answer). */
  const requestRef = useRef(0);
  /** The text this banner last wrote into an otherwise-empty composer. */
  const lastDraftRef = useRef<string | null>(null);
  /** Bumped by every refresh: two signals close together can be answered out of order. */
  const fetchRef = useRef(0);

  const refetch = useCallback(() => {
    // A failed refresh keeps whatever is on screen; the next realtime
    // signal tries again. Only the newest refresh's answer is shown.
    const request = ++fetchRef.current;
    rpc.call("followups_get", { threadId }).then(
      (next) => {
        if (request !== fetchRef.current) return;
        setState({
          status: next.status,
          suggestions: next.suggestions,
          stats: next.stats,
        });
      },
      () => undefined,
    );
  }, [rpc, threadId]);

  useEffect(() => {
    setState(null);
    refetch();
  }, [refetch]);

  useRealtime(CHANGED, (payload: unknown) => {
    if (
      payload &&
      typeof payload === "object" &&
      "threadId" in payload &&
      (payload as { threadId: unknown }).threadId === threadId
    ) {
      refetch();
    }
  });

  // The follow-up being drafted went away (new answer, message sent,
  // dismissed): abandon the draft instead of dropping it into the composer.
  useEffect(() => {
    if (
      expandingId !== null &&
      !state?.suggestions.some((item) => item.id === expandingId)
    ) {
      requestRef.current += 1;
      setExpandingId(null);
    }
  }, [state, expandingId]);

  // Notices belong to the batch they were raised for.
  useEffect(() => {
    if (state?.status !== "ready") {
      setNotice(null);
      setDraftStats(null);
    }
  }, [state?.status]);

  // Follow-ups belong to a finished answer: nothing is shown while the agent is
  // running, whatever the server holds. (The server clears them when a thread
  // goes idle → active, but BB sends no such signal for one that is already
  // running, so this is what keeps a stray banner off a running thread.)
  const running = composer.isRunning;

  if (state === null || running) return null;

  const busy = expandingId !== null;

  if (state.status === "working") {
    // Placeholder tiles hold the space the grid will fill, so the banner
    // doesn't jump when the suggestions arrive.
    return (
      <div key="working" className={`px-2.5 pb-2.5 pt-1.5 ${ENTER}`}>
        <div className="flex min-h-7 items-center gap-1">
          <span className="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
            <Glyph icon={GLYPHS.followUps} className="size-3.5 shrink-0" />
            <span role="status">Finding follow-ups…</span>
          </span>
          <DismissButton label="Stop looking for follow-ups" onClick={dismiss} />
        </div>
        <div aria-hidden className={`mt-1 ${GRID}`}>
          {[0, 1, 2, 3].map((tile) => (
            <div
              key={tile}
              className="h-11 animate-pulse rounded-lg bg-state-hover motion-reduce:animate-none"
              style={{ animationDelay: `${tile * 120}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }
  if (state.status !== "ready" || state.suggestions.length === 0) return null;

  function dismiss() {
    requestRef.current += 1;
    setExpandingId(null);
    setNotice(null);
    rpc.call("followups_dismiss", { threadId }).then(refetch, refetch);
  }

  function cancel() {
    requestRef.current += 1;
    setExpandingId(null);
  }

  /**
   * Put `text` in the composer without losing the user's own words. The
   * updater sees the live draft, so typing during a slow expansion is safe.
   */
  function fillComposer(text: string) {
    composer.replace((current) => {
      const untouched =
        current.text.trim() === "" || current.text === lastDraftRef.current;
      if (untouched) {
        lastDraftRef.current = text;
        return { text, mentions: [] };
      }
      lastDraftRef.current = null;
      return {
        text: `${current.text}${current.text.endsWith("\n") ? "\n" : "\n\n"}${text}`,
        mentions: current.mentions,
      };
    });
    composer.focus();
  }

  function pick(id: string) {
    if (busy) return;
    const request = ++requestRef.current;
    setExpandingId(id);
    setNotice(null);
    setDraftStats(null);
    rpc.call("followups_expand", { threadId, id }).then(
      ({ text, drafted, stats }) => {
        if (request !== requestRef.current) return;
        fillComposer(text);
        setDraftedId(id);
        setExpandingId(null);
        setDraftStats(drafted ? stats : null);
        if (!drafted) {
          setNotice("Couldn't write a full message, so this is the short version.");
        }
      },
      (cause: unknown) => {
        if (request !== requestRef.current) return;
        setExpandingId(null);
        // The thread moved on while the draft was being written, so the follow-up
        // is gone: say nothing, the refresh below takes the banner away.
        if (!/no longer available/i.test(errorText(cause))) {
          setNotice("Couldn't draft that follow-up. Try again.");
        }
        refetch();
      },
    );
  }

  const suggestions = state.suggestions;
  const composerHasOwnText =
    composer.text.trim() !== "" && composer.text !== lastDraftRef.current;
  const hint = busy
    ? "Writing your message…"
    : composerHasOwnText
      ? "Picking one adds it below your draft"
      : "";

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  }

  /**
   * Keyboard for the list, while focus is inside the banner: ↑/↓ move between
   * rows, 1–9 draft that row, Esc hands focus back to the composer.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const rows = rowRefs.current
      .slice(0, suggestions.length)
      .filter((row): row is HTMLButtonElement => row !== null);
    const at = rows.findIndex((row) => row === document.activeElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (forward || backward) {
      if (rows.length === 0) return;
      event.preventDefault();
      const down = forward;
      const next =
        at === -1
          ? down ? 0 : rows.length - 1
          : (at + (down ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      composer.focus();
    } else if (/^[1-9]$/.test(event.key) && at !== -1) {
      const item = suggestions[Number(event.key) - 1];
      if (item) {
        event.preventDefault();
        pick(item.id);
      }
    }
  }

  return (
    <div
      key="ready"
      role="group"
      aria-label="Suggested follow-ups"
      onKeyDown={onKeyDown}
      className={`px-2.5 pb-2.5 pt-1.5 ${ENTER}`}
    >
      <div className="flex min-h-7 items-center gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show follow-ups" : "Hide follow-ups"}
          onClick={toggleCollapsed}
          className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-foreground/80 hover:bg-state-hover hover:text-foreground ${CONTROL_HOVER_TRANSITION} ${FOCUS_RING}`}
        >
          <Glyph icon={GLYPHS.followUps} className="size-3.5 shrink-0 text-muted-foreground" />
          <span>Follow-ups</span>
          <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] tabular-nums text-muted-foreground">
            {suggestions.length}
          </span>
          <Icon
            name={collapsed ? "ChevronUp" : "ChevronDown"}
            className="size-3.5 text-muted-foreground"
          />
        </button>
        <span
          role="status"
          className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground/70"
        >
          {hint}
        </span>
        {busy ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={cancel}
          >
            Cancel
          </Button>
        ) : null}
        <DismissButton label="Dismiss follow-ups" onClick={dismiss} />
      </div>
      {collapsed ? null : (
        <>
          <ul className={`mt-1 ${GRID}`}>
            {suggestions.map((item, index) => (
              <FollowupRow
                key={item.id}
                index={index}
                label={item.label}
                why={item.why}
                whyId={`${idBase}-why-${item.id}`}
                status={
                  expandingId === item.id
                    ? "expanding"
                    : busy
                      ? "locked"
                      : draftedId === item.id
                        ? "drafted"
                        : "idle"
                }
                onPick={() => pick(item.id)}
                rowRef={(row) => {
                  rowRefs.current[index] = row;
                }}
              />
            ))}
          </ul>
          {notice ? (
            <p role="status" className="mt-1.5 px-2 text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {state.stats ? (
            <StatsFooter stats={state.stats} draftStats={busy ? null : draftStats} />
          ) : null}
        </>
      )}
    </div>
  );
}

type RowStatus = "idle" | "expanding" | "locked" | "drafted";

/**
 * One follow-up: a bordered tile with a keycap number, its label, the reason it
 * was suggested (when the model gave one) and a trailing cue.
 */
function FollowupRow({
  index,
  label,
  why,
  whyId,
  status,
  onPick,
  rowRef,
}: {
  index: number;
  label: string;
  why?: string;
  whyId: string;
  status: RowStatus;
  onPick: () => void;
  rowRef: (row: HTMLButtonElement | null) => void;
}) {
  const expanding = status === "expanding";
  return (
    <li
      className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 [animation-fill-mode:backwards] motion-reduce:animate-none"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <button
        ref={rowRef}
        type="button"
        // Other tiles lock while one drafts; the drafting tile stays fully lit.
        disabled={status === "locked"}
        aria-busy={expanding || undefined}
        aria-label={`Draft follow-up: ${label}`}
        aria-describedby={why ? whyId : undefined}
        aria-keyshortcuts={String(index + 1)}
        onClick={expanding ? undefined : onPick}
        className={`group flex h-full w-full items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left text-sm hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50 ${CONTROL_HOVER_TRANSITION} ${FOCUS_RING} ${
          expanding ? "cursor-progress bg-state-hover" : "cursor-pointer"
        }`}
      >
        <span
          aria-hidden
          className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border text-[11px] font-medium tabular-nums text-muted-foreground"
        >
          {expanding ? (
            <Icon
              name="Spinner"
              className="size-3 animate-spin motion-reduce:animate-none"
            />
          ) : status === "drafted" ? (
            <Icon name="Check" className="size-3" />
          ) : (
            index + 1
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 leading-5">{label}</span>
          {why ? (
            <span id={whyId} className="line-clamp-2 text-xs leading-4 text-muted-foreground">
              {why}
            </span>
          ) : null}
        </span>
        <span aria-hidden className="shrink-0 text-xs leading-5 text-muted-foreground">
          {expanding ? (
            "Writing…"
          ) : status === "drafted" ? (
            "Drafted"
          ) : (
            <Icon
              name="CornerDownLeft"
              className="size-3.5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          )}
        </span>
      </button>
    </li>
  );
}

function DismissButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onClick}
      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Icon name="X" className="size-3.5" />
    </Button>
  );
}

function pickerValueFromSelection(
  selection: ModelSelection | null,
): ExperimentalProviderModelPickerValue | null {
  if (!selection) return null;
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
  };
}

function ModelSettingsSection(_props: PluginSettingsSectionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (background = false) => {
      if (!background) setLoading(true);
      rpc.call("followups_model_get", {}).then(
        (next) => {
          setSelection(next.selection);
          setConfigured(next.configured);
          setError(null);
          if (!background) setLoading(false);
        },
        (cause: unknown) => {
          setError(errorText(cause));
          if (!background) setLoading(false);
        },
      );
    },
    [rpc],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  useRealtime(CHANGED, (payload: unknown) => {
    if (
      payload &&
      typeof payload === "object" &&
      "model" in payload &&
      (payload as { model: unknown }).model === true
    ) {
      load(true);
    }
  });

  const onChange = useCallback(
    (next: ExperimentalProviderModelPickerValue) => {
      const serviceTier =
        next.serviceTier === "default" || next.serviceTier === "fast"
          ? next.serviceTier
          : undefined;
      const nextSelection: ModelSelection = {
        providerId: next.providerId,
        model: next.model,
        reasoningLevel: next.reasoningLevel,
        ...(serviceTier ? { serviceTier } : {}),
      };
      setSelection(nextSelection);
      setSaving(true);
      setError(null);
      rpc
        .call("followups_model_set", nextSelection)
        .then((result) => {
          setSelection(result.selection);
          setConfigured(true);
        })
        // The optimistic pick didn't stick; show what is actually saved.
        .catch((cause: unknown) => {
          setError(errorText(cause));
          load(true);
        })
        .finally(() => setSaving(false));
    },
    [rpc, load],
  );

  const reset = useCallback(() => {
    setSaving(true);
    setError(null);
    rpc
      .call("followups_model_clear", {})
      .then(() => load(false))
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setSaving(false));
  }, [rpc, load]);

  const pickerValue = pickerValueFromSelection(selection);

  return (
    <div className="space-y-2 text-sm">
      {loading ? (
        <p
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Icon
            name="Spinner"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
          Loading BB models…
        </p>
      ) : pickerValue ? (
        <ProviderModelPicker
          value={pickerValue}
          onChange={onChange}
          align="start"
          className="w-full"
          disabled={saving}
        />
      ) : (
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">
            BB&apos;s model catalog is unavailable.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => load(false)}
          >
            Try again
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {pickerValue ? (
        <div className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
          <span role="status">
            {saving
              ? "Saving…"
              : configured
                ? "Using your saved model."
                : "Using BB’s primary default model."}
          </span>
          {configured && !saving ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={reset}
            >
              Reset to default
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "followups",
    scopes: ["thread"],
    banners: [{ id: "followups", chrome: "card", component: FollowupsBanner }],
  });
  // BB has no way for a plugin to add to the thread's own "more" menu, so the
  // switch is a button in the header's action row.
  app.slots.experimental_threadHeaderAction({
    id: "switch",
    title: "Follow-ups",
    component: ThreadSwitch,
  });
  app.slots.settingsSection({
    id: "model",
    title: "Follow-ups model",
    description:
      "Choose the model that drafts follow-up prompts. Without a saved choice, BB's primary default is used.",
    component: ModelSettingsSection,
  });
});
