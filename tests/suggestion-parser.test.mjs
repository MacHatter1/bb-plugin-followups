// Run with `npm test`. Node 22.18+ (24 here) runs the TypeScript source directly:
// no build, no extra packages. The plugin SDK's fake host stands in for BB.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { parseSuggestionOutput, parseSuggestions } from "../server.ts";
import { modelStubs } from "./helpers.mjs";

// Raw worker outputs from the prompt A/B (Haiku 5.5, the "compact" prompt, runs 1
// and 8), exactly as BB returned them: a JSON array whose items are STRINGS that
// contain JSON objects, so the plugin used to show `{"label": …` as the label.
const RUN_1 = String.raw`["{\"label\": \"Show the saved model in plugin storage\", \"why\": \"Confirms the picked model persisted via followups_model_get RPC or storage file\"}", "{\"label\": \"Run a suggestion and read plugin logs\", \"why\": \"Verifies the worker used the new model and logged no fallback warning\"}", "{\"label\": \"Clear the setting and recheck the default\", \"why\": \"Confirms unset reverts to BB primary default codex/gpt-6.1-sol\"}"]`;
const RUN_8 = String.raw`["{\"label\": \"Run the suggestion-to-banner check\", \"why\": \"Full suggestion path on the new code has not run yet this turn\"}", "{\"label\": \"Show the followups plugin log\", \"why\": \"Log shows whether the worker used the picked model or fell back\"}", "{\"label\": \"Clear the model setting back to default\", \"why\": \"Reverting confirms the default returns with no errors in the log\"}"]`;

const EXPECTED_RUN_1 = [
  { label: "Show the saved model in plugin storage", why: "Confirms the picked model persisted via followups_model_get RPC or storage file" },
  { label: "Run a suggestion and read plugin logs", why: "Verifies the worker used the new model and logged no fallback warning" },
  { label: "Clear the setting and recheck the default", why: "Confirms unset reverts to BB primary default codex/gpt-6.1-sol" },
];
const EXPECTED_RUN_8 = [
  { label: "Run the suggestion-to-banner check", why: "Full suggestion path on the new code has not run yet this turn" },
  { label: "Show the followups plugin log", why: "Log shows whether the worker used the picked model or fell back" },
  { label: "Clear the model setting back to default", why: "Reverting confirms the default returns with no errors in the log" },
];

test("the fixtures are what they claim: a JSON array of three strings, each holding a JSON object", () => {
  for (const raw of [RUN_1, RUN_8]) {
    const list = JSON.parse(raw);
    assert.equal(list.length, 3);
    for (const item of list) {
      assert.equal(typeof item, "string");
      assert.ok(item.startsWith("{"));
      assert.equal(typeof JSON.parse(item).label, "string");
    }
  }
});

test("run 1: three clean suggestions, each with its reason", () => {
  assert.deepEqual(parseSuggestions(RUN_1), EXPECTED_RUN_1);
});

test("run 8: three clean suggestions, each with its reason", () => {
  assert.deepEqual(parseSuggestions(RUN_8), EXPECTED_RUN_8);
});

test("no label or reason carries JSON text through", () => {
  for (const raw of [RUN_1, RUN_8]) {
    for (const { label, why } of parseSuggestions(raw)) {
      for (const text of [label, why]) {
        assert.ok(text && !/[{}\\]|"label"|"why"/.test(text), `leaked JSON into: ${text}`);
      }
    }
  }
});

