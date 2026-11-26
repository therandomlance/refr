/** Client-safe substring ranking shared by tag and path autocomplete. */

/** How well `name` matches the typed `term` (both compared case-insensitively):
 *  0 exact, 1 prefix, 2 a segment/word starts with it (after `/ : - _ . ` or a
 *  space), 3 plain substring, -1 no match. An empty term is a prefix of all. */
export function matchRank(name: string, term: string): number {
  const n = name.toLowerCase();
  const t = term.toLowerCase();
  if (n === t) return 0;
  if (n.startsWith(t)) return 1;
  let i = n.indexOf(t);
  if (i < 0) return -1;
  while (i > 0) {
    if (BOUNDARY.has(n[i - 1]!)) return 2;
    i = n.indexOf(t, i + 1);
  }
  return 3;
}

const BOUNDARY = new Set(["/", ":", "-", "_", ".", " "]);

/** A match strong enough for bare Enter to take it (not a mid-word substring). */
export const isStrongMatch = (name: string, term: string) => {
  const r = matchRank(name, term);
  return r >= 0 && r <= 2;
};

/** Ranking tier for autocomplete ordering: 0 exact, 1 strong (prefix or
 *  segment start), 2 mid-word substring, -1 none. Within a tier, sort by count. */
export function matchTier(name: string, term: string): number {
  const r = matchRank(name, term);
  return r <= 0 ? r : r <= 2 ? 1 : 2;
}
