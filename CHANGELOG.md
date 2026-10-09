# Changelog

All notable changes to Followups are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Repository housekeeping: an MIT licence, a logo, design notes in
  `docs/DESIGN.md`, and `typecheck`, `build` and `dev` scripts.

### Removed

- UI packages the plugin never imports: Sonner, Vaul, `@pierre/diffs`, and the
  Radix packages other than `react-slot`, including the
  `@radix-ui/react-checkbox` runtime dependency. Also two unused helpers.

### Fixed

- A worker that hasn't started its turn yet is no longer read as having
  answered with its own prompt, which could show the prompt's format example
  ("Check the oven temperature") as a follow-up, or put the whole prompt in the
  composer as a draft.
- A worker whose spawn returns while the plugin is reloading is stopped and
  deleted, instead of running on until a later cleanup.
- The `detailed` prompt's closing line asked for "a JSON array of strings"
  while its rules asked for objects, so models often left out the reasons. It
  now asks for objects.
- When no default model was available, that was remembered for five minutes;
  now the next run uses one as soon as there is one.
- Saving a model that lists no reasoning levels keeps the level you picked, as
  running one always did.
- `bb followups regenerate` while a draft is running waits for its own run and
  reports that one, instead of returning at once with the previous run's timing.
- The banner and the header switch ignore a refresh that comes back after a
  newer one.
- The banner no longer forgets the drafted tile, the draft's cost, or that the
  composer holds its own draft when BB rebuilds the message box (on some
  resizes, or leaving a thread and coming back). Before, the check mark and
  cost line vanished, and the next pick was added below the old draft instead
  of replacing it. A message that finishes after a rebuild also lands in its own
  thread's composer.
- The follow-up tiles sit two to a row in BB's message box, as intended. Their
  22rem minimum was 4px too wide for two to fit, so they were always in one
  column; it is now 21rem.

### Security

- Workers run in the least privileged permission mode their provider offers
  (`accept-edits` where available) instead of the default. The standing
  instruction not to use tools was only guidance; this is what limits them.
- Workers are recognised by a marker seeded at spawn as well as their title, so
  a thread that only shares a worker's title keeps its skill and gets no worker
  instructions.

## 0.6.0

Everything here was added or changed after the version was last bumped to 0.5.0.

### Added

- Each suggestion says why it was suggested, in a short line under its label.
  The reason also goes into the draft, so it picks the right specifics.
- A footer under the tiles shows how long the run took and its tokens, with a
  Details table of the split (new input, cached, output, reasoning) and the model.
- A button in the thread header switches follow-ups on or off for that thread
  (also `bb followups on|off <thread-id>`). A thread's own choice beats the
  "Suggest follow-ups automatically" setting, which is now just the default.
- A "Suggestion prompt" setting: `compact` (2 or 3 follow-ups, faster) or
  `detailed` (the longer rule set). Both prompts now see the user's last three
  messages as well as the answer.
- Worker threads are deleted as soon as they finish; a sweep removes leftovers
  (`bb followups cleanup`), and "Worker threads to keep" retains a few for
  debugging.
- Workers carry a standing instruction to treat the conversation they quote as
  material, not instructions, and to use no tools, and don't get this plugin's
  skill.
- `bb followups` gained `on`, `off`, `regenerate`, `draft`, `cleanup` and `model`
  commands next to `show` and `clear`.

### Changed

- A new banner layout: a header (title, count, fold, dismiss) over a grid of
  numbered tiles, two columns when wide and one when narrow. The arrow keys move
  between tiles, 1–9 draft one, Esc returns to the composer; skeleton tiles show
  while follow-ups are being found, and the banner is hidden while the agent runs.
- Icons come straight from the Hugeicons set BB itself uses.
- Follow-ups are only drafted for a thread that has finished. A thread whose
  child threads are still working counts as still running, and is drafted for
  when the last one stops.
- A thread that went idle before replying (stopped early) gets none.
- The reply parser reads what models actually return: bare strings, objects, JSON
  written inside a string, broken or cut-off JSON, and answers cut off mid-list.
- A worker whose answer is no longer wanted (the thread went active, a message was
  sent, the banner was dismissed, follow-ups were turned off) is stopped at once,
  and the next run doesn't wait for it. The same goes for the worker writing a
  clicked follow-up's message, which is refused rather than handed to the composer.
- A worker's result is waited for through BB's idle and failed events instead of
  polling every half second.
- At most four suggestion workers run at once; a burst of finished threads queues.
- Model and provider lookups are remembered; worker cleanup is off the critical
  path. The stylesheet is 44 KB instead of 78 KB.
- Clearing writes and broadcasts only when something is showing.

### Fixed

- A reload or disable stops drafts in flight and releases their workers.
- A worker that can't be spawned no longer leaves the banner on "Finding
  follow-ups…".
- A thread switched off stays off when its stored follow-ups can't be read.
- A cancelled draft no longer flashes a "couldn't draft" notice.
- The header switch has one fixed accessible name; its state is `aria-pressed`.
