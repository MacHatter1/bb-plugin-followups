---
name: followups
description: Inspect or clear the Followups plugin's suggested follow-up prompts with the `bb followups` CLI. Use when the user asks what follow-ups were suggested for a thread, or wants them cleared.
---

# Follow-ups

The Followups plugin drafts short follow-up prompts when a visible thread
finishes, and shows them as clickable buttons in a banner above that thread's
composer. Clicking one expands it into a full draft in the composer — the
plugin fills the draft, it never sends. Sending any message clears the banner.

Agents never need to write follow-ups by hand: the banner belongs to the user.
These commands are for inspection and debugging only.

## Commands

| Command | Effect |
| --- | --- |
| `bb followups show <thread-id>` | Show the stored follow-ups for a thread, plus how long they took and how many tokens (cached and output) the drafting model used. |
| `bb followups clear <thread-id>` | Clear the stored follow-ups for a thread. |
| `bb followups on <thread-id>` / `off <thread-id>` | Turn follow-ups on or off for one thread (the user's button in the thread header does the same). Only on the user's request; `on` drafts right away for a finished thread, which spawns a worker. |
| `bb followups model` | Show which model drafts follow-ups (saved pick or BB default). |
| `bb followups cleanup --dry-run` | List the leftover hidden worker threads the plugin would delete. Workers are deleted automatically; run it without `--dry-run` only when the user asks. |

`bb followups regenerate` and `bb followups draft` each spawn a real model worker, so run them only when the user asks (for example to time the pipeline). `regenerate` only works on a thread that has finished, which includes having no child threads still running (a parent that is waiting on its children gets its follow-ups once they are done).

The drafting model is the user's choice under Settings → Follow-ups model.
Never change it on your own; point the user there if they ask.

Add `--json` to any command when the output drives code.