// The same outputs, through the whole plugin: worker output -> stored -> what the banner reads.
async function suggestionsShownFor(workerOutput) {
  let meta = {};
  const host = createFakePluginHost({
    pluginId: "followups",
    sdk: {
      threads: {
        getPluginMetadata: async () => meta,
        updatePluginMetadata: async ({ set }) => { meta = { ...meta, ...set }; return {}; },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", environmentId: "e", projectId: "p", visibility: "visible" }),
        output: async ({ threadId }) => ({ output: threadId === "worker" ? workerOutput : "An answer." }),
        spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}), delete: async () => ({ ok: true }),
        events: { list: async () => [] }, promptHistory: async () => [], list: async () => [{ id: "parent" }],
      },
      ...modelStubs(),
    },
  });
  await plugin(host.bb);
  await host.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "t" }), lastAssistantText: "I changed the footer." });
  for (let i = 0; i < 100 && meta.status !== "ready" && meta.status !== "empty"; i++) await new Promise((r) => setTimeout(r, 40));
  const got = await host.harness.callRpc("followups_get", { threadId: "t" });
  const logs = host.harness.logEntries.map((entry) => ({ level: entry.level, message: entry.message }));
  await host.harness.dispose();
  return { ...got, logs };
}

test("end to end: run 1 and run 8 each reach the banner as three clean suggestions", async () => {
  for (const [raw, expected] of [[RUN_1, EXPECTED_RUN_1], [RUN_8, EXPECTED_RUN_8]]) {
    const got = await suggestionsShownFor(raw);
    assert.equal(got.status, "ready");
    assert.deepEqual(got.suggestions.map(({ label, why }) => ({ label, why })), expected);
    assert.ok(got.suggestions.every((s) => typeof s.id === "string" && s.id.length > 0));
  }
});

// Everything else the parser accepted before must still come out the same.
test("plain objects and plain strings are unchanged", () => {
  assert.deepEqual(parseSuggestions('[{"label":"Add a test","why":"The fix shipped untested"},{"label":"Fix lint"}]'), [
    { label: "Add a test", why: "The fix shipped untested" },
    { label: "Fix lint" },
  ]);
  assert.deepEqual(parseSuggestions('["Add a test", "Fix lint"]'), [{ label: "Add a test" }, { label: "Fix lint" }]);
});

test("a mix of objects, JSON-in-a-string and plain strings", () => {
  const mixed = JSON.stringify([{ label: "A real object", why: "Fact one" }, JSON.stringify({ label: "In a string", why: "Fact two" }), "Plain label"]);
  assert.deepEqual(parseSuggestions(mixed), [
    { label: "A real object", why: "Fact one" },
    { label: "In a string", why: "Fact two" },
    { label: "Plain label" },
  ]);
});

test("the other spellings of the reason still work inside a string", () => {
  const out = parseSuggestions(JSON.stringify([JSON.stringify({ label: "One", reason: "From reason" }), JSON.stringify({ label: "Two", rationale: "From rationale" })]));
  assert.deepEqual(out, [{ label: "One", why: "From reason" }, { label: "Two", why: "From rationale" }]);
});

test("a decoded suggestion gets the same tidying as any other", () => {
  const long = "word ".repeat(40).trim();
  const out = parseSuggestions(JSON.stringify([JSON.stringify({ label: `"${long}."`, why: `Because ${"reason ".repeat(40)}` })]));
  assert.equal(out.length, 1);
  assert.ok(out[0].label.endsWith("…") && out[0].label.length <= 64, out[0].label);
  assert.ok(out[0].why.endsWith("…") && out[0].why.length <= 140 && !/^because/i.test(out[0].why), out[0].why);
});

test("the same suggestion written two ways counts once", () => {
  const out = parseSuggestions(JSON.stringify([{ label: "Add a test", why: "first" }, JSON.stringify({ label: "add a test", why: "second" })]));
  assert.deepEqual(out, [{ label: "Add a test", why: "first" }]);
});

test("a label that merely starts with a brace stays a label; cut-off JSON is cleaned up", () => {
  assert.deepEqual(parseSuggestions('["{curly} braces in a label", "{\\"label\\": \\"cut off", "{not json at all"]'), [
    { label: "{curly} braces in a label" },
    { label: "cut off" }, // was the raw text `{"label": "cut off` before cut-off JSON was handled
    { label: "{not json at all" },
  ]);
});

