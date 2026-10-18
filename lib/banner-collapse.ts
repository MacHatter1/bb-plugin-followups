// Remember an expanded batch per thread across component and plugin reloads.
// Suggestion ids are stable for a stored batch and change when new ones are generated.
// The old global fold preference is deliberately ignored: new batches start folded.
const KEY_PREFIX = "followups:expanded-batch:";

export function batchId(suggestions: readonly { id: string }[]): string {
  return JSON.stringify(suggestions.map((item) => item.id));
}

export function readExpandedBatch(threadId: string): string | null {
  try {
    return localStorage.getItem(`${KEY_PREFIX}${threadId}`);
  } catch {
    return null;
  }
}

export function writeExpandedBatch(threadId: string, batch: string | null): void {
  try {
    const key = `${KEY_PREFIX}${threadId}`;
    if (batch === null) localStorage.removeItem(key);
    else localStorage.setItem(key, batch);
  } catch {
    // Storage unavailable: the component still keeps the choice until it unmounts.
  }
}
