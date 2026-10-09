import { createElement } from "react";
import {
  AiBrain01Icon,
  AiChipIcon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  Clock01Icon,
  Coins01Icon,
  DatabaseRestoreIcon,
  MessageSquareReplyIcon,
} from "@hugeicons/core-free-icons";

/**
 * Icons rendered straight from `@hugeicons/core-free-icons`, the set BB's own
 * icons come from. BB's `Icon` only knows the small subset BB registered, and
 * a name outside it silently renders as a ⚡ (Zap) — "Sparkles", "Coins" and
 * "Cpu" are some it lacks — so anything beyond that subset is drawn here. The
 * bundler keeps only the icons imported above. BB's `Icon` is still used for
 * the everyday controls (✕, ✓, chevrons, spinner) so they match the rest of BB.
 */
type GlyphData = readonly (readonly [string, { readonly [attribute: string]: string | number }])[];

export function Glyph({ icon, className }: { icon: GlyphData; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {icon.map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
    </svg>
  );
}

/** What each glyph stands for in this plugin. */
export const GLYPHS = {
  followUps: MessageSquareReplyIcon,
  time: Clock01Icon,
  tokens: Coins01Icon,
  /** Sent to the model (↑). */
  input: ArrowUp02Icon,
  cached: DatabaseRestoreIcon,
  /** Received from the model (↓). */
  output: ArrowDown02Icon,
  reasoning: AiBrain01Icon,
  model: AiChipIcon,
} as const;

export type GlyphName = keyof typeof GLYPHS;