test("a JSON object in a string with no usable label is dropped, not shown as raw JSON", () => {
  const out = parseSuggestions(JSON.stringify([JSON.stringify({ title: "no label key" }), JSON.stringify({ label: 42 }), "Kept"]));
  assert.deepEqual(out, [{ label: "Kept" }]);
});

test("a string holding a JSON array or number is a plain label, not decoded", () => {
  assert.deepEqual(parseSuggestions(JSON.stringify(["[1, 2, 3]", "42"])), [{ label: "[1, 2, 3]" }, { label: "42" }]);
});

// ---- truncated and malformed object strings ----------------------------------------------------
// A model that writes each suggestion as JSON inside a string can also get the JSON wrong or be cut
// off mid-way. The banner must show the label as plain text where one can be pulled out, and never
// raw JSON; where none can, the item is dropped rather than shown as braces.
const one = (text) => parseSuggestions(JSON.stringify([text]));
const RAW_JSON = /[{}\\]|"label"|"why"|'label'|\blabel\s*:/;

const REPAIRED = [
  ["cut off mid-label", '{"label": "Show the saved model', [{ label: "Show the saved model" }]],
  ["cut off right after the label's closing quote", '{"label": "Show the saved model"', [{ label: "Show the saved model" }]],
  ["cut off after the comma", '{"label": "Show the saved model",', [{ label: "Show the saved model" }]],
  ["cut off inside the next key", '{"label": "Show the saved model", "wh', [{ label: "Show the saved model" }]],
  ["cut off mid-reason: the label stays, the half-sentence reason does not", '{"label": "Run the check", "why": "Full suggestion path on the new c', [{ label: "Run the check" }]],
  ["cut off right after the reason: both kept", '{"label": "Run the check", "why": "Full suggestion path ran"', [{ label: "Run the check", why: "Full suggestion path ran" }]],
  ["missing closing brace: both kept", '{"label": "Run the check", "why": "It has not run yet"', [{ label: "Run the check", why: "It has not run yet" }]],
  ["trailing text after the object", '{"label": "Run the check", "why": "It has not run yet"} and then some', [{ label: "Run the check", why: "It has not run yet" }]],
  ["single quotes (Python style)", "{'label': 'Run the check', 'why': 'It has not run yet'}", [{ label: "Run the check", why: "It has not run yet" }]],
  ["unquoted keys (JavaScript style)", '{label: "Run the check", why: "It has not run yet"}', [{ label: "Run the check", why: "It has not run yet" }]],
  ["unescaped quotes inside the label", '{"label": "Say "hello" to users", "why": "It has not run yet"}', [{ label: 'Say "hello" to users', why: "It has not run yet" }]],
  ["escapes are decoded", '{"label": "Fix the \\"cache\\" \\u00e9rror", "why": "Log shows it\\nfailed"', [{ label: 'Fix the "cache" érror', why: "Log shows it failed" }]],
  ["the reason under another name", '{"label": "Run the check", "reason": "It has not run yet"', [{ label: "Run the check", why: "It has not run yet" }]],
];
for (const [name, text, expected] of REPAIRED) {
  test(`malformed object string, ${name}`, () => {
    assert.deepEqual(one(text), expected);
    for (const { label, why } of one(text)) {
      for (const shown of [label, why]) assert.ok(!shown || !RAW_JSON.test(shown), `raw JSON shown: ${shown}`);
    }
  });
}

const UNUSABLE = ["{", "{ ", '{"', '{"lab', '{"label', '{"label"', '{"label":', '{"label": ', '{"label": "', '{"label": ""', '{"label": "Sh', '{"title": "no label key', '{"title": "x"}', "{foo: 1"];
test("an object string with no usable label is dropped, never shown as raw JSON", () => {
  for (const text of UNUSABLE) assert.deepEqual(one(text), [], `showed something for: ${text}`);
  assert.deepEqual(parseSuggestions(JSON.stringify([...UNUSABLE, "Kept"])), [{ label: "Kept" }]);
});

