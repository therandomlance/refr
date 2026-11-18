/** Metadata keyword names (§9.3) — surfaced in the search autocomplete.
 *  Their SQL lives in KEYWORDS (src/server/services/search.ts); keep this
 *  list and that registry's keys in sync. Unknown → literal tag.
 *  Keywords win over a same-named tag, so anything a user might plausibly use
 *  as a tag (`portrait`, `video`…) is namespaced. */
export const KEYWORD_NAMES = [
  "untagged",
  "tagged",
  "missing",
  "type:image",
  "type:video",
  "wallpaper:any",
  "wallpaper:16:9",
  "wallpaper:16:10",
  "wallpaper:21:9",
  "orient:landscape",
  "orient:portrait",
  "orient:square",
] as const;

/** Prefixes of the value-carrying keywords, offered as fill rows in the search
 *  autocomplete (picking one fills the input; the user types the value). */
export const KEYWORD_HINTS = ["w>", "h>", "tags=", "added:", "date:"] as const;

export type CompareOp = ">" | "<" | ">=" | "<=" | "=";

export type ValueKeyword =
  | { kind: "dim"; field: "width" | "height"; op: CompareOp; n: number }
  | { kind: "tags"; op: CompareOp; n: number }
  /** added within the last N days */
  | { kind: "added"; days: number }
  /** file date (mtime) within [from, to) — local calendar year / month / day */
  | { kind: "date"; from: Date; to: Date };

const UNIT_DAYS = { d: 1, w: 7, m: 30, y: 365 } as const;

/**
 * Parse a value keyword: `w>2000`, `h<=1080`, `tags=0`, `added:7d` (d/w/m/y),
 * `date:2024`, `date:2024-03`, `date:2024-03-15`. Null when `tag` isn't one, in
 * which case it's an ordinary tag. Client-safe — TagInput uses it to keep a
 * typed keyword literal instead of offering a semantic fallback.
 */
export function parseValueKeyword(tag: string): ValueKeyword | null {
  let m = /^(w|h|tags)(>=|<=|>|<|=)(\d+)$/.exec(tag);
  if (m) {
    const op = m[2] as CompareOp;
    const n = Number(m[3]);
    return m[1] === "tags" ? { kind: "tags", op, n } : { kind: "dim", field: m[1] === "w" ? "width" : "height", op, n };
  }
  m = /^added:(\d+)([dwmy])$/.exec(tag);
  if (m) return { kind: "added", days: Number(m[1]) * UNIT_DAYS[m[2] as keyof typeof UNIT_DAYS] };
  m = /^date:(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(tag);
  if (m) {
    const y = Number(m[1]);
    const mo = m[2] ? Number(m[2]) - 1 : null;
    const d = m[3] ? Number(m[3]) : null;
    if (mo !== null && (mo < 0 || mo > 11)) return null;
    if (d !== null && (d < 1 || d > 31)) return null;
    const from = new Date(y, mo ?? 0, d ?? 1);
    const to = d !== null ? new Date(y, mo!, d + 1) : mo !== null ? new Date(y, mo + 1, 1) : new Date(y + 1, 0, 1);
    return { kind: "date", from, to };
  }
  return null;
}
