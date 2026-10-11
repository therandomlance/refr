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