test("a cut-off label shorter than four characters is dropped, not shown as a fragment", () => {
  assert.deepEqual(one('{"label": "Sh'), []);
  assert.deepEqual(one('{"label": "Show'), [{ label: "Show" }]);
});

test("a stray brace in the middle of a plain label is untouched", () => {
  assert.deepEqual(one("Use {braces} in the template"), [{ label: "Use {braces} in the template" }]);
});

// Every way the real run 1 and run 8 objects could have been cut off.
test("cut at every possible length, the real run 1 and run 8 objects never show raw JSON", () => {
  let checked = 0;
  for (const raw of [RUN_1, RUN_8]) {
    for (const full of JSON.parse(raw)) {
      const { label: trueLabel, why: trueWhy } = JSON.parse(full);
      const labelEnd = full.indexOf(trueLabel) + trueLabel.length + 1; // just past the label's closing quote
      for (let length = 1; length < full.length; length++) {
        const cut = full.slice(0, length);
        const shown = parseSuggestions(JSON.stringify([cut]));
        checked++;
        assert.ok(shown.length <= 1, `more than one suggestion from: ${cut}`);
        if (shown.length === 0) continue;
        const { label, why } = shown[0];
        assert.ok(!RAW_JSON.test(label), `raw JSON in the label for: ${cut}`);
        assert.ok(trueLabel.startsWith(label), `label "${label}" is not part of "${trueLabel}" (cut: ${cut})`);
        assert.ok(label.length >= 4, `fragment label "${label}"`);
        if (length >= labelEnd) assert.equal(label, trueLabel, `label should be complete once its closing quote is there (cut: ${cut})`);
        else assert.ok(length < labelEnd);
        if (why !== undefined) {
          assert.ok(!RAW_JSON.test(why), `raw JSON in the reason for: ${cut}`);
          assert.equal(why, trueWhy, `a partial reason was shown for: ${cut}`);
        }
      }
      // and the complete object, minus only its closing brace, keeps both parts
      assert.deepEqual(parseSuggestions(JSON.stringify([full.slice(0, -1)])), [{ label: trueLabel, why: trueWhy }]);
    }
  }
  assert.ok(checked > 400, `only ${checked} cut points were checked`);
});

test("end to end: run 8 with two of its objects cut off still reaches the banner as clean text", async () => {
  const [first, second, third] = JSON.parse(RUN_8);
  const { label: firstLabel } = JSON.parse(first);
  const cutFirst = first.slice(0, first.indexOf(firstLabel) + firstLabel.length + 1 + 30); // label + `, "why": "Full su…`
  const cutThird = third.slice(0, 30); // `{"label": "Clear the model set`
  const got = await suggestionsShownFor(JSON.stringify([cutFirst, second, cutThird]));
  assert.equal(got.status, "ready");
  assert.deepEqual(got.suggestions.map(({ label, why }) => ({ label, why })), [
    { label: "Run the suggestion-to-banner check", why: undefined },
    EXPECTED_RUN_8[1],
    { label: "Clear the model set", why: undefined },
  ]);
  for (const { label, why } of got.suggestions) {
    for (const shown of [label, why]) assert.ok(!shown || !RAW_JSON.test(shown), `raw JSON shown: ${shown}`);
  }
});

// ---- an answer cut off before its closing bracket ------------------------------------------------
// When a worker's answer ends early there is no closing `]`. Every item that arrived whole before the
// cut is kept; the one the cut landed in is not (half an item reads as broken).
const RUN_1_ITEMS = JSON.parse(RUN_1);
const RUN_8_ITEMS = JSON.parse(RUN_8);
const literal = (item) => JSON.stringify(item);
const head = (items, complete) => "[" + items.slice(0, complete).map(literal).join(", "); // no closing bracket

