import { ancestors, isUnder, normalize } from "./tag-names";

/**
 * Tag aliases and implications (Hydrus-style), stored as `data/tag-rules.json`.
 * Pure + client-safe: the server applies them in `setTags` and search, the
 * Tagging → Rules tab validates edits with the same functions.
 *
 * - alias `from → to`: typing/searching `from` (or `from/...`) means `to` (or `to/...`).
 * - implication `tag ⇒ [implied]`: adding `tag` (or any descendant) also adds
 *   `implied`, transitively.
 * - timeline-hidden `tag`: files carrying `tag` (or any descendant) stay out of
 *   the unfiltered main timeline, like a library with `timeline: false`.
 */
export type TagRules = {
  aliases: Record<string, string>;
  implications: Record<string, string[]>;
  timelineHidden: string[];
};

export const EMPTY_RULES: TagRules = { aliases: {}, implications: {}, timelineHidden: [] };

/** Rewrite `name` through the alias whose source is the longest prefix of it. One hop. */
export function resolveAlias(rules: TagRules, name: string): string {
  const n = normalize(name);
  let best: string | null = null;
  for (const from of Object.keys(rules.aliases)) {
    if (isUnder(n, from) && (best === null || from.length > best.length)) best = from;
  }
  return best === null ? n : rules.aliases[best] + n.slice(best.length);
}

/** Direct implications of a tag: those of itself and of each of its ancestors. */
function directImplied(rules: TagRules, name: string): string[] {
  return ancestors(name).flatMap((a) => rules.implications[a] ?? []);
}

/** Every tag implied (transitively) by `names`, excluding `names` themselves. */
export function expandImplications(rules: TagRules, names: string[]): string[] {
  const start = new Set(names.map(normalize));
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    for (const next of directImplied(rules, stack.pop()!)) {
      if (seen.has(next) || start.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return [...seen];
}

/** Normalize names, drop empty/self/duplicate entries. Never throws. */
export function sanitizeRules(rules: Omit<TagRules, "timelineHidden"> & { timelineHidden?: string[] }): TagRules {
  const aliases: Record<string, string> = {};
  for (const [f, t] of Object.entries(rules.aliases)) {
    const from = normalize(f);
    const to = normalize(t);
    if (from && to && from !== to) aliases[from] = to;
  }
  const implications: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(rules.implications)) {
    const key = normalize(k);
    if (!key) continue;
    const list = [...new Set([...(implications[key] ?? []), ...vs.map(normalize)])]
      .filter((v) => v && v !== key)
      .sort();
    if (list.length) implications[key] = list;
  }
  const hidden = new Set((rules.timelineHidden ?? []).map(normalize).filter(Boolean));
  // a tag beneath another hidden tag is already covered
  const timelineHidden = [...hidden].filter((t) => ![...hidden].some((h) => h !== t && isUnder(t, h))).sort();
  return { aliases, implications, timelineHidden };
}

/** Problems that make a rule set ambiguous or loop. Empty = valid. Expects sanitized rules. */
export function validateRules(rules: TagRules): string[] {
  const errors: string[] = [];
  for (const [from, to] of Object.entries(rules.aliases)) {
    if (isUnder(to, from)) errors.push(`Alias "${from}" can't point inside itself ("${to}").`);
    else if (resolveAlias(rules, to) !== to) errors.push(`Alias "${from}" points to "${to}", which is itself an alias. Point it at the final tag.`);
  }
  for (const [tag, implied] of Object.entries(rules.implications)) {
    if (resolveAlias(rules, tag) !== tag) errors.push(`"${tag}" is an alias; put its implications on "${resolveAlias(rules, tag)}".`);
    for (const t of implied) {
      if (isUnder(tag, t)) errors.push(`"${tag}" already implies its parent "${t}" through the hierarchy.`);
      else if (isUnder(t, tag)) errors.push(`"${tag}" can't imply its own child "${t}".`);
      else if (resolveAlias(rules, t) !== t) errors.push(`"${tag}" implies "${t}", which is an alias. Use "${resolveAlias(rules, t)}".`);
    }
    if (reachesUnder(rules, implied, tag)) errors.push(`Implications starting at "${tag}" loop back to it.`);
  }
  for (const tag of rules.timelineHidden) {
    if (resolveAlias(rules, tag) !== tag) errors.push(`"${tag}" is an alias; hide "${resolveAlias(rules, tag)}" from the timeline instead.`);
  }
  return [...new Set(errors)];
}

/** Following implications from `start` arrives back at `root` or beneath it. */
function reachesUnder(rules: TagRules, start: string[], root: string): boolean {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const n = stack.pop()!;
    if (isUnder(n, root)) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...directImplied(rules, n));
  }
  return false;
}

/** Rewrite every tag reference (alias targets, implication keys and values, timeline-hidden tags).
 *  `map` returns the new name, or the input unchanged. Alias *sources* are
 *  typed shorthands, not tags, so they're left alone. */
export function rewriteRuleTags(rules: TagRules, map: (name: string) => string): TagRules {
  const aliases = Object.fromEntries(Object.entries(rules.aliases).map(([f, t]) => [f, map(t)]));
  const implications: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(rules.implications)) {
    const key = map(k);
    implications[key] = [...(implications[key] ?? []), ...vs.map(map)];
  }
  return sanitizeRules({ aliases, implications, timelineHidden: rules.timelineHidden.map(map) });
}
