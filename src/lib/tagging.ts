/** Short label for a hierarchical tag: the last two segments. */
export function tagLabel(name: string) {
  const parts = name.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : name;
}

/** Tag badges for a thumbnail. `context` = the tag being browsed: it and its
 *  ancestors are dropped (every file there has them), and its descendants are
 *  shown relative to it ("reference/figure/arms" in reference/figure → "arms"). */
export function tileTagBadges(names: string[], context?: string | null): { label: string; full: string }[] {
  const out: { label: string; full: string }[] = [];
  for (const full of names) {
    if (context && (full === context || context.startsWith(full + "/"))) continue;
    const label = context && full.startsWith(context + "/") ? full.slice(context.length + 1) : tagLabel(full);
    out.push({ label, full });
  }
  return out;
}