test("the fixtures are laid out the way these helpers rebuild them", () => {
  for (const [raw, items] of [[RUN_1, RUN_1_ITEMS], [RUN_8, RUN_8_ITEMS]]) {
    assert.equal(raw, "[" + items.map(literal).join(", ") + "]");
  }
});

for (const [name, raw, items, expected] of [["run 8", RUN_8, RUN_8_ITEMS, EXPECTED_RUN_8], ["run 1", RUN_1, RUN_1_ITEMS, EXPECTED_RUN_1]]) {
  test(`${name}: cut between items, the complete ones are shown`, () => {
    for (const cut of [head(items, 2), head(items, 2) + ",", head(items, 2) + ", ", head(items, 2) + ",\n  "]) {
      assert.deepEqual(parseSuggestions(cut), expected.slice(0, 2), JSON.stringify(cut.slice(-24)));
    }
    assert.deepEqual(parseSuggestions(head(items, 1)), expected.slice(0, 1));
    assert.deepEqual(parseSuggestions(head(items, 3)), expected, "all three arrived, only the closing bracket is missing");
  });

  test(`${name}: cut mid-item, the complete ones are shown and the partial one is not`, () => {
    const third = literal(items[2]);
    for (const length of [1, 2, 5, 14, 30, 60, third.length - 1]) {
      const cut = head(items, 2) + ", " + third.slice(0, length);
      assert.deepEqual(parseSuggestions(cut), expected.slice(0, 2), `cut ${length} characters into the third item`);
    }
    // once the third item's closing quote is there it is complete, and the cut is between items
    assert.deepEqual(parseSuggestions(head(items, 2) + ", " + third), expected);
  });

  test(`${name}: cut inside the first item, nothing is complete yet`, () => {
    assert.deepEqual(parseSuggestions("[" + literal(items[0]).slice(0, 25)), []);
    assert.deepEqual(parseSuggestions("["), []);
    assert.deepEqual(parseSuggestions("[ "), []);
  });
}

test("cut at every possible length, each real array yields exactly the items that were complete by then", () => {
  let checked = 0;
  for (const [raw, items, expected] of [[RUN_1, RUN_1_ITEMS, EXPECTED_RUN_1], [RUN_8, RUN_8_ITEMS, EXPECTED_RUN_8]]) {
    const itemEnds = [];
    let position = 1; // just past the opening bracket
    for (const item of items) {
      position += literal(item).length;
      itemEnds.push(position);
      position += 2; // ", "
    }
    for (let length = 1; length < raw.length; length++) {
      const complete = itemEnds.filter((end) => end <= length).length;
      const shown = parseSuggestions(raw.slice(0, length));
      checked++;
      assert.deepEqual(shown, expected.slice(0, complete), `cut at ${length} of ${raw.length}: ${raw.slice(Math.max(0, length - 20), length)}`);
      for (const { label, why } of shown) assert.ok(!RAW_JSON.test(label) && !RAW_JSON.test(why));
    }
  }
  assert.equal(checked, RUN_1.length - 1 + (RUN_8.length - 1), "every cut point of both arrays was checked");
});

test("the parser says when an answer was cut off, and only then", () => {
  assert.equal(parseSuggestionOutput(RUN_8).cutOff, false);
  assert.equal(parseSuggestionOutput(head(RUN_8_ITEMS, 2)).cutOff, true);
  assert.equal(parseSuggestionOutput(head(RUN_8_ITEMS, 2) + ", " + literal(RUN_8_ITEMS[2]).slice(0, 20)).cutOff, true);
  assert.equal(parseSuggestionOutput("[]").cutOff, false);
  assert.equal(parseSuggestionOutput("no brackets at all").cutOff, false);
  assert.equal(parseSuggestionOutput(head(RUN_8_ITEMS, 2)).suggestions.length, 2);
});

test("a cut-off array of plain objects, with braces and brackets inside the text, is read correctly", () => {
  const cut = '[{"label": "Use } and ] in a label", "why": "See [1] and {a}"}, {"label": "Second one", "why": "Second reason"}, {"label": "Third wa';
  assert.deepEqual(parseSuggestions(cut), [
    { label: "Use } and ] in a label", why: "See [1] and {a}" },
    { label: "Second one", why: "Second reason" },
  ]);
});

