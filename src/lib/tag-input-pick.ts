/** Pure decision logic for TagInput's Enter key (kept free of tRPC for tests). */
import { KEYWORD_GROUPS, KEYWORD_HINTS, parseValueKeyword } from "./keywords";
import { isStrongMatch } from "./match";

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

/** Completion-mode prefixes whose rows carry the same prefix as the input. */
const MODE_PREFIXES = ["path:", "suggest:"];

/** Whether a row is a good enough match for `typed` that bare Enter may take
 *  it: exact, prefix, or a segment/word start — never a mid-word substring
 *  (typing a new tag `red` must not pick `tired`). Alias rows also match by alias. */
export function rowMatches(row: { name: string; alias?: string }, typed: string): boolean {
  const mode = MODE_PREFIXES.find((p) => typed.toLowerCase().startsWith(p) && row.name.toLowerCase().startsWith(p));
  const [name, term] = mode ? [row.name.slice(mode.length), typed.slice(mode.length)] : [row.name, typed];
  return isStrongMatch(name, term) || (row.alias !== undefined && isStrongMatch(row.alias, typed));
}

/** Initial highlight once rows describe `typed`: the exact row, else the first
 *  strong match, else the semantic fallback (when it's the only row), else none
 *  (-1 → Enter commits the typed text). While results are still loading nothing
 *  is highlighted, so a keyword row can't be picked before tag rows arrive. */
export function defaultHighlight({
  rows,
  typed,
  pending,
  showSemantic,
}: {
  rows: readonly { name: string; alias?: string }[];
  typed: string;
  pending: boolean;
  showSemantic: boolean;
}): number {
  if (pending) return -1;
  const exact = rows.findIndex((r) => r.name.toLowerCase() === typed.toLowerCase());
  if (exact >= 0) return exact;
  const strong = rows.findIndex((r) => rowMatches(r, typed));
  if (strong >= 0) return strong;
  return rows.length === 0 && showSemantic ? 0 : -1;
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
  pending = false,
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
  /** server results for the current term haven't arrived yet */
  pending?: boolean;
}): EnterAction {
  const typed = raw.trim();
  const literal: EnterAction = typed ? { kind: "literal", value: typed } : { kind: "none" };
  // dropdown closed (Esc / outside click) → exactly what was typed
  if (!open) return literal;
  // rows still describe an older prefix → never let a stale row win
  if (stripModifiers(raw) !== debounced) return literal;
  // tag/path rows not back yet → the visible rows are incomplete (keywords only)
  if (pending && !navigated) return literal;
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
