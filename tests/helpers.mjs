// Shared by the test files that run the plugin on the SDK's fake host (not a test itself:
// `npm test` only picks up *.test.mjs).
import assert from "node:assert/strict";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `condition` every 10ms until it is true; fail the test if it still isn't after `ms`. */
export async function until(condition, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await condition()) return;
    await sleep(10);
  }
  assert.fail("timed out waiting for: " + condition);
}

/**
 * The fake host's answers about models and providers: one default model on one provider.
 * `gate`, when given, is awaited before the provider catalog answers, so a test can hold the
 * model lookup open (it returns a promise, or null for no wait).
 */
export function modelStubs(gate = () => null) {
  return {
    system: {
      executionOptions: async () => ({
        models: [{ model: "m", isDefault: true, routeProviderId: "p1", defaultReasoningEffort: "low" }],
        providers: [{ id: "p1", available: true }],
      }),
    },
    providers: {
      models: async () => {
        await gate();
        return {
          models: [{ id: "m", model: "m", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
          providers: [{ id: "p1", serviceTiers: [] }],
        };
      },
    },
  };
}
