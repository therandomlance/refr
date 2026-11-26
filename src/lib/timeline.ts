/** One month of the library timeline (shared by the server query and the client scrubber). */
export type TimelineBucket = {
  year: number;
  month: number; // 1-12
  count: number;
  minMtime: number; // oldest mtime in the month, ms epoch — mid-month seeking
  maxMtime: number; // newest mtime in the month, ms epoch — seek cursor source
};

/** `<alias>` or `<alias>/<sub>` → the real folder under that library's root
 *  (`aliases`: lowercased alias → resolved root). null when `p` doesn't start
 *  with a known alias; absolute paths never do. Used by `path:` chips and the
 *  timeline's excluded paths. */
export function resolveAliasedPath(p: string, aliases: Record<string, string>): string | null {
  const slash = p.indexOf("/");
  const root = aliases[(slash === -1 ? p : p.slice(0, slash)).toLowerCase()];
  if (!root) return null;
  const rest = slash === -1 ? "" : p.slice(slash + 1).replace(/\/+$/, "");
  return rest ? `${root}/${rest}` : root;
}
