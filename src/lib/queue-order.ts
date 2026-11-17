/** Move selected items one slot without changing their relative order. */
export function moveQueueItems(ids: string[], selected: ReadonlySet<string>, direction: -1 | 1): string[] {
  const next = [...ids];
  for (let i = direction === -1 ? 1 : next.length - 2; direction === -1 ? i < next.length : i >= 0; i -= direction) {
    const neighbor = i + direction;
    if (selected.has(next[i]!) && !selected.has(next[neighbor]!)) {
      [next[i], next[neighbor]] = [next[neighbor]!, next[i]!];
    }
  }
  return next;
}

/** Move `src` so it lands immediately before (or after) `target`. Returns
 *  the input unchanged when either id is missing or nothing would move. */
export function moveQueueItemTo(ids: string[], src: string, target: string, after: boolean): string[] {
  if (src === target || !ids.includes(src) || !ids.includes(target)) return ids;
  const rest = ids.filter((id) => id !== src);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), src, ...rest.slice(at)];
  return next.every((id, i) => id === ids[i]) ? ids : next;
}
