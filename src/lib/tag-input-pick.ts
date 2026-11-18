/** Pure decision logic for TagInput's Enter key (kept free of tRPC for tests). */
import { KEYWORD_GROUPS, KEYWORD_HINTS, parseValueKeyword } from "./keywords";

export function stripModifiers(raw: string): string {
  return raw.replace(/^[-~=]+/, "").trim();
}

/** Attach typed -/~/= prefixes onto the committed tag name. */
export function applyModifiers(raw: string, tag: string): string {
  const m = /^[-~=]+/.exec(raw);
  return (m?.[0] ?? "") + tag;
}

/** Rows that fill the input (more typing expected) rather than commit a chip. */
export const FILL_ROWS = ["suggest:", "path:", ...KEYWORD_HINTS, ...KEYWORD_GROUPS] as const;
export const isFillRow = (name: string) => (FILL_ROWS as readonly string[]).includes(name);

/** Keyword autocomplete rows for `typed` (modifiers already stripped). A
 *  grouped namespace (`wallpaper:`) shows as one fill row while the input is
 *  empty or still typing toward it; its members appear once it's filled.
 *  Other typing (`16:9`) matches members directly. */
export function keywordRowsFor(keywords: readonly string[], typed: string): { groups: string[]; keywords: string[] } {
  const t = typed.toLowerCase();
  const collapsed = KEYWORD_GROUPS.filter((g) => g.includes(t) && g !== t);
  return {
    groups: collapsed,
    keywords: keywords.filter((k) => k.includes(t) && !collapsed.some((g) => k.startsWith(g))),
  };
}

export type EnterAction =
  | { kind: "none" }
  | { kind: "literal"; value: string }
  | { kind: "semantic" }
  | { kind: "fill"; prefix: string }
  | { kind: "pick"; name: string };

export function resolveEnter({
  raw,
  debounced,
  open,
  rows,
  highlight,
  showSemantic,
  navigated,
}: {
  raw: string;
  /** the (debounced) term the visible rows were built from */
  debounced: string;
  open: boolean;
  rows: readonly { name: string }[];
  highlight: number;
  showSemantic: boolean;
  /** the user moved the highlight (arrows / hover) since the rows last changed */
  navigated: boolean;
}): EnterAction {
  const typed = raw.trim();
  const literal: EnterAction = typed ? { kind: "literal", value: typed } : { kind: "none" };
  // dropdown closed (Esc / outside click) → exactly what was typed
  if (!open) return literal;
  // rows still describe an older prefix → never let a stale row win
  if (stripModifiers(raw) !== debounced) return literal;
  if (!navigated) {
    // bare Enter on an empty box shouldn't fill a keyword row
    if (!typed) return { kind: "none" };
    // keep a typed wildcard / complete value keyword (w>2000, added:7d) unless a
    // row was explicitly chosen — never let the semantic fallback swallow it
    if (typed.includes("*") || parseValueKeyword(stripModifiers(typed))) return literal;
  }
  if (showSemantic && highlight === rows.length) return { kind: "semantic" };
  const pick = rows[highlight];
  if (pick && isFillRow(pick.name)) return { kind: "fill", prefix: pick.name };
  if (pick) return { kind: "pick", name: pick.name };
  return literal;
}