test("a cut-off item whose text holds a closing bracket doesn't lose the earlier items", () => {
  const first = JSON.stringify(JSON.stringify({ label: "Fix the [x] case", why: "See [1]" }));
  const cut = "[" + first + ', "{\\"label\\": \\"Next [one] thi';
  assert.deepEqual(parseSuggestions(cut), [{ label: "Fix the [x] case", why: "See [1]" }]);
});

test("cut-off plain strings and a cut-off mix are salvaged too", () => {
  assert.deepEqual(parseSuggestions('["First label", "Second label", "Third la'), [{ label: "First label" }, { label: "Second label" }]);
  assert.deepEqual(parseSuggestions('[{"label": "Real object", "why": "Fact"}, "{\\"label\\": \\"In a string\\", \\"why\\": \\"Fact two\\"}", "Plain la'), [
    { label: "Real object", why: "Fact" },
    { label: "In a string", why: "Fact two" },
  ]);
});

test("text around the array doesn't matter when it is cut off", () => {
  assert.deepEqual(parseSuggestions('Here you go:\n```json\n["First label", "Second label", "Thi'), [{ label: "First label" }, { label: "Second label" }]);
});

test("a complete array followed by text that contains a bracket is read, not lost", () => {
  assert.deepEqual(parseSuggestions('["First label", "Second label"] (see [1] for details)'), [{ label: "First label" }, { label: "Second label" }]);
  assert.equal(parseSuggestionOutput('["First label", "Second label"] (see [1])').cutOff, false);
});

test("a malformed array is still nothing, not a pile of fragments", () => {
  assert.deepEqual(parseSuggestions('["Say "hi" now", "Second label"]'), []);
  assert.deepEqual(parseSuggestions('["First label", Second, "Third label"'), []);
  assert.deepEqual(parseSuggestions("Sure, I'd suggest adding more tests."), []);
  assert.deepEqual(parseSuggestions("[]"), []);
});

test("end to end: run 8 cut off mid-item reaches the banner with its two complete suggestions and a warning", async () => {
  const cut = head(RUN_8_ITEMS, 2) + ", " + literal(RUN_8_ITEMS[2]).slice(0, 30);
  const got = await suggestionsShownFor(cut);
  assert.equal(got.status, "ready");
  assert.deepEqual(got.suggestions.map(({ label, why }) => ({ label, why })), EXPECTED_RUN_8.slice(0, 2));
  assert.ok(
    got.logs.some((entry) => entry.level === "warn" && /cut off; kept its 2 complete suggestion/.test(entry.message)),
    JSON.stringify(got.logs.map((entry) => entry.message)),
  );
});

test("end to end: run 1 cut between items reaches the banner with its complete suggestions", async () => {
  const got = await suggestionsShownFor(head(RUN_1_ITEMS, 2));
  assert.equal(got.status, "ready");
  assert.deepEqual(got.suggestions.map(({ label, why }) => ({ label, why })), EXPECTED_RUN_1.slice(0, 2));
});

test("end to end: cut off before any item is complete, the run ends as no suggestions", async () => {
  const got = await suggestionsShownFor("[" + literal(RUN_8_ITEMS[0]).slice(0, 25));
  assert.equal(got.status, "empty");
  assert.deepEqual(got.suggestions, []);
  assert.ok(got.logs.some((entry) => entry.level === "warn" && /cut off; none was complete/.test(entry.message)), JSON.stringify(got.logs.map((entry) => entry.message)));
});

test("end to end: a complete answer logs no cut-off warning", async () => {
  const got = await suggestionsShownFor(RUN_8);
  assert.equal(got.suggestions.length, 3);
  assert.ok(!got.logs.some((entry) => /cut off/.test(entry.message)));
});
