# Compare follow-up prompt changes

Use this eval before changing or releasing the worker prompts. The default
runner is Codex with `gpt-6-luna` and low reasoning. Use the same model and
settings on both sides of a comparison.

## Check the plugin first

Run the focused tests from the plugin checkout:

```sh
npm run test:worker-prompts
```

These tests check the delivered instructions and the plugin's text-returning
workflow. They use the SDK fake host. Use a live eval to observe model output
and tool attempts.

## Prepare the comparison without model calls

Choose a baseline commit and keep your candidate changes in the working tree:

```sh
npm run eval:followups -- --baseline HEAD
```

Check the generated manifest before starting a live run. Confirm the baseline
commit, candidate source hashes, model, reasoning level, cases, and call count.
The preparation step captures each revision's actual worker prompt and its
session instructions. It does not switch branches or replace your source files.

For a later comparison, pass the commit from before the prompt change:

```sh
npm run eval:followups -- --baseline HEAD~1
```

## Check the live runner

Sign in to the installed Codex CLI before using `--live`. Run one pair first:

```sh
npm run eval:followups -- --baseline HEAD --live --case compact-offer --repeats 1
```

Treat this as a smoke check. One pair does not establish a quality or speed
improvement. Inspect failures and missing telemetry before running more samples.

## Run the repeated comparison

Run the fixed corpus with five repetitions per case and revision:

```sh
npm run eval:followups -- --baseline HEAD --live --repeats 5
```

Keep the machine's workload stable during the run. Samples run sequentially,
with the order alternating between baseline first and candidate first. Use
`--case` to repeat one failing case. Use `--out` to choose an artifact directory.

Use `--model` and `--reasoning` to make a separate model comparison. Preserve the
default settings when measuring a prompt change. The initial runner supports
Codex. It rejects other providers rather than substituting a model.

## Review the evidence

Open `report.md`, `results.json`, and `manifest.json` in the output directory.
The default directory is under the ignored `.local/followups-runs/` path.
Keep the raw event traces with the report so another reviewer can inspect them.

Check these results before accepting a prompt change:

- Compare response format, suggestion limits, grounding terms, duplicate
  labels, expansion constraints, and claims of completed work.
- Inspect every observed tool attempt, including failed calls. Treat unknown
  action-bearing events as incomplete telemetry. An unobserved metric is not zero.
- Read the paired outputs for relevance, specificity, distinct suggestions,
  preserved constraints, language, and invented details. The automated text
  checks are proxies for quality and do not replace this review.
- Compare latency medians, ranges, individual samples, and paired differences.
  Keep failures and timeouts in the evidence. Treat small differences within
  run-to-run variation as inconclusive.
- Compare reported token usage. Keep unavailable token categories separate
  from reported zero usage.

Treat a nonzero exit code as a failed check. The command fails for runner
errors and for candidate responses with failed automated checks, observed tool
attempts, or incomplete tool telemetry. Baseline quality failures remain in
the report so you can compare them with the candidate.

Interpret wall time as native Codex process latency, including startup. The
runner replays the plugin-controlled prompt and session instruction in a fresh
scratch directory. It does not reproduce BB's full instructions, integrations,
or environment startup. Keep that distinction in any performance claim.

The runner uses a read-only sandbox, disables apps and native delegation, rejects
approval escalation, and ignores user configuration and rules.
Treat these as limits on the experiment, not proof that tools are unavailable.
Native built-in instructions and automatically discovered skills can still
affect a session. A tool-free result applies to the recorded cases and settings.

Run `npm run eval:followups -- --help` for the supported options. Preparation
does not call a model. Live runs consume the selected Codex account's usage.

For the native event format and authentication behavior, see the official
[Codex non-interactive mode documentation](https://developers.openai.com/codex/noninteractive/).
